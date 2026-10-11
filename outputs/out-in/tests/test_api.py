"""Offline integration tests: generated SYNTHETIC dossiers/models, NO REAL FUNDS.

Only TestClient's in-process ASGI transport is used. OCR/PDF extraction and
reslicing, exact reconciliation, sklearn inference, rendering and signing are
real. Runtime modules/files are never patched; only environment and outbound
socket access are isolated. TestClient's Windows event-loop socketpair is the
sole permitted socket connection. Every stream has a deadline/event budget.
"""

import csv
import hashlib
import importlib.util
import io
import json
import secrets
import socket
import sys
import threading
import time
from collections import Counter
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlencode

import anyio
import pytest
from fastapi.testclient import TestClient
from openpyxl import load_workbook
from starlette.websockets import WebSocketDisconnect

from scripts.verify_manifest import VerificationError, verify_manifest
from tools.reconciliation_tool import money, read_statement


ROOT = Path(__file__).resolve().parents[1]
BATCH = "/api/v2/underwrite/batch"
ORIGIN = "http://127.0.0.1:5173"
TERMINAL = {"COMPLETED", "REVIEW_REQUIRED", "QUARANTINED", "FAILED"}
STREAM_SECONDS = 240
TEST_EVIDENCE = {"synthetic_only": True, "real_funds": False, "external_network": False}


@pytest.fixture(scope="module")
def api(tmp_path_factory):
    workspace = tmp_path_factory.mktemp("out-in-synthetic-api") / "workspace"
    operator_key = secrets.token_urlsafe(48)
    manifest = json.loads((ROOT / "demo/models/model_manifest.json").read_text(encoding="utf-8"))
    assert manifest["is_demo"] is True
    assert "synthetic" in manifest["training_data"].lower()
    originals = {name: (ROOT / "demo/dossier" / name).read_bytes()
                 for name in ("invoice.pdf", "packing_list.pdf", "statement.xlsx")}
    socketpair = socket.socketpair
    connect = socket.socket.connect
    connect_ex = socket.socket.connect_ex
    local = threading.local()

    def control_socketpair(*args, **kwargs):
        previous = getattr(local, "control_pair", False)
        local.control_pair = True
        try:
            return socketpair(*args, **kwargs)
        finally:
            local.control_pair = previous

    def offline_connect(sock, address):
        if not getattr(local, "control_pair", False):
            raise AssertionError("Synthetic integration tests forbid outbound network connections")
        return connect(sock, address)

    def offline_connect_ex(sock, address):
        if not getattr(local, "control_pair", False):
            raise AssertionError("Synthetic integration tests forbid outbound network connections")
        return connect_ex(sock, address)

    with pytest.MonkeyPatch.context() as patch:
        patch.setenv("OUT_IN_WORKSPACE", str(workspace))
        patch.setenv("OUT_IN_API_KEY", operator_key)
        patch.setenv("OUT_IN_MODE", "demo")
        patch.delenv("OUT_IN_MYINVOIS_ENABLED", raising=False)
        patch.setenv("OUT_IN_REPO_ROOT", str(ROOT))
        patch.setenv("OUT_IN_ALLOWED_ORIGINS", ORIGIN)
        patch.delenv("OUT_IN_OCR_ADAPTER", raising=False)
        patch.delenv("OUT_IN_OCR_ADAPTER_SHA256", raising=False)
        patch.setattr(socket, "socketpair", control_socketpair)
        patch.setattr(socket.socket, "connect", offline_connect)
        patch.setattr(socket.socket, "connect_ex", offline_connect_ex)
        # Fresh file import before lifespan; never import a cached global app
        # and redirect its already-created Store into a different workspace.
        name = "_out_in_synthetic_api_" + secrets.token_hex(8)
        spec = importlib.util.spec_from_file_location(name, ROOT / "agent_service/app.py")
        module = importlib.util.module_from_spec(spec)
        patch.setitem(sys.modules, name, module)
        spec.loader.exec_module(module)
        assert module.WORKSPACE == workspace.resolve()
        assert module.KEY == operator_key and module.MODE == "demo"
        assert module.store.list() == [] and module.tasks == set()
        with TestClient(module.app) as client:
            yield SimpleNamespace(module=module, client=client, workspace=workspace,
                                  headers={"X-API-Key": operator_key}, originals=originals)


def multipart(payloads):
    types = {".pdf": "application/pdf", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
             ".csv": "text/csv"}
    return [("files", (name, data, types.get(Path(name).suffix, "application/octet-stream")))
            for name, data in payloads.items()]


def submit(api, *, payloads=None, terms=None, headers=None):
    return api.client.post(BATCH, files=multipart(api.originals if payloads is None else payloads),
                           data=terms or {}, headers=api.headers if headers is None else headers)


def stream_url(job, **changes):
    params = {"job_id": job["job_id"], "token": job["stream_token"], **changes}
    return "/api/v2/agent-stream?" + urlencode(params)


def receive_bounded(ws, deadline):
    async def receive():
        with anyio.fail_after(max(0.001, deadline - time.monotonic())):
            return await ws._send_rx.receive()

    # TestClient.receive_json() has no timeout; use its portal/ASGI channel so
    # a missing terminal event fails instead of leaving a reader thread hung.
    return ws.portal.call(receive)


def await_terminal(api, accepted):
    events = []
    deadline = time.monotonic() + STREAM_SECONDS
    with api.client.websocket_connect(stream_url(accepted), headers={"origin": ORIGIN}) as ws:
        for _ in range(250):
            message = receive_bounded(ws, deadline)
            if message["type"] == "websocket.close":
                assert message.get("code", 1000) == 1000
                break
            assert message["type"] == "websocket.send"
            events.append(json.loads(message["text"]))
        else:
            pytest.fail("Synthetic stream exceeded its 250-event budget")
    assert events, "The scoped WebSocket must replay and deliver actual engine events"
    assert events[-1]["type"] == "STATE_TRANSITION"
    assert events[-1]["payload"]["state"] in TERMINAL
    response = api.client.get(f"/api/v2/jobs/{accepted['job_id']}", headers=api.headers)
    assert response.status_code == 200
    job = response.json()
    assert job["state"] == events[-1]["payload"]["state"]
    # Verify the whole event hash chain, not just successful socket connection.
    previous, sequence = "0" * 64, 0
    for event in events:
        assert event["job_id"] == accepted["job_id"] and event["seq"] > sequence
        encoded = json.dumps(event["payload"], sort_keys=True, separators=(",", ":"), allow_nan=False)
        digest = hashlib.sha256((previous + event["job_id"] + event["type"] + event["timestamp"] + encoded).encode()).hexdigest()
        assert event["previous_hash"] == previous and event["sha256"] == digest
        previous, sequence = digest, event["seq"]
    assert events == api.module.store.events(accepted["job_id"])
    return SimpleNamespace(accepted=accepted, job=job, events=events,
                           directory=api.workspace / "jobs" / accepted["job_id"])


def run_case(api, **kwargs):
    response = submit(api, **kwargs)
    assert response.status_code == 202, response.text
    accepted = response.json()
    assert accepted["state"] == "QUEUED"
    assert len(accepted["job_id"]) == 32 and accepted["stream_token"]
    return await_terminal(api, accepted)


def states(case):
    return [event["payload"]["state"] for event in case.events if event["type"] == "STATE_TRANSITION"]


def wallet(api, case):
    with api.module.store.connect() as db:
        return [dict(row) for row in db.execute("SELECT amount,status FROM wallet WHERE job_id=?",
                                               (case.accepted["job_id"],))]


def record_case(label, api, case):
    metric_names = ("variance", "passed", "default_probability", "existing_dsr", "dsr", "requested_limit",
                    "financing_ceiling", "approved_limit", "proposed_limit", "haircut_requested_limit", "gates", "is_demo_model")
    summary = {"state": case.job["state"], "error": case.job["error"],
               "metrics": {key: case.job["metrics"][key] for key in metric_names if key in case.job["metrics"]},
               "event_count": len(case.events), "event_hash_chain_verified": True,
               "state_transitions": states(case), "artifact_count": len(case.job["artifacts"]),
               "wallet_entries": wallet(api, case)}
    TEST_EVIDENCE[label] = summary
    print("SYNTHETIC_VALIDATION " + json.dumps({label: summary}, sort_keys=True))


@pytest.fixture(scope="module")
def completed(api):
    case = run_case(api)
    record_case("completion", api, case)
    return case


@pytest.fixture(scope="module")
def review_case(api):
    case = run_case(api, terms={"monthly_debt_service": "50000.00"})
    record_case("review", api, case)
    return case


@pytest.fixture(scope="module")
def quarantine_case(api):
    payloads = dict(api.originals)
    book = load_workbook(io.BytesIO(payloads["statement.xlsx"]))
    try:
        cell = book["BankLedger"]["D2"]
        assert Decimal(str(cell.value)) == Decimal("100000.00")
        cell.value = format(Decimal(str(cell.value)) - Decimal("0.01"), ".2f")
        output = io.BytesIO()
        book.save(output)
        payloads["statement.xlsx"] = output.getvalue()
    finally:
        book.close()
    case = run_case(api, payloads=payloads)
    record_case("quarantine", api, case)
    return case


@pytest.mark.parametrize("path", ["/", "/admin/dashboard", "/admin/review", "/assistant"])
def test_single_port_spa_deep_links_serve_built_entry(api, path):
    entry = ROOT / "frontend/dist/index.html"
    if not entry.is_file():
        pytest.skip("Optional built frontend is not installed")
    response = api.client.get(path)
    assert response.status_code == 200
    assert response.content == entry.read_bytes()
    assert "text/html" in response.headers["content-type"]


@pytest.mark.parametrize("path", ["/api", "/api/v2/not-a-route"])
def test_unknown_api_routes_do_not_fall_back_to_spa(api, path):
    response = api.client.get(path)
    assert response.status_code == 404
    assert "text/html" not in response.headers.get("content-type", "")


def test_config_and_health_explicitly_prohibit_real_funds(api):
    health = api.client.get("/api/v2/health")
    config = api.client.get("/api/v2/config")
    assert health.status_code == config.status_code == 200
    assert health.json() == {"status": "ok", "mode": "demo", "real_funds": False}
    assert config.json() == {
        "mode": "demo", "api_key_required": True, "settlement": "simulated_only", "is_demo": True,
        "myinvois": {"enabled": False, "environment": None,
                     "profile": "MYR invoice 01 v1.0/1.1; supplemental commercial/delivery PDFs required"}}


def test_real_upload_async_completion_and_scoped_terminal_events(api, completed):
    assert completed.job["state"] == "COMPLETED", completed.job
    assert states(completed) == ["QUEUED", "EXTRACTING", "RECONCILING", "UNDERWRITING", "SETTLING", "COMPLETED"]
    metrics = completed.job["metrics"]
    assert Decimal(metrics["variance"]) == 0 and metrics["passed"] is True
    assert metrics["is_demo_model"] is True
    assert Decimal(metrics["default_probability"]) <= Decimal("0.12")
    assert Decimal(metrics["existing_dsr"]) == Decimal("0.01")
    assert Decimal(metrics["dsr"]) <= Decimal("0.45")
    assert Decimal(metrics["approved_limit"]) == Decimal("40000.00")
    assert completed.job["settlement"] == "SIMULATED_ONLY"
    assert completed.job["legal_status"] == "demo_attestation_not_legal_countersignature"
    assert wallet(api, completed) == [{"amount": metrics["approved_limit"], "status": "SIMULATED_ONLY"}]
    tools = Counter(event["payload"]["tool"] for event in completed.events
                    if event["type"] == "TOOL_EXECUTION" and event["payload"]["status"] == "COMPLETED")
    assert tools == {"run_ocr_normalizer": 2, "run_excel_reconciliation": 1,
                     "evaluate_credit_ml": 1, "compile_tnc_agreement": 1, "verify_bundle_integrity": 1}
    assert "sources" not in completed.job and "terms" not in completed.job
    assert completed.accepted["stream_token"] not in json.dumps(completed.job)
    memo = completed.job["decision_memo"]
    assert memo["is_demo"] is True and memo["outcome"] == "APPROVED"
    assert memo["narrative_source"] == "deterministic"
    assert Decimal(memo["figures"]["approved_limit"]) == Decimal("40000.00")
    assert Decimal(memo["figures"]["invoice_total"]) == Decimal("100000.00")
    assert json.loads((completed.directory / "evidence" / "decision_memo.json").read_text(encoding="utf-8")) == memo
    self_check = completed.job["metrics"]["self_check"]
    assert self_check["verified"] is True and self_check["self_check"] == "post_commit"
    assert self_check["outputs_checked"] == 7 and self_check["sources_checked"] >= 9
    assert self_check["real_funds"] is False and self_check["is_demo"] is True
    assert json.loads((completed.directory / "self_check.json").read_text(encoding="utf-8")) == self_check


@pytest.fixture(scope="module")
def downloaded(api, completed, tmp_path_factory):
    assert completed.job["state"] == "COMPLETED", completed.job
    bundle = tmp_path_factory.mktemp("out-in-synthetic-downloads")
    assert len(completed.job["artifacts"]) == 9
    for artifact in completed.job["artifacts"]:
        assert artifact["name"] == Path(artifact["name"]).name
        denied = api.client.get(artifact["url"], headers={"X-API-Key": "invalid-synthetic-key"})
        assert denied.status_code == 401
        response = api.client.get(artifact["url"], headers=api.headers)
        assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
        assert response.content == (completed.directory / "artifacts" / artifact["name"]).read_bytes()
        assert b"PRIVATE KEY" not in response.content
        (bundle / artifact["name"]).write_bytes(response.content)
    return bundle


def test_authorized_download_hashes_and_all_demo_signatures(api, completed, downloaded):
    result = verify_manifest(downloaded)
    assert result["verified"] is True and result["outputs_checked"] == 7
    assert result["real_funds"] is False
    assert result["key_trust"] == "self_contained_demo_keys_only"
    for key in ("manifest_signature", "borrower_attestation", "lender_attestation"):
        assert result[key] == "verified"
    TEST_EVIDENCE["artifact_verification"] = result
    print("SYNTHETIC_VALIDATION " + json.dumps({"artifact_verification": result}, sort_keys=True))
    # Tamper only the temporary downloaded copies, never app-owned artifacts.
    for name in ("Out_In_TNC_Agreement.pdf", "verification_manifest.sig", "lender_attestation.sig"):
        path = downloaded / name
        original = path.read_bytes()
        try:
            path.write_bytes(bytes([original[0] ^ 1]) + original[1:])
            with pytest.raises(VerificationError):
                verify_manifest(downloaded)
        finally:
            path.write_bytes(original)
    jid = completed.accepted["job_id"]
    assert api.client.get(f"/api/v2/jobs/{jid}/artifacts/unpublished.pem", headers=api.headers).status_code == 404


def test_manifest_sources_resolve_against_actual_job_evidence(completed, downloaded):
    # No aliases/copies that could hide incorrect manifest-relative source paths.
    result = verify_manifest(downloaded, source_dir=completed.directory)
    assert result["sources_checked"] >= 9 and result["source_verification"] == "checked"
    TEST_EVIDENCE["source_verification"] = result


def test_real_high_operator_debt_requires_review_without_artifact_or_payout(api, review_case):
    assert review_case.job["state"] == "REVIEW_REQUIRED", review_case.job
    assert states(review_case) == ["QUEUED", "EXTRACTING", "RECONCILING", "UNDERWRITING", "REVIEW_REQUIRED"]
    metrics = review_case.job["metrics"]
    assert Decimal(metrics["variance"]) == 0
    assert metrics["passed"] is False and metrics["review_required"] is True
    assert Decimal(metrics["existing_dsr"]) == Decimal("0.5")
    assert metrics["gates"]["all_in_dsr_le_0_45"] is False
    assert Decimal(metrics["approved_limit"]) == Decimal(metrics["proposed_limit"]) == 0
    assert Decimal(metrics["haircut_requested_limit"]) == Decimal("20000.00")
    assert wallet(api, review_case) == [] and review_case.job["artifacts"] == []
    assert not (review_case.directory / "artifacts").exists()
    assert not (review_case.directory / "staging").exists()
    assert not any(event["type"] == "ARTIFACT_GENERATED" for event in review_case.events)
    response = api.client.get("/api/v2/review-queue", headers=api.headers)
    assert response.status_code == 200
    assert review_case.accepted["job_id"] in {job["id"] for job in response.json()["jobs"]}
    jid = review_case.accepted["job_id"]
    assert api.client.get(f"/api/v2/jobs/{jid}/artifacts/Out_In_TNC_Agreement.pdf", headers=api.headers).status_code == 404


def test_real_one_cent_mismatch_three_reslices_then_quarantine_report_no_wallet(api, quarantine_case):
    assert quarantine_case.job["state"] == "QUARANTINED", quarantine_case.job
    transitions = states(quarantine_case)
    assert transitions.count("SELF_HEALING") == 3 and transitions.count("RECONCILING") == 4
    assert "UNDERWRITING" not in transitions and "SETTLING" not in transitions
    assert Decimal(quarantine_case.job["metrics"]["variance"]) == Decimal("0.01")
    assert wallet(api, quarantine_case) == []
    tools = [event["payload"] for event in quarantine_case.events if event["type"] == "TOOL_EXECUTION"]
    assert not any(tool["tool"] in ("evaluate_credit_ml", "compile_tnc_agreement") for tool in tools)
    for cycle in range(4):
        assert sum(tool["tool"] == "run_ocr_normalizer" and tool["status"] == "COMPLETED"
                   and tool["cycle"] == cycle for tool in tools) == 2
        assert sum(tool["tool"] == "run_excel_reconciliation" and tool["status"] == "COMPLETED"
                   and tool["cycle"] == cycle for tool in tools) == 1
    rollback = [event["payload"] for event in quarantine_case.events if event["type"] == "ROLLBACK_TRIGGERED"]
    # Four failed audits emit rollback notices; only the first three are heals.
    assert [event["cycle"] for event in rollback] == [1, 2, 3, 4]
    assert all(event["maximum_self_heals"] == 3 for event in rollback)
    for cycle in range(1, 4):
        for stem in ("invoice", "packing_list"):
            packet = json.loads((quarantine_case.directory / "normalized" / f"{stem}-cycle-{cycle}.json").read_text())
            assert packet["backend"] == "local_pdfplumber_pdfium"
            assert packet["cycle"] == cycle and packet["crops"]
            for crop in packet["crops"]:
                assert crop["dpi"] == 240 + cycle * 40 and "local_crop" not in crop
                image = quarantine_case.directory / "crops" / f"cycle-{cycle}" / f"{stem}-{crop['page']}-0.png"
                assert hashlib.sha256(image.read_bytes()).hexdigest() == crop["sha256"]
    assert [a["name"] for a in quarantine_case.job["artifacts"]] == ["variance_report.json"]
    url = quarantine_case.job["artifacts"][0]["url"]
    assert api.client.get(url).status_code == 401
    response = api.client.get(url, headers=api.headers)
    assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    report = response.json()
    assert report["self_heal_cycles"] == 3 and report["disbursement"] == "prohibited"
    assert report["is_demo"] is True and report["passed"] is False
    assert Decimal(report["variance"]) == Decimal("0.01")
    assert response.content == (quarantine_case.directory / "quarantine/variance_report.json").read_bytes()
    assert not (quarantine_case.directory / "artifacts").exists()


@pytest.mark.parametrize("headers", [{}, {"X-API-Key": "invalid-synthetic-key"}], ids=["missing", "invalid"])
def test_operator_key_fails_closed_on_protected_routes(api, completed, headers):
    before = len(api.module.store.list())
    jid = completed.accepted["job_id"]
    for url in (f"/api/v2/jobs/{jid}", "/api/v2/review-queue", f"/api/v2/jobs/{jid}/artifacts/MasterLedger.xlsx"):
        assert api.client.get(url, headers=headers).status_code == 401
    assert submit(api, headers=headers).status_code == 401
    assert len(api.module.store.list()) == before


@pytest.mark.parametrize("defect", ["invalid-token", "missing-token", "wrong-job-token", "invalid-origin", "unknown-job", "invalid-after"])
def test_websocket_auth_origin_and_job_scope_fail_closed(api, completed, review_case, defect):
    changes, origin = {}, ORIGIN
    if defect == "invalid-token":
        changes["token"] = "forged-synthetic-token"
    elif defect == "missing-token":
        changes["token"] = ""
    elif defect == "wrong-job-token":
        changes["token"] = review_case.accepted["stream_token"]
    elif defect == "invalid-origin":
        origin = "https://invalid.synthetic.test"
    elif defect == "unknown-job":
        changes["job_id"] = "0" * 32
    else:
        changes["after"] = "not-an-integer"
    with pytest.raises(WebSocketDisconnect) as denied:
        with api.client.websocket_connect(stream_url(completed.accepted, **changes), headers={"origin": origin}) as ws:
            # If a regression accepts the handshake, never wait unboundedly.
            message = receive_bounded(ws, time.monotonic() + 5)
            pytest.fail(f"Invalid synthetic WebSocket was accepted: {message['type']}")
    assert denied.value.code == 1008


def assert_rejected_without_job(api, response, before):
    if response.status_code == 202:
        # Drain an accidentally accepted job so a failure cannot leak work into
        # subsequent tests or turn fixture teardown into an unbounded wait.
        unexpected = await_terminal(api, response.json())
        TEST_EVIDENCE.setdefault("unexpected_acceptances", []).append({"state": unexpected.job["state"]})
    assert response.status_code == 422, response.text
    assert len(api.module.store.list()) == before


@pytest.mark.parametrize("filename", ["../escape.pdf", "nested/escape.pdf", "nested\\escape.pdf", "/escape.pdf"])
def test_traversal_upload_fails_closed(api, filename):
    payloads = dict(api.originals)
    payloads[filename] = payloads.pop("invoice.pdf")
    before = len(api.module.store.list())
    assert_rejected_without_job(api, submit(api, payloads=payloads), before)
    assert not (api.workspace / "escape.pdf").exists()


@pytest.mark.parametrize("extension", ["txt", "zip", "exe", "pdf.exe"])
def test_unsupported_upload_extension_fails_closed(api, extension):
    payloads = dict(api.originals)
    payloads[f"invoice.{extension}"] = payloads.pop("invoice.pdf")
    before = len(api.module.store.list())
    assert_rejected_without_job(api, submit(api, payloads=payloads), before)


@pytest.mark.parametrize("field,value", [
    ("requested_limit", "0"), ("requested_limit", "-1.00"), ("requested_limit", "1000000000.01"),
    ("requested_limit", "0.001"), ("requested_limit", "NaN"), ("requested_limit", "Infinity"),
    ("requested_limit", "invalid"), ("duration_months", "0"), ("duration_months", "121"),
    ("duration_months", "-1"), ("duration_months", "12.5"), ("duration_months", "invalid"),
    ("annual_rate", "-0.01"), ("annual_rate", "1.01"), ("annual_rate", "NaN"),
    ("annual_rate", "Infinity"), ("annual_rate", "invalid"),
    ("monthly_debt_service", "-0.01"), ("monthly_debt_service", "1000000000.01"),
    ("monthly_debt_service", "0.001"), ("monthly_debt_service", "NaN"),
    ("monthly_debt_service", "Infinity"), ("monthly_debt_service", "invalid"),
])
def test_invalid_loan_terms_fail_closed_before_job_creation(api, field, value):
    before = len(api.module.store.list())
    assert_rejected_without_job(api, submit(api, terms={field: value}), before)


def test_terminal_state_commit_waits_for_final_websocket_event(api):
    jid, token = api.module.store.create("demo", {}, [])
    api.module.store.update(jid, state="FAILED")
    done = threading.Event()
    def append_verdict():
        api.module.store.event(jid, "STATE_TRANSITION", {"state": "FAILED"})
        done.set()
    timer = threading.Timer(0.25, append_verdict)
    timer.start()
    try:
        with api.client.websocket_connect(stream_url({"job_id": jid, "stream_token": token}), headers={"origin": ORIGIN}) as ws:
            received = []
            for _ in range(5):
                message = receive_bounded(ws, time.monotonic() + 5)
                if message["type"] == "websocket.close":
                    break
                received.append(json.loads(message["text"]))
            assert done.is_set()
            assert received[-1]["type"] == "STATE_TRANSITION"
            assert received[-1]["payload"]["state"] == "FAILED"
    finally:
        timer.cancel()
        timer.join(timeout=2)


@pytest.fixture
def synthetic_myinvois_job(api):
    assert api.module.MODE == "demo" and api.module.myinvois is None
    jid, token = api.module.store.create(
        "demo", {"myinvois_document_ids": ["SYNTHETIC_opaque-0"]}, [])
    directory = api.workspace / "jobs" / jid / "evidence"
    directory.mkdir(parents=True)
    payloads = {
        "myinvois-response-0.json": (
            b'{"synthetic_only":true,"uuid":"SYNTHETIC_opaque-0",'
            b'"document":"SYNTHETIC API RESPONSE - NOT REAL INVOICE DATA"}\n'),
        "myinvois-provenance-0.json": (
            b'{"synthetic_only":true,"document_id":"SYNTHETIC_opaque-0",'
            b'"source":"SYNTHETIC OFFLINE API RESPONSE","external_network":false}\n'),
    }
    sources = []
    for name, content in payloads.items():
        (directory / name).write_bytes(content)
        sources.append({"name": "evidence/" + name,
                        "sha256": hashlib.sha256(content).hexdigest()})
    api.module.store.update(jid, myinvois_sources=sources)
    return SimpleNamespace(jid=jid, token=token, directory=directory,
                           payloads=payloads, sources=sources)


def test_myinvois_disabled_ids_reject_but_normal_batch_remains_available(api):
    config = api.client.get("/api/v2/config")
    assert config.status_code == 200
    assert config.json() == {
        "mode": "demo", "api_key_required": True, "settlement": "simulated_only", "is_demo": True,
        "myinvois": {"enabled": False, "environment": None,
                     "profile": "MYR invoice 01 v1.0/1.1; supplemental commercial/delivery PDFs required"}}
    assert api.module.myinvois is None
    before = len(api.module.store.list())
    incoming = set((api.workspace / "incoming").glob("*"))
    valid_ids = (
        " SYNTHETIC_opaque-0,SYNTHETIC_opaque-1;\nSYNTHETIC_opaque-0 " + "S" * 128,
        ";".join(f"SYNTHETIC_opaque-{index}" for index in range(10)),
    )
    for value in valid_ids:
        response = submit(api, terms={"myinvois_document_ids": value})
        assert response.status_code == 409, response.text
        assert response.json() == {"detail": "MyInvois retrieval is not enabled on this backend"}
        assert len(api.module.store.list()) == before
        assert set((api.workspace / "incoming").glob("*")) == incoming
    case = run_case(api)
    assert case.job["mode"] == "demo" and case.job["state"] == "COMPLETED", case.job
    stored = api.module.store.get(case.accepted["job_id"])
    assert "myinvois_document_ids" not in stored["terms"]
    assert not stored.get("myinvois_sources")
    assert not (case.directory / "evidence" / "myinvois-response-0.json").exists()
    assert not any(event["type"] == "TOOL_EXECUTION"
                   and event["payload"]["tool"] == "fetch_myinvois_invoice" for event in case.events)


@pytest.mark.parametrize("value", [
    "../SYNTHETIC_opaque-0", "nested\\SYNTHETIC_opaque-0", "S" * 129,
    ",".join(f"SYNTHETIC_opaque-{index}" for index in range(11)),
    "S" * 2001, "SYNTHETIC_opaque-0?query=value", ", ;\n\t ",
], ids=["slash", "backslash", "overlong-id", "eleven-distinct-ids",
        "overlong-field", "non-opaque-punctuation", "separators-only"])
def test_myinvois_invalid_ids_fail_before_disabled_backend_or_job_creation(api, value):
    before = len(api.module.store.list())
    incoming = set((api.workspace / "incoming").glob("*"))
    response = submit(api, terms={"myinvois_document_ids": value})
    assert_rejected_without_job(api, response, before)
    assert "MyInvois" in response.json()["detail"]
    assert set((api.workspace / "incoming").glob("*")) == incoming


@pytest.mark.parametrize("headers", [{}, {"X-API-Key": "invalid-synthetic-key"}],
                         ids=["missing", "invalid"])
def test_myinvois_batch_auth_precedes_id_and_upload_processing(api, headers):
    before = len(api.module.store.list())
    incoming = set((api.workspace / "incoming").glob("*"))
    for value in ("SYNTHETIC_opaque-0", "../SYNTHETIC_invalid"):
        response = submit(api, headers=headers,
                          payloads={"../synthetic.pdf": b"SYNTHETIC INVALID PDF",
                                    "synthetic.csv": b"SYNTHETIC INVALID STATEMENT"},
                          terms={"myinvois_document_ids": value, "requested_limit": "not-money"})
        assert response.status_code == 401, response.text
        assert response.json() == {"detail": "Operator API key required"}
        assert len(api.module.store.list()) == before
        assert set((api.workspace / "incoming").glob("*")) == incoming


def test_myinvois_source_auth_reveals_no_job_information(api, synthetic_myinvois_job):
    case = synthetic_myinvois_job
    before = api.module.store.get(case.jid)
    for headers in ({}, {"X-API-Key": "invalid-synthetic-key"}):
        for jid, name in ((case.jid, "myinvois-response-0.json"),
                          (case.jid, "unpublished.json"),
                          ("0" * 32, "myinvois-response-0.json"),
                          ("not-a-job", "myinvois-provenance-0.json")):
            response = api.client.get(f"/api/v2/jobs/{jid}/myinvois-sources/{name}", headers=headers)
            assert response.status_code == 401
            assert response.json() == {"detail": "Operator API key required"}
            assert case.jid not in response.text and case.token not in response.text
            assert "myinvois_sources" not in response.text and "sha256" not in response.text
            assert "content-disposition" not in response.headers
    assert api.module.store.get(case.jid) == before


def test_myinvois_source_nonexistent_job_returns_404(api):
    with pytest.raises(KeyError):
        api.module.store.get("0" * 32)
    response = api.client.get(
        "/api/v2/jobs/" + "0" * 32 + "/myinvois-sources/myinvois-response-0.json",
        headers=api.headers)
    assert response.status_code == 404
    assert response.json() == {"detail": "Unknown job"}


@pytest.mark.parametrize("name", ["myinvois-response-0.json", "myinvois-provenance-0.json"],
                         ids=["synthetic-response", "synthetic-provenance"])
def test_myinvois_declared_source_download_bytes_headers_and_integrity(api, synthetic_myinvois_job, name):
    case = synthetic_myinvois_job
    response = api.client.get(f"/api/v2/jobs/{case.jid}/myinvois-sources/{name}", headers=api.headers)
    assert response.status_code == 200, response.text
    assert response.content == case.payloads[name] == (case.directory / name).read_bytes()
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["content-disposition"] == f'attachment; filename="{name}"'
    assert response.headers["content-type"].split(";")[0] == "application/json"
    assert int(response.headers["content-length"]) == len(case.payloads[name])
    declared = next(source for source in api.module.store.get(case.jid)["myinvois_sources"]
                    if source["name"] == "evidence/" + name)
    assert hashlib.sha256(response.content).hexdigest() == declared["sha256"]
    assert response.json()["synthetic_only"] is True
    assert case.token not in response.text


def test_myinvois_unknown_sources_and_tampering_fail_closed(api, synthetic_myinvois_job):
    case = synthetic_myinvois_job
    content = b'{"synthetic_only":true,"note":"SYNTHETIC UNPUBLISHED EVIDENCE"}\n'
    for name in ("myinvois-response-9.json", "synthetic-extra.json"):
        (case.directory / name).write_bytes(content)
    api.module.store.update(case.jid, myinvois_sources=case.sources + [
        {"name": "evidence/synthetic-extra.json", "sha256": hashlib.sha256(content).hexdigest()}])
    for name in ("myinvois-response-9.json", "synthetic-extra.json", "myinvois-response-0.json.bak"):
        response = api.client.get(f"/api/v2/jobs/{case.jid}/myinvois-sources/{name}", headers=api.headers)
        assert response.status_code == 404
        assert response.json() == {"detail": "MyInvois source not published"}
        assert "content-disposition" not in response.headers
    for name, original in case.payloads.items():
        path = case.directory / name
        try:
            path.write_bytes(original + b"SYNTHETIC TAMPER\n")
            response = api.client.get(f"/api/v2/jobs/{case.jid}/myinvois-sources/{name}", headers=api.headers)
            assert response.status_code == 409
            assert response.json() == {"detail": "MyInvois source integrity check failed"}
            assert "SYNTHETIC TAMPER" not in response.text
            assert "content-disposition" not in response.headers
            declared = next(source for source in api.module.store.get(case.jid)["myinvois_sources"]
                            if source["name"] == "evidence/" + name)
            assert declared["sha256"] == hashlib.sha256(original).hexdigest()
        finally:
            path.write_bytes(original)


def test_demo_run_requires_operator_key(api):
    before = len(api.module.store.list())
    incoming = set((api.workspace / "incoming").glob("*"))
    for headers in ({}, {"X-API-Key": "invalid-synthetic-key"}):
        for data in ({}, {"scenario": "unsupported"}):
            response = api.client.post("/api/v2/demo-run", headers=headers, data=data)
            assert response.status_code == 401
    assert len(api.module.store.list()) == before
    assert set((api.workspace / "incoming").glob("*")) == incoming


@pytest.mark.parametrize("scenario", ["unsupported", "Approval", "../approval"])
def test_demo_run_invalid_scenario_creates_no_job_or_incoming(api, scenario):
    before = len(api.module.store.list())
    incoming = set((api.workspace / "incoming").glob("*"))
    incoming_exists = (api.workspace / "incoming").exists()
    response = api.client.post("/api/v2/demo-run", headers=api.headers, data={"scenario": scenario})
    assert_rejected_without_job(api, response, before)
    assert response.json() == {"detail": "Unsupported demo scenario"}
    assert set((api.workspace / "incoming").glob("*")) == incoming
    assert (api.workspace / "incoming").exists() == incoming_exists


@pytest.mark.parametrize("data", [{}, {"scenario": "approval"}], ids=["no-body", "explicit-approval"])
def test_demo_run_one_action_completes_end_to_end(api, data):
    response = api.client.post("/api/v2/demo-run", headers=api.headers, data=data)
    assert response.status_code == 202, response.text
    accepted = response.json()
    assert accepted["state"] == "QUEUED"
    assert len(accepted["job_id"]) == 32 and accepted["stream_token"]
    case = await_terminal(api, accepted)
    assert case.job["state"] == "COMPLETED", case.job
    assert states(case) == ["QUEUED", "EXTRACTING", "RECONCILING", "UNDERWRITING", "SETTLING", "COMPLETED"]
    assert Decimal(case.job["metrics"]["approved_limit"]) == Decimal("40000.00")
    assert case.job["metrics"]["self_check"]["verified"] is True
    assert case.job["decision_memo"]["outcome"] == "APPROVED"
    assert len(case.job["artifacts"]) == 9
    assert wallet(api, case) == [{"amount": case.job["metrics"]["approved_limit"], "status": "SIMULATED_ONLY"}]
    # One-action intake must land exactly the three generated fixtures.
    inputs = sorted(path.name for path in (case.directory / "inputs").iterdir())
    assert inputs == ["invoice.pdf", "packing_list.pdf", "statement.xlsx"]
    assert set(accepted) == {"job_id", "stream_token", "state"}
    stored = api.module.store.get(accepted["job_id"])
    assert case.job["demo_scenario"] == stored["demo_scenario"] == "approval"
    assert stored["terms"] == api.module.DEMO_RUN_TERMS
    for source in stored["sources"]:
        name = source["name"]
        assert (case.directory / "inputs" / name).read_bytes() == api.originals[name]
        assert source["sha256"] == hashlib.sha256(api.originals[name]).hexdigest()
    for name, original in api.originals.items():
        assert (ROOT / "demo/dossier" / name).read_bytes() == original


def test_demo_run_risk_review_uses_real_model_without_artifact_or_wallet(api):
    response = api.client.post("/api/v2/demo-run", headers=api.headers, data={"scenario": "risk_review"})
    assert response.status_code == 202, response.text
    case = await_terminal(api, response.json())
    record_case("demo_risk_review", api, case)
    assert case.job["demo_scenario"] == "risk_review"
    test_real_high_operator_debt_requires_review_without_artifact_or_payout(api, case)
    assert case.job["metrics"]["is_demo_model"] is True
    tools = Counter(event["payload"]["tool"] for event in case.events
                    if event["type"] == "TOOL_EXECUTION" and event["payload"]["status"] == "COMPLETED")
    assert tools == {"run_ocr_normalizer": 2, "run_excel_reconciliation": 1, "evaluate_credit_ml": 1}
    stored = api.module.store.get(case.accepted["job_id"])
    assert stored["demo_scenario"] == "risk_review"
    assert stored["terms"] == {**api.module.DEMO_RUN_TERMS, "monthly_debt_service": "50000.00"}
    assert sorted(path.name for path in (case.directory / "inputs").iterdir()) == sorted(api.originals)
    for source in stored["sources"]:
        name = source["name"]
        assert (case.directory / "inputs" / name).read_bytes() == api.originals[name]
        assert source["sha256"] == hashlib.sha256(api.originals[name]).hexdigest()
    for name, original in api.originals.items():
        assert (ROOT / "demo/dossier" / name).read_bytes() == original


def test_demo_run_parity_mismatch_csv_repairs_and_audits_without_wallet(api):
    originals = read_statement(str(ROOT / "demo/dossier/statement.xlsx"))
    receipt_index = next(index for index, row in enumerate(originals)
                         if row["invoice_id"] and money(row["inflow"]) > 0)
    assert originals[receipt_index]["invoice_id"] == "DEMO-INV-001"
    assert money(originals[receipt_index]["inflow"]) == Decimal("100000.00")
    ingested = {path: path.read_bytes() for path in (api.workspace / "jobs").glob("*/inputs/*")}
    response = api.client.post("/api/v2/demo-run", headers=api.headers, data={"scenario": "parity_mismatch"})
    assert response.status_code == 202, response.text
    case = await_terminal(api, response.json())
    record_case("demo_parity_mismatch", api, case)
    assert case.job["demo_scenario"] == "parity_mismatch"
    test_real_one_cent_mismatch_three_reslices_then_quarantine_report_no_wallet(api, case)
    inputs = case.directory / "inputs"
    assert sorted(path.name for path in inputs.iterdir()) == ["invoice.pdf", "packing_list.pdf", "statement.csv"]
    columns = ["transaction_id", "invoice_id", "currency", "inflow", "outflow", "date"]
    expected = [{key: row[key] for key in columns} for row in originals]
    expected[receipt_index]["inflow"] = str(money(expected[receipt_index]["inflow"]) - Decimal("0.01"))
    with (inputs / "statement.csv").open(encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        assert reader.fieldnames == columns
        assert list(reader) == expected
    assert read_statement(str(inputs / "statement.csv")) == expected
    stored = api.module.store.get(case.accepted["job_id"])
    assert stored["demo_scenario"] == "parity_mismatch"
    assert stored["terms"] == api.module.DEMO_RUN_TERMS
    assert {source["name"] for source in stored["sources"]} == {path.name for path in inputs.iterdir()}
    for source in stored["sources"]:
        content = (inputs / source["name"]).read_bytes()
        assert source["sha256"] == hashlib.sha256(content).hexdigest()
        if source["name"].endswith(".pdf"):
            assert content == api.originals[source["name"]]
    assert sorted(path.name for path in (case.directory / "evidence").glob("audit-*.json")) == [
        "audit-0.json", "audit-1.json", "audit-2.json", "audit-3.json"]
    for cycle in range(4):
        audit = json.loads((case.directory / "evidence" / f"audit-{cycle}.json").read_text(encoding="utf-8"))
        assert audit["passed"] is False and Decimal(audit["variance"]) == Decimal("0.01")
        assert audit["bank_rows"] == expected
    for name, original in api.originals.items():
        assert (ROOT / "demo/dossier" / name).read_bytes() == original
    for path, content in ingested.items():
        assert path.read_bytes() == content
