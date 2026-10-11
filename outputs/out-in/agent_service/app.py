"""Local single-owner FastAPI runtime; not a multi-tenant production perimeter."""
from __future__ import annotations
import asyncio
import csv
import hashlib
import os
import re
import secrets
import shutil
import zipfile
from contextlib import asynccontextmanager
from decimal import Decimal
from pathlib import Path
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile, WebSocket, WebSocketDisconnect, Depends
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from agent_service.store import Store, TERMINAL
from agent_service.orchestrator import ROOT, UnderwritingEngine, hash_file
from tools.reconciliation_tool import EvidenceError, money, dec, read_statement
from agent_service.myinvois_client import MyInvoisConfig, MyInvoisClient, enabled as myinvois_enabled, parse_document_ids

WORKSPACE = Path(os.environ.get("OUT_IN_WORKSPACE", ROOT / "workspace")).resolve()
MODE = os.environ.get("OUT_IN_MODE", "demo")
if MODE not in ("demo", "live"):
    raise RuntimeError("OUT_IN_MODE must be demo or live (live refers to SDK/models, not real funds)")
KEY = os.environ.get("OUT_IN_API_KEY", "")
if MODE == "live" and len(KEY) < 32:
    raise RuntimeError("SDK mode requires a strong OUT_IN_API_KEY (minimum 32 characters)")
ORIGINS = set(os.environ.get("OUT_IN_ALLOWED_ORIGINS", "http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:8000,http://localhost:8000").split(","))
store = Store(WORKSPACE)
myinvois = None
if myinvois_enabled():
    if MODE != "live" or len(KEY) < 32:
        raise RuntimeError("MyInvois requires live mode and a strong operator API key")
    myinvois = MyInvoisClient(MyInvoisConfig.from_env())
engine = UnderwritingEngine(store, myinvois_client=myinvois)
tasks = set()


@asynccontextmanager
async def lifespan(app):
    store.recover()
    yield
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


app = FastAPI(title="OUT&IN Demo Underwriting", lifespan=lifespan)


async def auth(x_api_key: str | None = Header(default=None)):
    if KEY and not secrets.compare_digest(x_api_key or "", KEY):
        raise HTTPException(401, "Operator API key required")


def job_path(jid):
    if not re.fullmatch(r"[0-9a-f]{32}", jid):
        raise HTTPException(404, "Unknown job")
    try:
        job = store.get(jid)
    except KeyError:
        raise HTTPException(404, "Unknown job")
    return WORKSPACE / "jobs" / jid, job


@app.get("/api/v2/config")
async def config():
    return {"mode": MODE, "api_key_required": bool(KEY), "settlement": "simulated_only", "is_demo": True,
            "myinvois": {"enabled": myinvois is not None, "environment": os.environ.get("OUT_IN_MYINVOIS_ENVIRONMENT", "sandbox") if myinvois else None,
                         "profile": "MYR invoice 01 v1.0/1.1; supplemental commercial/delivery PDFs required"}}


@app.get("/api/v2/health")
async def health():
    return {"status": "ok", "mode": MODE, "real_funds": False}


def inspect_upload(path):
    prefix = path.read_bytes()[:8]
    if path.suffix == ".pdf" and not prefix.startswith(b"%PDF-"):
        raise HTTPException(422, "Invalid PDF signature")
    if path.suffix == ".xlsx":
        if not prefix.startswith(b"PK"):
            raise HTTPException(422, "Invalid XLSX signature")
        try:
            with zipfile.ZipFile(path) as book:
                members = book.infolist()
                if len(members) > 2000 or sum(m.file_size for m in members) > 100 * 1024 * 1024:
                    raise HTTPException(413, "XLSX decompression budget exceeded")
                if any(m.file_size / max(m.compress_size,1) > 1000 for m in members):
                    raise HTTPException(413, "XLSX compression ratio exceeds limit")
                if any("vbaproject" in m.filename.lower() or "externallinks/" in m.filename.lower() for m in members):
                    raise HTTPException(422, "Macros and external workbook links are forbidden")
                if "[Content_Types].xml" not in book.namelist():
                    raise HTTPException(422, "Invalid XLSX structure")
        except zipfile.BadZipFile:
            raise HTTPException(422, "Invalid XLSX archive")
    if path.suffix == ".csv":
        try:
            text = path.read_text(encoding="utf-8-sig")
            if "\x00" in text:
                raise ValueError()
        except (UnicodeError, ValueError):
            raise HTTPException(422, "CSV must be UTF-8 text")


@app.post("/api/v2/underwrite/batch", status_code=202, dependencies=[Depends(auth)])
async def ingest(files: list[UploadFile] = File(...), requested_limit: str = Form("40000.00"),
                 duration_months: int = Form(12), annual_rate: str = Form("0.08"),
                 monthly_debt_service: str = Form("1000.00"), myinvois_document_ids: str = Form("")):
    try:
        document_ids = parse_document_ids(myinvois_document_ids)
    except EvidenceError as exc:
        raise HTTPException(422, str(exc))
    if document_ids and myinvois is None:
        raise HTTPException(409, "MyInvois retrieval is not enabled on this backend")
    if len(tasks) >= 8:
        raise HTTPException(429, "Runtime queue full; retry later")
    if not 2 <= len(files) <= 20:
        raise HTTPException(422, "Upload 2..20 invoice/delivery/statement files")
    try:
        requested = money(requested_limit)
        debt = money(monthly_debt_service)
        rate = dec(annual_rate)
        if not 0 < requested <= 1000000000 or not 0 <= debt <= 1000000000 or not 0 <= rate <= 1 or not 1 <= duration_months <= 120:
            raise EvidenceError("Loan terms out of bounds")
    except EvidenceError as exc:
        raise HTTPException(422, str(exc))
    directory = WORKSPACE / "incoming" / secrets.token_hex(16)
    directory.mkdir(parents=True)
    sources, total, used = [], 0, set()
    try:
        for file in files:
            raw = file.filename or ""
            # No filesystem separators, control characters or disguised extensions.
            if not raw or raw != Path(raw).name or any(c in raw for c in "/\\\x00"):
                raise HTTPException(422, "Unsafe filename")
            extension = Path(raw).suffix.lower()
            if extension not in (".pdf", ".xlsx", ".csv"):
                raise HTTPException(422, "Only PDF, XLSX and CSV supported")
            stem = re.sub(r"[^A-Za-z0-9_-]", "_", Path(raw).stem)[:80] or "document"
            name = stem + extension
            if name.casefold() in used:
                raise HTTPException(422, "Duplicate normalized filename")
            used.add(name.casefold())
            path, size = directory / name, 0
            with path.open("xb") as output:
                while chunk := await file.read(1024 * 1024):
                    size += len(chunk)
                    total += len(chunk)
                    if size > 20*1024*1024 or total > 50*1024*1024:
                        raise HTTPException(413, "20MiB/file and 50MiB/dossier limits")
                    output.write(chunk)
            await file.close()
            if size == 0:
                raise HTTPException(422, "Empty file")
            await asyncio.to_thread(inspect_upload, path)
            sources.append({"name": name, "sha256": hash_file(path)})
        if not any(s["name"].endswith(".pdf") for s in sources) or sum(s["name"].endswith((".csv", ".xlsx")) for s in sources) != 1:
            raise HTTPException(422, "Include PDFs and exactly one bank statement")
        terms = {"requested_limit": str(requested), "duration_months": duration_months,
                 "annual_rate": str(rate), "monthly_debt_service": str(debt)}
        if document_ids:
            terms["myinvois_document_ids"] = document_ids
        return schedule_job(directory, terms, sources)
    except HTTPException:
        # Retain rejected payloads in isolated incoming directory. No unsafe deletes.
        raise


def schedule_job(directory, terms, sources):
    jid, token = store.create(MODE, terms, sources)
    target = WORKSPACE / "jobs" / jid
    target.mkdir(parents=True)
    os.rename(directory, target / "inputs")
    task = asyncio.create_task(engine.run(jid))
    tasks.add(task)
    task.add_done_callback(tasks.discard)
    return {"job_id": jid, "stream_token": token, "state": "QUEUED"}


DEMO_RUN_FILES = ("invoice.pdf", "packing_list.pdf", "statement.xlsx")
DEMO_RUN_TERMS = {"requested_limit": "40000.00", "duration_months": 12,
                  "annual_rate": "0.08", "monthly_debt_service": "1000.00"}


@app.post("/api/v2/demo-run", status_code=202, dependencies=[Depends(auth)])
async def demo_run(scenario: str = Form("approval")):
    """Stage a synthetic scenario through the normal scheduler and engine.
    Demo mode only; settlement remains simulated."""
    if MODE != "demo":
        raise HTTPException(409, "Synthetic one-action runs require demo mode")
    if scenario not in ("approval", "risk_review", "parity_mismatch"):
        raise HTTPException(422, "Unsupported demo scenario")
    if len(tasks) >= 8:
        raise HTTPException(429, "Runtime queue full; retry later")
    fixtures = [ROOT / "demo" / "dossier" / name for name in DEMO_RUN_FILES]
    if any(not path.is_file() or path.is_symlink() for path in fixtures):
        raise HTTPException(404, "Run python scripts/prepare_demo.py first")
    terms = dict(DEMO_RUN_TERMS)
    if scenario == "risk_review":
        terms["monthly_debt_service"] = "50000.00"
    if scenario == "parity_mismatch":
        try:
            rows = await asyncio.to_thread(read_statement, str(fixtures[2]))
            receipt = next((row for row in rows if row["invoice_id"] and money(row["inflow"]) > 0), None)
            if (receipt is None or receipt["invoice_id"] != "DEMO-INV-001"
                    or money(receipt["inflow"]) != Decimal("100000.00")):
                raise EvidenceError("Canonical demo receipt DEMO-INV-001 with inflow 100000.00 required")
            receipt["inflow"] = str(money(receipt["inflow"]) - Decimal("0.01"))
        except EvidenceError as exc:
            raise HTTPException(409, str(exc))
    directory = WORKSPACE / "incoming" / secrets.token_hex(16)
    directory.mkdir(parents=True)
    sources = []
    for fixture in fixtures:
        if scenario == "parity_mismatch" and fixture.suffix == ".xlsx":
            target = directory / "statement.csv"
            with target.open("x", encoding="utf-8", newline="") as output:
                writer = csv.DictWriter(output, fieldnames=("transaction_id", "invoice_id", "currency", "inflow", "outflow", "date"),
                                        extrasaction="ignore")
                writer.writeheader()
                writer.writerows(rows)
        else:
            target = directory / fixture.name
            shutil.copyfile(fixture, target)
        await asyncio.to_thread(inspect_upload, target)
        sources.append({"name": target.name, "sha256": hash_file(target)})
    accepted = schedule_job(directory, terms, sources)
    store.update(accepted["job_id"], demo_scenario=scenario)
    return accepted


@app.get("/api/v2/jobs/{jid}", dependencies=[Depends(auth)])
async def get_job(jid: str):
    _, job = job_path(jid)
    return {k: v for k, v in job.items() if k not in ("sources", "terms")}


@app.get("/api/v2/review-queue", dependencies=[Depends(auth)])
async def review():
    return {"jobs": store.list({"REVIEW_REQUIRED"})}


@app.get("/api/v2/jobs/{jid}/artifacts/{name}", dependencies=[Depends(auth)])
async def artifact(jid: str, name: str):
    directory, job = job_path(jid)
    if name not in {a["name"] for a in job.get("artifacts", [])} or name != Path(name).name:
        raise HTTPException(404, "Artifact not published")
    folder = "quarantine" if name == "variance_report.json" else "artifacts"
    if folder == "artifacts" and job["state"] != "COMPLETED":
        raise HTTPException(409, "Bundle not committed")
    path = directory / folder / name
    if not path.is_file() or path.is_symlink():
        raise HTTPException(404, "Artifact unavailable")
    return FileResponse(path, filename=name, headers={"Cache-Control": "no-store"})


@app.get("/api/v2/jobs/{jid}/myinvois-sources/{name}", dependencies=[Depends(auth)])
async def myinvois_source(jid: str, name: str):
    directory, job = job_path(jid)
    declared = next((s for s in job.get("myinvois_sources", []) if s["name"] == "evidence/" + name), None)
    if declared is None or not re.fullmatch(r"myinvois-(response|provenance)-[0-9]+\.json", name):
        raise HTTPException(404, "MyInvois source not published")
    path = directory / "evidence" / name
    if path.is_symlink() or not path.is_file() or hash_file(path) != declared["sha256"]:
        raise HTTPException(409, "MyInvois source integrity check failed")
    return FileResponse(path, filename=name, headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


@app.get("/api/v2/demo-dossier")
async def demo_dossier():
    path = ROOT / "demo/dossier.zip"
    if not path.is_file():
        raise HTTPException(404, "Run python scripts/prepare_demo.py first")
    return FileResponse(path, filename="OUT_IN_DEMO_DOSSIER.zip")


@app.websocket("/api/v2/agent-stream")
async def stream(websocket: WebSocket):
    jid = websocket.query_params.get("job_id", "")
    token = websocket.query_params.get("token", "")
    origin = websocket.headers.get("origin")
    if origin and origin not in ORIGINS:
        await websocket.close(code=1008)
        return
    try:
        job_path(jid)
        after = max(0, int(websocket.query_params.get("after", "0")))
    except (HTTPException, ValueError):
        await websocket.close(code=1008)
        return
    if not store.token_ok(jid, token):
        await websocket.close(code=1008)
        return
    await websocket.accept()
    delivered_terminal = False
    try:
        while True:
            events = store.events(jid, after)
            for event in events:
                await websocket.send_json(event)
                after = event["seq"]
                if event["type"] == "STATE_TRANSITION" and event["payload"].get("state") in TERMINAL:
                    delivered_terminal = True
            if store.get(jid)["state"] in TERMINAL and len(events) < 500:
                # State update and terminal event are separate commits. Require
                # delivery (or prior cursor acknowledgement) of the actual event.
                acknowledged = delivered_terminal
                if not acknowledged:
                    prior, cursor = [], 0
                    while True:
                        page = store.events(jid, cursor)
                        if not page:
                            break
                        prior.extend(page)
                        cursor = page[-1]["seq"]
                        if len(page) < 500:
                            break
                    acknowledged = any(e["seq"] <= after and e["type"] == "STATE_TRANSITION" and e["payload"].get("state") in TERMINAL for e in prior)
                if acknowledged and not store.events(jid, after, limit=1):
                    break
            # DB-backed replay: bounded async polling interval, not blocking shell sleep.
            await asyncio.sleep(0.3)
    except WebSocketDisconnect:
        pass
    finally:
        try:
            await websocket.close()
        except RuntimeError:
            pass


# Build output is optional during development. API routes remain first.
if (ROOT / "frontend/dist").is_dir():
    class SPAFiles(StaticFiles):
        async def get_response(self, path, scope):
            try:
                return await super().get_response(path, scope)
            except StarletteHTTPException as exc:
                # StaticFiles normalizes separators to backslashes on Windows.
                route = path.replace("\\", "/").lstrip("/")
                if exc.status_code == 404 and route != "api" and not route.startswith("api/"):
                    return await super().get_response("index.html", scope)
                raise
    app.mount("/", SPAFiles(directory=ROOT / "frontend/dist", html=True), name="frontend")
