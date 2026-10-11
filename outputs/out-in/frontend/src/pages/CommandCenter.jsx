import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, ArrowDownToLine, ArrowRight, ArrowUpRight, Check, ChevronDown, Circle, Clock3, FileText, FolderLock, History, LoaderCircle, Play, RefreshCw, RotateCcw, ScanLine, ShieldCheck, UploadCloud, X } from 'lucide-react';
import { useOperator } from '../App.jsx';
import { DEMO_DOSSIER_URL, downloadBlob, runDemo, submitBatch } from '../api.js';
import { ArtifactButton, Notice, RiskGauge, StateBadge } from '../components.jsx';
import useAgentStream from '../hooks/useAgentStream.js';
import FeatureShowcase, { DemoLauncher } from '../FeatureShowcase.jsx';
import { artifactsOf, isQuarantined, isTerminal, isVarianceReport, money, normalizeState, numberOrNull, percent, redact, varianceStatus } from '../model.js';

const MIB = 1024 * 1024;
const MAX_FILES = 20;
const MAX_FILE_SIZE = 20 * MIB;
const MAX_TOTAL_SIZE = 50 * MIB;
const STAGES = [
  { title: 'Evidence intake', caption: 'Parallel extract & normalize', icon: FileText, match: /ingest|intake|extract|parse|document|upload/i },
  { title: 'Reconciliation', caption: 'Verify every number', icon: ScanLine, match: /reconcil|variance|audit|verif/i },
  { title: 'Risk assessment', caption: 'Model credit exposure', icon: ShieldCheck, match: /risk|score|underwrit|assess/i },
  { title: 'Decision package', caption: 'Seal & self-verify evidence', icon: FolderLock, match: /decision|package|artifact|report|finaliz|complet/i },
];

function stageFor(text) {
  // Bundle verification belongs to packaging, not financial reconciliation.
  if (/verify_bundle_integrity|compile_tnc_agreement|SETTLING|COMPLETED/i.test(text || '')) return 3;
  if (/SELF_HEALING/i.test(text || '')) return 0;
  return STAGES.findIndex((stage) => stage.match.test(text || ''));
}

function Dag({ job, events }) {
  const state = normalizeState(job?.state);
  const latestActivity = [...events].reverse().find((event) => ['TOOL_EXECUTION', 'STATE_TRANSITION', 'ROLLBACK_TRIGGERED'].includes(event.type));
  const activityText = latestActivity?.type === 'ROLLBACK_TRIGGERED' ? 'reconciliation' :
    `${latestActivity?.payload?.agent || ''} ${latestActivity?.payload?.tool || ''} ${latestActivity?.payload?.state || ''}`;
  const current = stageFor(activityText);
  const fallback = stageFor(`${job?.agent || ''} ${state}`);
  const activeIndex = current >= 0 ? current : fallback;
  const completed = state === 'COMPLETED';
  const terminal = isTerminal(state);
  const rollback = job?.rollback;
  const rollbackActive = rollback && !completed;
  return (
    <section className="panel pipeline-panel" aria-labelledby="pipeline-title">
      <div className="panel-heading"><div><span className="eyebrow">THE AUTONOMOUS WORKFLOW</span><h2 id="pipeline-title">Four stages. One chain of evidence.</h2></div><span className="subtle-chip"><Activity size={13} />LINEAR DAG</span></div>
      <div className="dag-stages">
        {STAGES.map((stage, index) => {
          const Icon = stage.icon;
          const isActive = !terminal && index === activeIndex;
          const matchingTool = [...events].reverse().find((event) => event.type === 'TOOL_EXECUTION' && stageFor(`${event.payload?.agent} ${event.payload?.tool}`) === index);
          const toolStatus = String(matchingTool?.payload?.status || '').toUpperCase();
          const status = completed ? 'COMPLETE' : isActive ? 'ACTIVE' : toolStatus || (job ? 'NOT REPORTED' : 'WAITING');
          return <div key={stage.title} className={`dag-stage ${isActive ? 'stage-active' : ''} ${completed ? 'stage-complete' : ''}`}>
            <div className="stage-top"><span className="stage-number">0{index + 1}</span><span className="stage-symbol">{completed ? <Check size={19} /> : <Icon size={19} />}</span></div>
            <h3>{stage.title}</h3><p>{stage.caption}</p><span className="stage-state"><span className="status-dot" />{status}</span>
            {index < 3 && <ArrowRight size={17} className="dag-forward" aria-hidden="true" />}
          </div>;
        })}
      </div>
      <div className={`feedback-loop ${rollbackActive ? 'rollback-active' : ''}`}>
        <svg viewBox="0 0 800 40" preserveAspectRatio="none" aria-hidden="true"><path d="M700 0 V22 Q700 32 690 32 H310 Q300 32 300 22 V8" /><path d="M294 15 L300 8 L306 15" /></svg>
        <span><RotateCcw size={12} />{rollback ? Number(rollback.cycle) > 3 ? 'FOURTH FAILED AUDIT · REPAIR BUDGET EXHAUSTED' : `FAILED AUDIT ${rollback.cycle ?? 'NOT REPORTED'} · RETURN TO EVIDENCE` : 'AUDIT FAILURE → RETURN TO EVIDENCE'}</span>
      </div>
      <div className="pipeline-footnote"><span className="status-dot" />Stage activity is mapped from backend state, agent and tool events. Dossier PDFs normalize in parallel; committed bundles are self-verified before COMPLETED. Unknown stages remain unverified.</div>
    </section>
  );
}

const NARRATIVE_SOURCES = {
  deterministic: 'DETERMINISTIC EXPLAINER',
  sdk_agent: 'WORKBUDDY NARRATIVE AGENT',
  deterministic_fallback: 'DETERMINISTIC FALLBACK',
};

function DecisionMemo({ memo }) {
  if (!memo || typeof memo.headline !== 'string') return null;
  const reasons = Array.isArray(memo.reasons) ? memo.reasons.filter((r) => typeof r === 'string') : [];
  const steps = Array.isArray(memo.next_steps) ? memo.next_steps.filter((s) => typeof s === 'string') : [];
  const source = NARRATIVE_SOURCES[memo.narrative_source] || 'SOURCE NOT REPORTED';
  return (
    <section className="panel memo-panel" aria-labelledby="memo-title">
      <div className="panel-heading"><div><span className="eyebrow">PLAIN-LANGUAGE DECISION MEMO</span><h2 id="memo-title">{memo.headline}</h2></div><span className="subtle-chip"><FileText size={13} />{source}</span></div>
      <p className="memo-summary">{typeof memo.summary === 'string' ? memo.summary : ''}</p>
      {reasons.length > 0 && <ol className="memo-list">{reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ol>}
      {steps.length > 0 && <div className="memo-steps"><span className="eyebrow">NEXT STEPS</span><ul className="memo-list">{steps.map((step, index) => <li key={index}>{step}</li>)}</ul></div>}
      <p className="metric-note">{memo.authority || 'Deterministic gates decide outcomes.'} {memo.disclaimer || ''}</p>
    </section>
  );
}

function Telemetry({ events, sequence, apiKey }) {
  const missingHashes = events.some((event) => !/^[a-f0-9]{64}$/i.test(event.sha256 || '') || !/^[a-f0-9]{64}$/i.test(event.previous_hash || ''));
  const linksMatch = !missingHashes && events.slice(1).every((event, index) => event.previous_hash === events[index].sha256);
  const chainScope = events[0]?.previous_hash === '0'.repeat(64) ? 'FROM GENESIS' : 'RECEIVED SEGMENT ONLY';
  return (
    <details className="panel telemetry-panel">
      <summary><span className="telemetry-label"><Activity size={18} /><span><strong>Audit telemetry</strong><small>Tool executions, state transitions & rollback evidence</small></span></span><span className="telemetry-meta">{events.length} EVENTS<span className="mono">SEQ {sequence}</span><ChevronDown size={17} /></span></summary>
      <div className="telemetry-content">
        <p className="metric-note">Last 300 non-heartbeat events, in memory only. Sensitive fields are redacted. The server snapshot is the source of truth. Sequence numbers are global across jobs; gaps alone do not prove missing job events.</p>
        {events.length > 0 && <p className={`metric-note ${linksMatch ? 'positive' : 'warning'}`}>{linksMatch ? 'PREVIOUS-HASH LINKS MATCH' : 'CHAIN LINKS UNVERIFIED / MISMATCH'} · {chainScope}. Link comparison only; digests and signatures are not independently verified here, and the local chain has no external anchor.</p>}
        {events.length === 0 ? <div className="empty-inline">No audit events received for this run.</div> :
          <ol className="event-list">{[...events].reverse().map((event) => <li key={event.seq}>
            <div className="event-line"><span className="event-seq">#{event.seq}</span><span className={`event-type ${event.type === 'ROLLBACK_TRIGGERED' ? 'negative' : ''}`}>{event.type.replaceAll('_', ' ')}</span><time dateTime={event.timestamp}>{event.timestamp && !Number.isNaN(Date.parse(event.timestamp)) ? new Date(event.timestamp).toLocaleTimeString() : 'Time not reported'}</time></div>
            <div className="event-hashes"><span>SHA-256 <code>{event.sha256 || 'Not reported'}</code></span><span>Previous <code>{event.previous_hash || 'Not reported'}</code></span></div><pre>{redact(event.payload, apiKey)}</pre>
          </li>)}</ol>}
      </div>
    </details>
  );
}

function LoanField({ label, name, value, onChange, min, max, step = '0.01', suffix, disabled }) {
  return <label className="loan-field"><span>{label}</span><div className="input-with-unit"><input name={name} type="number" value={value} onChange={onChange} required min={min} max={max} step={step} disabled={disabled} /><span>{suffix}</span></div></label>;
}

export default function CommandCenter() {
  const { apiKey, config, configLoading, configError, retryConfig, history, selectedRun, setSelectedRun, rememberRun, storageError } = useOperator();
  const stream = useAgentStream(selectedRun, apiKey);
  const { job, events, connection, error, sequence, reconnect, refresh } = stream;
  const [files, setFiles] = useState([]);
  const [terms, setTerms] = useState({ requested_limit: '', duration_months: '12', annual_rate: '', monthly_debt_service: '' });
  const [uploadError, setUploadError] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);
  const [demoError, setDemoError] = useState('');
  const [demoRunBusy, setDemoRunBusy] = useState(false);
  const [demoScenario, setDemoScenario] = useState('approval');
  const demoLock = useRef(false);
  const fileInput = useRef(null);
  const submission = useRef(null);
  const submitLock = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; submission.current?.abort(); };
  }, []);

  const terminal = isTerminal(job?.state);
  const activeRun = Boolean(selectedRun && (job?.id !== selectedRun.job_id || !terminal));
  const busy = submitting || activeRun;
  const keyMissing = Boolean(config?.api_key_required && !apiKey);
  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  const metrics = job?.metrics || {};
  const variance = varianceStatus(metrics.variance);
  const auditEvent = events.filter((event) => event.type === 'METRICS' && typeof event.payload?.passed === 'boolean' && !('default_probability' in event.payload)).at(-1);
  const reportedPassed = typeof auditEvent?.payload?.passed === 'boolean' ? auditEvent.payload.passed ? 'PASS' : 'FAIL' : 'UNKNOWN';
  const dsr = numberOrNull(metrics.dsr);
  const artifacts = artifactsOf(job?.artifacts);
  const varianceReports = artifacts.filter(isVarianceReport);
  const vaultArtifacts = artifacts.filter((artifact) => !isVarianceReport(artifact));
  const completed = normalizeState(job?.state) === 'COMPLETED';
  const quarantined = normalizeState(job?.state) === 'QUARANTINED';
  const reviewRequired = isQuarantined(job?.state) && !quarantined;

  function addFiles(incoming) {
    if (busy) return;
    setUploadError('');
    const combined = [...files];
    for (const file of incoming) {
      if (!combined.some((existing) => existing.name === file.name && existing.size === file.size && existing.lastModified === file.lastModified)) combined.push(file);
    }
    const invalid = combined.find((file) => !/\.(pdf|xlsx|csv)$/i.test(file.name));
    if (invalid) return setUploadError(`Unsupported file: ${invalid.name}. Use PDF, XLSX or CSV.`);
    const oversized = combined.find((file) => file.size > MAX_FILE_SIZE);
    if (oversized) return setUploadError(`${oversized.name} exceeds the 20 MiB per-file limit.`);
    if (combined.length > MAX_FILES) return setUploadError('A dossier can contain at most 20 files.');
    if (combined.reduce((sum, file) => sum + file.size, 0) > MAX_TOTAL_SIZE) return setUploadError('The dossier exceeds the 50 MiB total limit.');
    setFiles(combined);
  }

  function updateTerm(event) {
    setTerms((previous) => ({ ...previous, [event.target.name]: event.target.value }));
  }

  async function execute(event) {
    event.preventDefault();
    if (submitLock.current || busy || !config || keyMissing || files.length === 0) return;
    if (numberOrNull(terms.requested_limit) === null || Number(terms.requested_limit) <= 0 ||
      !Number.isInteger(Number(terms.duration_months)) || Number(terms.duration_months) < 1 ||
      numberOrNull(terms.annual_rate) === null || Number(terms.annual_rate) < 0 || Number(terms.annual_rate) > 1 ||
      numberOrNull(terms.monthly_debt_service) === null || Number(terms.monthly_debt_service) < 0) {
      setSubmitError('Enter a positive MYR limit, a whole-number duration, a decimal annual rate between 0 and 1, and non-negative monthly debt service.');
      return;
    }
    submitLock.current = true;
    setSubmitting(true);
    setSubmitError('');
    const controller = new AbortController();
    submission.current = controller;
    try {
      const response = await submitBatch(files, terms, apiKey, controller.signal);
      if (!response || typeof response.job_id !== 'string' || !response.job_id ||
        typeof response.stream_token !== 'string' || !response.stream_token || typeof response.state !== 'string') {
        throw new Error('The backend did not return a valid job id, stream token and state.');
      }
      if (mounted.current) rememberRun(response);
    } catch (reason) {
      if (mounted.current && reason.name !== 'AbortError') {
        setSubmitError(`${reason.message} If the connection dropped after submission, check the backend before resubmitting; the request is not retried automatically.`);
      }
    } finally {
      submitLock.current = false;
      if (mounted.current) setSubmitting(false);
    }
  }

  async function downloadDemo() {
    setDemoBusy(true);
    setDemoError('');
    try { await downloadBlob(DEMO_DOSSIER_URL, 'out-in-demo-dossier.zip'); }
    catch (reason) { if (mounted.current) setDemoError(reason.message); }
    finally { if (mounted.current) setDemoBusy(false); }
  }

  async function executeDemo() {
    if (demoLock.current || demoRunBusy || busy || keyMissing || config?.mode !== 'demo') return;
    demoLock.current = true;
    setDemoRunBusy(true);
    setDemoError('');
    try {
      const response = await runDemo(apiKey, undefined, demoScenario);
      if (!response || typeof response.job_id !== 'string' || !response.job_id ||
        typeof response.stream_token !== 'string' || !response.stream_token) {
        throw new Error('The backend did not return a valid job id and stream token.');
      }
      if (mounted.current) rememberRun(response);
    } catch (reason) {
      if (mounted.current) setDemoError(reason.message);
    } finally { demoLock.current = false; if (mounted.current) setDemoRunBusy(false); }
  }

  return (
    <main className="main-content">
      <section className="page-heading">
        <div><span className="eyebrow">OUT&IN / CREDIT INTELLIGENCE</span><h1>Mission control<span className="heading-dot">.</span></h1><p>From financial evidence to a defensible credit decision.</p></div>
        <div className="heading-actions">
          <button type="button" className="secondary-button dossier-button" onClick={downloadDemo} disabled={demoBusy}>{demoBusy ? <LoaderCircle size={16} className="spin" /> : <ArrowDownToLine size={16} />}Download demo dossier<ArrowUpRight size={14} /></button>
          <button type="button" className="secondary-button dossier-button" onClick={executeDemo} disabled={demoRunBusy || busy || keyMissing || config?.mode !== 'demo'} title="Runs the selected synthetic scenario through the unchanged deterministic engine and safety gates.">{demoRunBusy ? <LoaderCircle size={16} className="spin" /> : <Play size={16} fill="currentColor" />}Run selected scenario<ArrowRight size={14} /></button>
        </div>
      </section>
      {configError && <Notice action={<button className="text-button" onClick={retryConfig}>Retry configuration</button>}>{configError}</Notice>}
      {demoError && <Notice>{demoError}</Notice>}
      {storageError && <Notice tone="warning">{storageError}</Notice>}
      {keyMissing && <Notice tone="warning">This backend requires an API key. Enter it in the operator field above. It will never be persisted.</Notice>}
      <DemoLauncher onRun={executeDemo} busy={demoRunBusy || busy} disabled={keyMissing || config?.mode !== 'demo'} scenario={demoScenario} setScenario={setDemoScenario} />

      <div className="command-grid">
        <section className="panel intake-panel">
          <div className="panel-heading"><div><span className="eyebrow">01 / INITIATE</span><h2>Build the dossier</h2></div><UploadCloud size={19} className="muted" /></div>
          <form onSubmit={execute}>
            <label className="loan-field"><span>LHDN MyInvois document IDs (optional)</span><div className="input-with-unit"><input type="text" name="myinvois_document_ids" aria-label="LHDN MyInvois document IDs" value={terms.myinvois_document_ids || ''} onChange={updateTerm} maxLength={2000} disabled={busy || !config?.myinvois?.enabled} placeholder="Opaque IDs, separated by commas" /></div></label>
            <p className="field-help">{config?.myinvois?.enabled ? `Official ${config.myinvois.environment} retrieval uses server-side taxpayer authorization. Maximum 10 IDs.` : 'Official retrieval is disabled until the operator configures MyInvois on the live backend.'} Commercial invoice PDFs, delivery PDFs and one bank statement remain required. Tax validation is not proof of payment, delivery or financing eligibility.</p>
            <button type="button" className={`dropzone ${dragging ? 'dragging' : ''}`} disabled={busy}
              onClick={() => fileInput.current?.click()}
              onDragOver={(event) => { event.preventDefault(); if (!busy) setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => { event.preventDefault(); setDragging(false); addFiles(Array.from(event.dataTransfer.files)); }}>
              <span className="upload-symbol"><UploadCloud size={27} strokeWidth={1.5} /></span><strong>Drop financial documents here</strong><span>or click to select your evidence</span><span className="file-types"><span>PDF</span><span>XLSX</span><span>CSV</span></span>
            </button>
            <input ref={fileInput} type="file" className="sr-only" aria-label="Upload financial documents" multiple accept=".pdf,.xlsx,.csv" disabled={busy} onChange={(event) => { addFiles(Array.from(event.target.files)); event.target.value = ''; }} />
            <div className="upload-limits"><span>20 files max · 20 MiB each</span><span>50 MiB total</span></div>
            {uploadError && <p className="inline-error" role="alert">{uploadError}</p>}
            {files.length > 0 && <div className="selected-files"><div className="selected-files-heading"><strong>{files.length} files selected</strong><span>{(totalSize / MIB).toFixed(2)} / 50 MiB</span></div><ul>{files.map((file, index) => <li key={`${file.name}-${file.size}-${file.lastModified}`}><FileText size={15} /><span className="file-name" title={file.name}>{file.name}</span><small>{(file.size / MIB).toFixed(2)} MiB</small><button type="button" className="icon-button" aria-label={`Remove ${file.name}`} disabled={busy} onClick={() => setFiles((previous) => previous.filter((_, position) => position !== index))}><X size={14} /></button></li>)}</ul></div>}
            <div className="section-rule"><span>LOAN PARAMETERS</span><span>MYR DENOMINATED</span></div>
            <div className="loan-fields">
              <LoanField label="Requested limit" name="requested_limit" value={terms.requested_limit} onChange={updateTerm} min="0.01" suffix="MYR" disabled={busy} />
              <LoanField label="Duration" name="duration_months" value={terms.duration_months} onChange={updateTerm} min="1" step="1" suffix="MONTHS" disabled={busy} />
              <LoanField label="Annual rate (decimal)" name="annual_rate" value={terms.annual_rate} onChange={updateTerm} min="0" max="1" step="any" suffix="0–1" disabled={busy} />
              <LoanField label="Monthly debt service" name="monthly_debt_service" value={terms.monthly_debt_service} onChange={updateTerm} min="0" suffix="MYR" disabled={busy} />
            </div>
            <p className="field-help">Annual rate uses decimal notation: 0.12 means 12%. All monetary inputs are MYR.</p>
            {submitError && <Notice>{submitError}</Notice>}
            <button className="execute-button" type="submit" disabled={busy || configLoading || !config || keyMissing || files.length === 0}>{submitting || activeRun ? <LoaderCircle size={17} className="spin" /> : <Play size={16} fill="currentColor" />}Execute Autonomous Underwriting<ArrowRight size={17} /></button>
            <p className="execute-note"><ShieldCheck size={12} />{submitting ? 'Submitting dossier. No automatic request retry.' : activeRun ? 'A selected run is unresolved. Reconcile it before executing again.' : 'Evidence-driven execution. No disbursement.'}</p>
          </form>
        </section>

        <div className="monitor-column">
          <section className="run-bar panel">
            <div className="run-identity"><span className={`live-indicator ${connection.status === 'connected' ? 'connected' : ''}`} /><div><span className="eyebrow">{selectedRun ? 'SELECTED RUN' : 'RUN MONITOR'}</span><strong className="mono run-id" title={selectedRun?.job_id}>{selectedRun?.job_id || 'Awaiting execution'}</strong></div></div>
            <div className="run-actions"><StateBadge state={job?.state || (selectedRun ? 'SYNCING' : 'IDLE')} /><button className="icon-button" onClick={refresh} disabled={!selectedRun} aria-label="Fetch authoritative job snapshot"><RefreshCw size={15} /></button></div>
          </section>
          <Dag job={job} events={events} />
          <section className="metrics-grid" aria-label="Live underwriting metrics">
            <div className="panel variance-panel"><span className="eyebrow">RECONCILIATION VARIANCE</span><div className="metric-heading"><h2>Exact means exact.</h2><ScanLine size={18} /></div><div className={`variance-value ${variance === 'FAIL' ? 'negative' : ''}`}>{variance === 'UNKNOWN' ? '—' : variance === 'PASS' ? '0' : String(metrics.variance)}</div><div className={`metric-status ${variance === 'PASS' ? 'positive' : variance === 'FAIL' ? 'negative' : 'neutral'}`}>{variance === 'PASS' ? <Check size={13} /> : <Circle size={11} />}{variance === 'UNKNOWN' ? 'UNKNOWN · NOT A PASS' : variance === 'PASS' ? 'ZERO MONETARY VARIANCE' : 'NONZERO VARIANCE'}</div><p className="metric-note">Money requires exactly zero variance.<br />Delivery gates must also pass.</p><div className="backend-verdict"><span>Last observed audit verdict</span><strong className={reportedPassed === 'PASS' ? 'positive' : reportedPassed === 'FAIL' ? 'negative' : 'muted'}>{reportedPassed}</strong></div></div>
            <div className="panel risk-panel"><div className="risk-heading"><span className="eyebrow">CREDIT RISK</span><ShieldCheck size={17} className="muted" /></div><RiskGauge probability={metrics.default_probability} /></div>
          </section>
          <section className="panel decision-strip" aria-label="Reported credit limits"><div><span className="eyebrow">DEBT SERVICE RATIO</span><strong>{dsr === null || dsr < 0 ? 'Not reported' : percent(dsr)}</strong><small>Backend-reported ratio</small></div><div><span className="eyebrow">PROPOSED LIMIT</span><strong>{money(metrics.proposed_limit)}</strong><small>Proposal only · not approval</small></div><div><span className="eyebrow">APPROVED LIMIT</span><strong>{money(metrics.approved_limit)}</strong><small>Backend-reported · no disbursement</small></div></section>
          {(completed || reviewRequired) && <DecisionMemo memo={job?.decision_memo} />}
          <div className="stream-status" aria-live="polite"><span className="status-dot" /><span>{connection.status.replaceAll('-', ' ').toUpperCase()}{connection.delay ? ` · RETRY ${connection.attempts}/6 IN ${connection.delay / 1000}s` : ''}</span><span className="mono">SEQ {sequence}</span>{selectedRun && <button className="text-button" onClick={reconnect}>Reconnect<RefreshCw size={12} /></button>}</div>
          {error && <Notice action={<button className="text-button" onClick={refresh}>Refresh snapshot</button>}>{error}</Notice>}
          {job?.error && <Notice>{redact(job.error, apiKey)}</Notice>}
        </div>
      </div>

      {quarantined && <section className="panel quarantine-panel"><div className="panel-heading"><div><span className="eyebrow warning">QUARANTINE / HUMAN OVERSIGHT</span><h2>Evidence held for review.</h2></div><StateBadge state={job?.state} /></div><p>Decision artifacts remain locked. Reconciliation quarantine prohibits underwriting and settlement; no automatic haircut is offered. Review the variance report and retained source evidence without altering values to force parity.</p>{varianceReports.length > 0 ? varianceReports.map((artifact) => <ArtifactButton key={artifact.url} artifact={artifact} apiKey={apiKey} />) : <div className="empty-inline">No quarantine variance report has been returned.</div>}<p className="metric-note">Quarantine is an evidence failure. The credit review queue is separate; this run cannot bypass reconciliation.</p></section>}
      {reviewRequired && <section className="panel quarantine-panel"><div className="panel-heading"><div><span className="eyebrow warning">CREDIT POLICY / HUMAN REVIEW</span><h2>Reconciled evidence. Credit not approved.</h2></div><StateBadge state={job?.state} /></div><p>A deterministic credit gate failed. No agreement, decision bundle or simulated wallet entry is created. A proposed limit is advisory only and does not authorize financing.</p><Link className="text-link" to="/admin/review">Open the credit review queue<ArrowUpRight size={15} /></Link></section>}
      <FeatureShowcase job={job} events={events} config={config} apiKey={apiKey} />
      {job?.myinvois_sources?.length > 0 && <section className="panel"><div className="panel-heading"><h2>LHDN source snapshots</h2></div><p className="metric-note">Authenticated API response snapshots, not continuous status assurance or independent verification of LHDN signatures. Sensitive invoice data: authorized operator downloads only.</p>{job.myinvois_sources.map((source) => <ArtifactButton key={source.name} artifact={{ name: source.name, url: `/api/v2/jobs/${job.id}/myinvois-sources/${encodeURIComponent(source.name.split('/').pop())}` }} apiKey={apiKey} />)}</section>}
      {completed && <section className="panel vault-panel"><div className="panel-heading"><div><span className="eyebrow">SEALED / COMPLETED RUN</span><h2>Artifact vault</h2></div><div className="heading-actions"><span className="subtle-chip"><FolderLock size={13} />{vaultArtifacts.length} ARTIFACTS</span>{metrics.self_check?.verified === true && <span className="subtle-chip self-check-chip"><ShieldCheck size={13} />SELF-CHECK VERIFIED</span>}</div></div><p className="metric-note">Available only after the backend reports COMPLETED. Downloads use your in-memory API key.{metrics.self_check?.verified === true ? ` The backend re-verified the committed bundle itself: ${metrics.self_check.outputs_checked ?? '?'} payload hashes, 3 Ed25519 signatures and ${metrics.self_check.sources_checked ?? '?'} declared sources checked.` : ''}</p>{vaultArtifacts.length > 0 ? vaultArtifacts.map((artifact) => <ArtifactButton key={artifact.url} artifact={artifact} apiKey={apiKey} />) : <div className="empty-inline">The completed snapshot contains no decision artifacts.</div>}{varianceReports.length > 0 && <details className="reconciliation-reports"><summary>Reconciliation reports<ChevronDown size={15} /></summary>{varianceReports.map((artifact) => <ArtifactButton key={artifact.url} artifact={artifact} apiKey={apiKey} />)}</details>}</section>}
      {!completed && !quarantined && !reviewRequired && <div className="vault-locked"><FolderLock size={15} /><span>Decision artifacts are locked until the run reaches COMPLETED.</span></div>}
      <Telemetry events={events} sequence={sequence} apiKey={apiKey} />
      <section className="panel history-panel"><div className="panel-heading"><div><span className="eyebrow">THIS BROWSER SESSION</span><h2><History size={18} />Run history</h2></div><span className="muted small">IDs & tokens only · {history.length} / 20</span></div>{history.length === 0 ? <div className="empty-inline"><Clock3 size={17} />Completed and active run IDs will appear here after execution. No metrics or API keys are stored.</div> : <ul className="history-list">{history.map((run, index) => <li key={run.job_id}><button disabled={submitting} className={run.job_id === selectedRun?.job_id ? 'selected' : ''} onClick={() => setSelectedRun(run)}><span className="history-number">{String(index + 1).padStart(2, '0')}</span><span className="mono">{run.job_id}</span><span className="history-action">{run.job_id === selectedRun?.job_id ? 'MONITORING' : 'OPEN RUN'}<ArrowUpRight size={14} /></span></button></li>)}</ul>}</section>
    </main>
  );
}
