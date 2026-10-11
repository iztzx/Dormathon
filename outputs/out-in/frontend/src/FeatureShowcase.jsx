import { useEffect, useRef, useState } from 'react';
import { Activity, ArrowRight, Check, ChevronDown, Cpu, FileCheck2, FlaskConical, KeyRound, LoaderCircle, Play, RotateCcw, ScanLine, ShieldCheck } from 'lucide-react';
import { readArtifact } from './api.js';
import { artifactsOf, money, normalizeState, redact } from './model.js';

export const DEMO_SCENARIOS = [
  { id: 'approval', title: '01 / Approve & seal', description: 'Canonical synthetic dossier. Watch exact reconciliation, real model inference, signing and post-commit self-check.', expected: 'Expected: COMPLETED · 9 artifacts' },
  { id: 'risk_review', title: '02 / Stop on credit risk', description: 'Same evidence, monthly debt raised to MYR 50,000. The real DSR gate decides; no approval override.', expected: 'Expected: REVIEW REQUIRED · no wallet action' },
  { id: 'parity_mismatch', title: '03 / Catch one missing cent', description: 'A new CSV receipt is MYR 0.01 short. Original fixtures stay untouched. Three real reslices cannot repair a bank discrepancy.', expected: 'Expected: QUARANTINED · 3 retries · no ML' },
];

const EXPECTED_PAYLOADS = new Set([
  'MasterLedger.xlsx', 'Out_In_TNC_Agreement.pdf', 'demo_public_key.pem',
  'demo_borrower_public_key.pem', 'demo_lender_public_key.pem',
  'borrower_attestation.sig', 'lender_attestation.sig',
]);

const FEATURES = [
  { title: 'Exact Decimal reconciliation', icon: ScanLine, detail: 'Python Decimal checks line totals, adjustments, invoice-linked receipts, delivery quantities, seals and Incoterms. Zero monetary variance alone is not a delivery pass.', proof: 'Inspect the audit gates and arithmetic below; compare approval with the one-cent scenario.' },
  { title: 'Real ML, deterministic gates', icon: Cpu, detail: 'Random Forest inference is real. Probability ≤ 12%, all-in DSR ≤ 45% and positive principal are required. The ceiling is min(requested, model, 80% of invoices, DSR capacity).', proof: 'Compare the risk gate results and model hashes. Synthetic training is not calibrated lending risk.' },
  { title: 'Bounded repair & quarantine', icon: RotateCcw, detail: 'Three repair attempts reslice original PDFs at 280, 320 and 360 DPI. A fourth failed audit exhausts the budget—it is not a fourth repair.', proof: 'Run the one-cent scenario. Crops are real; demo parsing uses embedded PDF text. Image OCR depends on optional Tesseract; no successful correction is claimed.' },
  { title: 'Post-commit self-verification', icon: ShieldCheck, detail: 'Before COMPLETED, the backend checks seven payload hashes, manifest signature, borrower/lender Ed25519 attestations and declared sources. Failure rolls back simulation.', proof: 'Read the actual self-check fields. A completed state without a reported self-check is not displayed as verified.' },
  { title: 'WebSocket audit trail', icon: Activity, detail: 'Job-scoped token, origin allowlist and replay cursor carry real tool, state, metric, repair and artifact events. SQLite stores SHA-256-linked envelopes.', proof: 'Expand telemetry to see both hashes. Link comparison is not digest verification, external anchoring or proof against a local writer.' },
  { title: 'Nine-file evidence bundle', icon: FileCheck2, detail: 'Seven-sheet MasterLedger, demo agreement, role attestations, three public keys and signed manifest. Monetary and repayment arithmetic remain in Decimal evidence.', proof: 'Inspect the manifest and repayment schedule. Re-hash downloaded payloads, then prove a modified in-memory copy fails.' },
  { title: 'LHDN MyInvois adapter', icon: KeyRound, detail: 'Implemented read-only OAuth retrieval and UBL parsing with commercial binding and strict transport controls. Default demo makes no LHDN calls.', proof: 'Offline fixtures test the adapter. Authenticated retrieval is not validated; enabled configuration is not independent proof of integration readiness.' },
  { title: 'Stage-scoped SDK extraction', icon: Cpu, detail: 'Live mode can use bounded SDK extraction: 12 turns, 180 seconds. The agent proposes evidence; deterministic code owns reconciliation, risk and settlement.', proof: 'Demo mode uses explicitly marked synthetic PDF packets, not an SDK agent. SDK/provider authentication is not demonstrated here.' },
  { title: 'Offline regression coverage', icon: FlaskConical, detail: 'Showcase validation: 999 backend tests passed. Original baseline: 992 tests; scenario and renderer checks add seven cases. Frontend regressions cover evidence labels, replayed verdicts and download boundaries.', proof: 'Recorded local validation on 2026-10-11, not a live test runner. SDK/transport fixtures are mocked; offline tests do not validate authenticated providers.' },
];

export function DemoLauncher({ onRun, busy, disabled, scenario, setScenario, error }) {
  return <section className="panel showcase-launcher" aria-labelledby="demo-showcase-title">
    <div className="panel-heading"><div><span className="eyebrow">DEMO / PROVE IT, DON'T JUST DESCRIBE IT</span><h2 id="demo-showcase-title">Three runs. Three defensible outcomes.</h2></div><span className="subtle-chip">REAL ENGINE · SYNTHETIC INPUTS</span></div>
    <div className="scenario-grid">{DEMO_SCENARIOS.map((item) => <button type="button" key={item.id} className={`scenario-card ${scenario === item.id ? 'selected' : ''}`} aria-pressed={scenario === item.id} onClick={() => setScenario(item.id)} disabled={busy}>
      <span className="scenario-title">{item.title}{scenario === item.id && <Check size={16} />}</span><span>{item.description}</span><small>{item.expected}</small>
    </button>)}</div>
    <div className="showcase-launch-foot"><p>No fabricated events, no relaxed gates, no real funds. Outcomes are computed—not forced.</p><button type="button" className="secondary-button showcase-run" onClick={onRun} disabled={disabled || busy}>{busy ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}Run selected scenario<ArrowRight size={15} /></button></div>
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>;
}

function Gate({ label, value }) {
  return <span className={`showcase-gate ${value === true ? 'positive' : value === false ? 'negative' : 'neutral'}`}><span className="status-dot" />{label}<strong>{value === true ? 'PASS' : value === false ? 'FAIL' : 'NOT REPORTED'}</strong></span>;
}

export function featureStatuses(job, events, config) {
  const metrics = job?.metrics || {};
  const seen = (tool) => events.some((event) => event.type === 'TOOL_EXECUTION' && event.payload?.tool === tool && event.payload?.status === 'COMPLETED');
  const audit = events.filter((event) => event.type === 'METRICS' && typeof event.payload?.passed === 'boolean' && !('default_probability' in event.payload)).at(-1)?.payload;
  const repairs = events.filter((event) => event.type === 'TOOL_EXECUTION' && event.payload?.tool === 'run_ocr_normalizer' && event.payload?.status === 'COMPLETED' && event.payload?.cycle > 0);
  return [
    { text: audit ? audit.passed ? 'AUDIT PASSED' : 'AUDIT FAILED' : seen('run_excel_reconciliation') ? 'EXECUTED' : 'AWAITING RUN', tone: audit?.passed === false ? 'negative' : audit?.passed === true ? 'positive' : 'neutral' },
    { text: metrics.default_probability != null ? metrics.passed ? 'RISK PASSED' : 'REVIEW REQUIRED' : 'AWAITING INFERENCE', tone: metrics.default_probability != null ? metrics.passed ? 'positive' : 'warning' : 'neutral' },
    { text: repairs.length ? `${new Set(repairs.map((event) => event.payload.cycle)).size} REPAIR CYCLES OBSERVED` : 'NOT TRIGGERED', tone: repairs.length ? 'warning' : 'neutral' },
    { text: metrics.self_check?.verified === true ? 'BACKEND VERIFIED' : 'AWAITING SELF-CHECK', tone: metrics.self_check?.verified === true ? 'positive' : 'neutral' },
    { text: events.length ? `${events.length} ACTUAL EVENTS` : 'AWAITING EVENTS', tone: events.length ? 'positive' : 'neutral' },
    { text: normalizeState(job?.state) === 'COMPLETED' ? `${artifactsOf(job?.artifacts).filter((item) => !/variance/i.test(item.name)).length} PUBLISHED FILES` : 'LOCKED', tone: normalizeState(job?.state) === 'COMPLETED' ? 'positive' : 'neutral' },
    { text: job?.myinvois_sources?.length ? 'SOURCES REPORTED' : config?.myinvois?.enabled ? 'CONFIGURED · NOT EXERCISED' : 'DISABLED IN THIS DEMO', tone: 'neutral' },
    { text: job?.mode === 'live' ? 'LIVE MODE · INSPECT EVENTS' : 'NOT EXECUTED IN DEMO', tone: 'neutral' },
    { text: '999 BACKEND PASSED · RECORDED', tone: 'neutral' },
  ];
}

export default function FeatureShowcase({ job, events, config, apiKey }) {
  const [expanded, setExpanded] = useState(true);
  const [evidenceState, setEvidenceState] = useState(null);
  const [hashState, setHashState] = useState(null);
  const hashAbort = useRef(null);
  const [hashBusy, setHashBusy] = useState(false);
  const [hashError, setHashError] = useState('');
  const state = normalizeState(job?.state);
  const metrics = job?.metrics || {};
  const completed = state === 'COMPLETED';
  const artifacts = artifactsOf(job?.artifacts);
  const proofArtifact = artifacts.find((item) => item.name === (completed ? 'verification_manifest.json' : 'variance_report.json'));
  const proofUrl = proofArtifact?.url;
  const scope = `${job?.id || ''}:${proofUrl || ''}`;
  const evidence = evidenceState?.scope === scope && evidenceState?.apiKey === apiKey ? evidenceState.value : null;
  const evidenceError = evidenceState?.scope === scope && evidenceState?.apiKey === apiKey ? evidenceState.error : '';
  const hashes = hashState?.scope === scope && hashState?.apiKey === apiKey ? hashState : null;
  const audit = completed ? evidence?.audit_evidence_summary : evidence;
  const decimal = completed ? evidence?.decimal_audit : null;
  const loan = decimal?.loan;
  const statuses = featureStatuses(job, events, config);
  const repairs = events.filter((event) => event.type === 'TOOL_EXECUTION' && event.payload?.tool === 'run_ocr_normalizer' && event.payload?.cycle > 0);
  const auditEvents = events.filter((event) => event.type === 'METRICS' && typeof event.payload?.passed === 'boolean' && !('default_probability' in event.payload));
  const latestAudit = auditEvents.at(-1)?.payload;

  useEffect(() => {
    const controller = new AbortController();
    setHashError('');
    if (proofUrl) readArtifact(proofUrl, apiKey, controller.signal).then((bytes) => {
      const value = JSON.parse(new TextDecoder().decode(bytes));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid evidence document.');
      setEvidenceState({ scope, apiKey, value });
    }).catch((error) => {
      if (error.name !== 'AbortError') setEvidenceState({ scope, apiKey, value: null, error: error.message });
    });
    return () => controller.abort();
  }, [scope, proofUrl, apiKey]);

  useEffect(() => { setHashBusy(false); setHashError(''); }, [scope, apiKey]);
  useEffect(() => () => { hashAbort.current?.abort(); }, []);

  async function verifyPayloads() {
    if (!Array.isArray(evidence?.outputs) || hashBusy || !window.crypto?.subtle) return;
    hashAbort.current?.abort();
    const controller = new AbortController();
    hashAbort.current = controller;
    setHashBusy(true);
    setHashState(null);
    setHashError('');
    const digest = async (buffer) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)), (byte) => byte.toString(16).padStart(2, '0')).join('');
    try {
      const names = evidence.outputs.map((output) => output?.name);
      if (names.length !== EXPECTED_PAYLOADS.size || new Set(names).size !== EXPECTED_PAYLOADS.size ||
          names.some((name) => !EXPECTED_PAYLOADS.has(name))) {
        throw new Error('Manifest must declare all seven unique payloads.');
      }
      const rows = [];
      let tamper = null;
      for (const output of evidence.outputs) {
        const artifact = artifacts.find((item) => item.name === output.name);
        if (!artifact || !/^[a-f0-9]{64}$/i.test(output.sha256 || '')) throw new Error('Manifest payload is not a published artifact.');
        const bytes = await readArtifact(artifact.url, apiKey, controller.signal);
        const actual = await digest(bytes);
        rows.push({ name: output.name, expected: output.sha256, actual, matches: actual === output.sha256 });
        if (tamper === null && bytes.byteLength) {
          const copy = new Uint8Array(bytes.slice(0));
          copy[0] ^= 1;
          tamper = { name: output.name, rejected: await digest(copy) !== output.sha256 };
        }
      }
      if (!controller.signal.aborted) setHashState({ scope, apiKey, rows, tamper });
    } catch (error) {
      if (!controller.signal.aborted) setHashError(error.message);
    } finally { if (!controller.signal.aborted) setHashBusy(false); }
  }

  useEffect(() => { hashAbort.current?.abort(); }, [scope, apiKey, hashAbort]);

  return <section className="showcase" aria-labelledby="features-title">
    <div className="showcase-heading"><div><span className="eyebrow">ENGINEERING EVIDENCE / NINE CAPABILITIES</span><h2 id="features-title">What is actually happening?</h2><p>Badges reflect this selected run. Expand a capability for its proof and limits.</p></div><button type="button" className="text-button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>{expanded ? 'Collapse cards' : 'Show feature cards'}<ChevronDown size={14} /></button></div>
    {expanded && <div className="feature-grid">{FEATURES.map((feature, index) => {
      const Icon = feature.icon;
      return <details className="panel feature-card" key={feature.title}><summary><span className="feature-number">{String(index + 1).padStart(2, '0')}<Icon size={18} /></span><h3>{feature.title}</h3><span className={`feature-status ${statuses[index].tone}`}>{statuses[index].text}</span><ChevronDown size={13} className="feature-expand" /></summary><div className="feature-description"><p>{feature.detail}</p><strong>How to prove it</strong><p>{feature.proof}</p></div></details>;
    })}</div>}
    <div className="showcase-evidence-grid">
      <section className="panel proof-panel"><span className="eyebrow">01 / EXACT ARITHMETIC & DELIVERY</span><h3>Separate the gates.</h3><div className="showcase-gates"><Gate label="Monetary parity" value={audit?.gates?.exact_money_parity} /><Gate label="Delivery & audit" value={audit?.gates?.delivery_verified} /><Gate label="Whole audit" value={audit?.passed ?? latestAudit?.passed} /></div>
        <div className="proof-values"><div><span>Invoice total</span><strong>{money(audit?.invoice_total ?? job?.decision_memo?.figures?.invoice_total)}</strong></div><div><span>Bank inflow</span><strong>{money(audit?.verified_inflow ?? job?.decision_memo?.figures?.verified_inflow)}</strong></div><div><span>Exact variance / MYR</span><strong className="mono">{audit?.variance ?? metrics.variance ?? 'Not reported'}</strong></div></div>
        {Array.isArray(decimal?.invoices) && decimal.invoices.map((invoice, index) => <div className="math-proof" key={`${invoice.invoice_id}-${index}`}><strong>{invoice.invoice_id}</strong>{invoice.lines?.map((line, i) => <code key={i}>{line.quantity} × {line.unit_price} = {line.amount} MYR</code>)}<code>{invoice.subtotal} + {invoice.tax} + {invoice.freight} − {invoice.discount} = {invoice.total}</code><code>Invoice {invoice.total} ↔ receipt {invoice.matched_inflow}</code></div>)}
        {audit?.errors?.length > 0 && <ul className="proof-errors">{audit.errors.map((error, index) => <li key={index}><strong>{error.gate?.replaceAll('_', ' ')}</strong><span>{error.invoice_id || error.transaction_id || ''}{error.delta != null ? ` · delta ${error.delta} MYR` : ''}{error.field ? ` · ${error.field}` : ''}{error.quantity_delta != null ? ` · quantity delta ${error.quantity_delta}` : ''}</span></li>)}</ul>}
        <p className="metric-note">{audit?.arithmetic || 'Gate details come from the published manifest or variance report; no missing gate is assumed to pass.'}</p>{evidenceError && <p className="inline-error">{evidenceError}</p>}
      </section>
      <section className="panel proof-panel"><span className="eyebrow">02 / MODEL INFERENCE & POLICY</span><h3>Model proposes. Policy decides.</h3><div className="showcase-gates"><Gate label="Probability ≤ 12%" value={metrics.gates?.probability_le_0_12} /><Gate label="All-in DSR ≤ 45%" value={metrics.gates?.all_in_dsr_le_0_45} /></div><div className="proof-values"><div><span>Requested bound</span><strong>{money(metrics.requested_limit)}</strong></div><div><span>Model ceiling</span><strong>{money(metrics.financing_ceiling)}</strong></div><div><span>Existing / all-in DSR</span><strong className="mono">{metrics.existing_dsr ?? '—'} / {metrics.dsr ?? '—'}</strong></div></div><p className="metric-note">{metrics.policy || 'Requested, model, invoice support and DSR capacity bounds all apply. The browser never authorizes credit.'}</p>
        {metrics.is_demo_model === true && <p className="proof-disclaimer">Real inference · synthetic training · not calibrated for real lending.</p>}
        {metrics.model_hashes && <details className="proof-details"><summary>Hash-pinned model provenance<ChevronDown size={13} /></summary>{Object.entries(metrics.model_hashes).map(([name, hash]) => <div className="hash-row" key={name}><strong>{name}</strong><code>{hash}</code></div>)}<div className="hash-row"><strong>Model manifest</strong><code>{metrics.model_manifest_sha256}</code></div><p className="metric-note">Ledger months: {metrics.feature_provenance?.months?.join(', ') || 'Not reported'}. Debt: {metrics.feature_provenance?.debt_service || 'Not reported'}</p></details>}
      </section>
      <section className="panel proof-panel"><span className="eyebrow">03 / REPAIR ATTEMPTS</span><h3>Retry the evidence—not the numbers.</h3><div className="retry-grid">{[1, 2, 3].map((cycle) => {
        const observed = repairs.filter((event) => event.payload.cycle === cycle);
        const done = observed.some((event) => event.payload.status === 'COMPLETED');
        return <div key={cycle} className={done ? 'observed' : ''}><strong>REPAIR {cycle}</strong><span>{240 + cycle * 40} DPI</span><small>{done ? 'Normalizer completed' : observed.length ? 'Normalizer started' : 'Not observed'}</small></div>;
      })}</div><p className="metric-note">{auditEvents.length} actual audit metric events received. {state === 'QUARANTINED' ? 'Budget exhausted; underwriting and settlement prohibited.' : repairs.length ? 'Observed repair activity is shown above.' : 'A passing dossier does not trigger repairs. Select the one-cent scenario to demonstrate this path.'}</p><p className="proof-disclaimer">Real PDF reslicing; embedded-text demo parsing. The last failed audit notice is exhaustion, not a fourth retry. Missing bank money is never rewritten to force parity.</p>
      </section>
      <section className="panel proof-panel"><span className="eyebrow">04 / POST-COMMIT INTEGRITY</span><h3>Verify before declaring completion.</h3><div className="showcase-gates"><Gate label="Backend self-check" value={metrics.self_check?.verified} /></div><div className="proof-values"><div><span>Payload hashes checked</span><strong>{metrics.self_check?.outputs_checked ?? '—'}</strong></div><div><span>Declared sources checked</span><strong>{metrics.self_check?.sources_checked ?? '—'}</strong></div><div><span>Settlement</span><strong>{job?.settlement || 'Not finalized'}</strong></div></div>
        {metrics.self_check && <details className="proof-details"><summary>Actual backend verification result<ChevronDown size={13} /></summary><pre>{redact(metrics.self_check, apiKey)}</pre></details>}
        {completed && evidence && <><button type="button" className="secondary-button" onClick={verifyPayloads} disabled={hashBusy || !window.crypto?.subtle}>{hashBusy ? <LoaderCircle size={15} className="spin" /> : <ShieldCheck size={15} />}Re-hash payloads & test a modified copy</button><p className="metric-note">Downloads stay in memory. We flip one byte in a separate buffer; the server files and original download are not modified.</p></>}
        {hashError && <p className="inline-error">{hashError}</p>}{hashes && <div className="hash-results"><Gate label="Downloaded payloads match manifest" value={hashes.rows.length > 0 && hashes.rows.every((row) => row.matches)} /><Gate label="Modified in-memory copy rejected" value={hashes.tamper?.rejected} /><p className="metric-note">{hashes.rows.filter((row) => row.matches).length} / {hashes.rows.length} SHA-256 matches. This checks bytes against the supplied manifest—not signatures or independent source authenticity.</p>{hashes.rows.map((row) => <div className="hash-row" key={row.name}><strong className={row.matches ? 'positive' : 'negative'}>{row.name} · {row.matches ? 'MATCH' : 'MISMATCH'}</strong><code>{row.actual}</code></div>)}</div>}
      </section>
    </div>
    {loan && <section className="panel proof-panel repayment-panel"><span className="eyebrow">05 / DECIMAL REPAYMENT EVIDENCE</span><h3>Every cent has a place.</h3><div className="proof-values"><div><span>Principal</span><strong>{money(loan.principal)}</strong></div><div><span>Total interest</span><strong>{money(loan.total_interest)}</strong></div><div><span>Total repayment</span><strong>{money(loan.total_repayment)}</strong></div></div><div className="proof-table-wrap"><table className="proof-table"><thead><tr><th>Period</th><th>Opening</th><th>Principal</th><th>Interest</th><th>Payment</th><th>Closing</th></tr></thead><tbody>{loan.repayments?.map((row) => <tr key={row.period}><td>{row.period}</td><td>{row.opening_balance}</td><td>{row.principal}</td><td>{row.interest}</td><td>{row.payment}</td><td>{row.closing_balance}</td></tr>)}</tbody></table></div><p className="metric-note">Backend-generated Decimal strings in MYR, flat simple interest. The last installment conserves residual cents. Inspect all seven workbook sheets: Loan, InvoiceLines, Invoices, Bank, Repayments, Controls, DecimalAudit.</p></section>}
    {completed && Array.isArray(evidence?.sources) && <details className="panel proof-panel proof-details"><summary>Manifest source & output inventory<ChevronDown size={15} /></summary><p className="metric-note">Reported source hashes—not independently verified in the browser. Standalone verification: scripts/verify_manifest.py. Demo keys are not legal identities or external trust anchors.</p>{[...evidence.sources, ...(evidence.outputs || [])].map((item) => <div className="hash-row" key={item.name}><strong>{item.name}</strong><code>{item.sha256}</code></div>)}</details>}
  </section>;
}
