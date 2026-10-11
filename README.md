# Dormathon — OUT\&IN Mission Control

An agent web application for bounded, audit-grade SME invoice underwriting and  
cross-border financing: React operations console, FastAPI scheduler, native  
CodeBuddy SDK extraction and narrative agents, exact `Decimal` reconciliation,  
reviewed scikit-learn credit gates, read-only LHDN MyInvois retrieval,  
plain-language decision memos, and downloadable self-verified signed integrity  
evidence.

**Settlement, wallet entries, contracts and attestations are demonstration-only  
in every mode. No real funds are moved.**

## Layout

| Path                  | Contents                                                        |
| --------------------- | --------------------------------------------------------------- |
| `outputs/out-in/`     | The actual application (backend, tools, frontend, tests, docs)  |
| `out-in-sdk-starter/` | Original chat SDK starter retained as provenance reference only |

## Prerequisites

- **Python 3.13+** — verify: `python --version`
- **Node.js 22.20+** — verify: `node --version`
- **npm** on PATH — verify: `npm --version`

## Quick start

### Option A — One-command deploy (Windows PowerShell)

From the repository root:

```powershell
& ./outputs/out-in/scripts/deploy_demo.ps1 -CopyKeyToClipboard
```

This creates the venv, installs all dependencies, builds the frontend, generates  
synthetic demo assets, starts the server, and copies the operator key to your  
clipboard. When it finishes, open <http://127.0.0.1:8000> and paste the key.

For subsequent runs (everything already built):

```powershell
& ./outputs/out-in/scripts/deploy_demo.ps1 -ReuseEnvironment -ReuseWorkspace -CopyKeyToClipboard
```

### Option B — Manual setup (any platform)

```bash
# 1. Go to the app directory
cd outputs/out-in

# 2. Create a Python virtual environment
python3.13 -m venv .venv

# 3. Install Python dependencies
#    Windows:  ./.venv/Scripts/python.exe -m pip install -r requirements.txt
#    macOS/Linux: ./.venv/bin/python -m pip install -r requirements.txt
.venv/Scripts/python.exe -m pip install -r requirements.txt   # Windows
# .venv/bin/python -m pip install -r requirements.txt          # macOS/Linux

# 4. Install and build the frontend
npm --prefix frontend ci --include=dev --no-audit --no-fund
npm --prefix frontend run build

# 5. Generate synthetic demo assets (models, invoice, statement, dossier ZIP)
.venv/Scripts/python.exe scripts/prepare_demo.py   # Windows
# .venv/bin/python scripts/prepare_demo.py           # macOS/Linux

# 6. Start the server
#    Windows:
.venv/Scripts/python.exe -m uvicorn agent_service.app:app --host 127.0.0.1 --port 8000 --workers 1
#    macOS/Linux:
# .venv/bin/python -m uvicorn agent_service.app:app --host 127.0.0.1 --port 8000 --workers 1
```

The server prints `Application startup complete.` when ready.

### Use the app

1. Open **<http://127.0.0.1:8000>** in your browser.
2. Enter the operator API key:
   - If you used `-CopyKeyToClipboard`, paste from clipboard.
   - If you started manually, the key is whatever you set in `OUT_IN_API_KEY`.       
     If you didn't set one, demo mode allows any non-empty value — type any text.
3. Select **01 / Approve & seal**, then click **Run selected scenario** to execute the full autonomous underwriting     
   pipeline on the synthetic dossier with one click.
4. Watch the four-stage pipeline (extraction → reconciliation → risk →     
   settlement), live metrics, decision memo, and artifact vault in real time.

### Showcase the real engine

Run these scenarios in order using the cards at the top of Mission Control:

1. **Approve & seal**: inspect exact invoice arithmetic, receipt matching, delivery/audit gates, real synthetic-model inference, the 12-installment Decimal schedule, and nine published artifacts.
2. **Stop on credit risk**: unchanged evidence with MYR 50,000 monthly debt triggers real credit-policy review. No contract, artifact bundle or simulated wallet entry is created.
3. **Catch one missing cent**: a separate generated CSV receipt is MYR 0.01 short. Watch three PDF repair cycles at 280/320/360 DPI and final quarantine. Original fixtures remain unchanged; underwriting and settlement are blocked.

Expand the nine feature cards for implementation details and caveats. After approval, click **Re-hash payloads & test a modified copy** to check all seven manifest payload hashes and detect a flipped byte in a separate in-memory copy. This does not modify server artifacts and does not independently verify signatures or source authenticity.

Expand **Audit telemetry** to inspect actual WebSocket events and previous-hash links. Reopening a run replays its recorded events. Hash-link comparison is not digest verification or external audit anchoring.

**Honest boundaries:** MyInvois authenticated retrieval and live SDK extraction are not executed by this demo. PDF retries really reslice evidence, but synthetic extraction reads embedded PDF text; optional Tesseract is required for image OCR. Models are trained on synthetic data, attestations are not legal signatures, and no real funds move.

Validation for these changes: **999 backend tests and 7 frontend tests passed** locally on 2026-10-11; Vite production build passed. These are recorded offline checks, not live-provider certification.

```bash
# From the repository root; run frontend showcase regressions:
npm --prefix outputs/out-in/frontend test
```

For a repeatable end-to-end API check against the running local demo (Windows PowerShell):

```powershell
# From the repository root; paste the same key used in Mission Control.
$env:OUT_IN_API_KEY = Get-Clipboard
node ./outputs/verify-showcase.cjs
```

This creates three synthetic jobs, checks actual outcomes and stream replay, hashes all seven approval payloads, rejects modified in-memory copies, and confirms the original demo fixtures are unchanged. Results are saved to `outputs/showcase-validation.json`. It does not drive the browser, invoke live providers, or move real funds.

## Documentation

- **[outputs/out-in/README.md](outputs/out-in/README.md)** — product overview,    
  setup (all platforms), workflow, underwriting policy, API, security,    
  verification, tests, operations and contributing guidelines.
- **[outputs/out-in/INTEGRATION.md](outputs/out-in/INTEGRATION.md)** —    
  architecture, adapter contracts, SDK/MCP details, MyInvois integration and    
  production boundaries.
- **[outputs/out-in/PITCH.md](outputs/out-in/PITCH.md)** — Dormathon pitch    
  script and criterion-by-criterion rubric alignment map.

## Verification

```bash
cd outputs/out-in

# Generate demo assets (skip if already done)
.venv/Scripts/python.exe scripts/prepare_demo.py          # Windows
# .venv/bin/python scripts/prepare_demo.py                  # macOS/Linux

# Run the full backend test suite (999 offline tests)
.venv/Scripts/python.exe -m pytest tests -q                # Windows
# .venv/bin/python -m pytest tests -q                        # macOS/Linux

# Build the frontend
npm --prefix frontend run build
```

Current executed suite: **999 backend tests and 7 frontend tests passing**, plus a clean Vite production build, on Python 3.14.4 and Node 22.22.2 (2026-10-11).
