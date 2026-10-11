// Reproducible API/stream smoke check against an already-running local demo.
// This does not drive the browser, change policy, call live providers or move funds.
// Run from the repository root: node outputs/verify-showcase.cjs
// OUT_IN_API_KEY must contain the local operator key when required.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const base = 'http://127.0.0.1:8000';
const apiKey = process.env.OUT_IN_API_KEY || '';
const headers = apiKey ? { 'X-API-Key': apiKey } : {};
const report = { scope: 'local API, recorded WebSocket replay and payload hashes', synthetic_inputs: true, scenarios: [], success: false };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const expectedNames = new Set(['MasterLedger.xlsx', 'Out_In_TNC_Agreement.pdf', 'demo_public_key.pem', 'demo_borrower_public_key.pem', 'demo_lender_public_key.pem', 'borrower_attestation.sig', 'lender_attestation.sig']);
async function request(url, options = {}) {
  const target = new URL(url, base);
  assert.equal(target.origin, base, 'Requests must stay on the local demo origin');
  assert.ok(target.pathname.startsWith('/api/'), 'Requests must target the API');
  const response = await fetch(target, { ...options, headers, redirect: 'error', signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Local API request failed (HTTP ${response.status})`);
  return response;
}
const json = async (url, options) => (await request(url, options)).json();
async function replay(run) {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/v2/agent-stream', base);
    url.protocol = 'ws:';
    url.searchParams.set('job_id', run.job_id);
    url.searchParams.set('token', run.stream_token);
    url.searchParams.set('after', '0');
    const socket = new WebSocket(url);
    const events = [];
    let terminal = false;
    const timer = setTimeout(() => { socket.close(); reject(new Error('Job stream exceeded the 120-second budget')); }, 120000);
    socket.addEventListener('message', message => {
      const event = JSON.parse(message.data);
      assert.equal(event.job_id, run.job_id);
      events.push(event);
      if (event.type === 'STATE_TRANSITION' && ['COMPLETED', 'REVIEW_REQUIRED', 'QUARANTINED', 'FAILED'].includes(event.payload?.state)) terminal = true;
    });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Local WebSocket replay failed')); });
    socket.addEventListener('close', () => {
      clearTimeout(timer);
      if (terminal) resolve(events);
      else reject(new Error('Stream closed before a terminal transition'));
    });
  });
}
async function main() {
  report.health = await json('/api/v2/health');
  assert.equal(report.health.mode, 'demo');
  assert.equal(report.health.real_funds, false);
  report.real_funds = false;
  const fixtureRoot = path.join(__dirname, 'out-in', 'demo', 'dossier');
  const fixtureHashes = () => Object.fromEntries(['invoice.pdf', 'packing_list.pdf', 'statement.xlsx'].map(name => [name, digest(readFileSync(path.join(fixtureRoot, name)))]));
  const originals = fixtureHashes();
  let approval;
  for (const scenario of ['approval', 'risk_review', 'parity_mismatch']) {
    const body = new FormData();
    body.append('scenario', scenario);
    const run = await json('/api/v2/demo-run', { method: 'POST', body });
    const events = await replay(run);
    const job = await json(`/api/v2/jobs/${run.job_id}`);
    const audit = events.filter(event => event.type === 'METRICS' && typeof event.payload?.passed === 'boolean' && !('default_probability' in event.payload)).at(-1)?.payload;
    const row = { scenario, job_id: run.job_id, state: job.state, events: events.length, audit_passed: audit?.passed, variance: job.metrics?.variance, artifact_count: job.artifacts?.length || 0 };
    assert.ok(events.every((event, index) => index === 0 || event.seq > events[index - 1].seq));
    row.previous_hash_links_match = events.slice(1).every((event, index) => event.previous_hash === events[index].sha256);
    assert.ok(row.previous_hash_links_match);
    if (scenario === 'approval') {
      assert.equal(job.state, 'COMPLETED');
      assert.equal(audit.passed, true);
      assert.equal(job.artifacts.length, 9);
      assert.equal(job.metrics.self_check.verified, true);
      assert.equal(job.metrics.self_check.outputs_checked, 7);
      const manifestArtifact = job.artifacts.find(item => item.name === 'verification_manifest.json');
      const manifest = await json(manifestArtifact.url);
      assert.equal(manifest.real_funds, false);
      assert.equal(manifest.outputs.length, expectedNames.size);
      assert.equal(new Set(manifest.outputs.map(item => item.name)).size, expectedNames.size);
      row.payloads_checked = 0;
      for (const output of manifest.outputs) {
        assert.ok(expectedNames.has(output.name));
        const artifact = job.artifacts.find(item => item.name === output.name);
        assert.ok(artifact);
        const bytes = Buffer.from(await (await request(artifact.url)).arrayBuffer());
        assert.equal(digest(bytes), output.sha256);
        const copy = Buffer.from(bytes);
        assert.ok(copy.length > 0);
        copy[0] ^= 1;
        assert.notEqual(digest(copy), output.sha256);
        row.payloads_checked++;
      }
      row.modified_copies_rejected = true;
      row.repayment_rows = manifest.decimal_audit.loan.repayments.length;
      assert.equal(row.repayment_rows, 12);
      approval = run;
    } else if (scenario === 'risk_review') {
      assert.equal(job.state, 'REVIEW_REQUIRED');
      assert.equal(audit.passed, true);
      assert.equal(job.metrics.passed, false);
      assert.equal(job.metrics.gates.all_in_dsr_le_0_45, false);
      assert.equal(row.artifact_count, 0);
      row.risk_gates = job.metrics.gates;
    } else {
      assert.equal(job.state, 'QUARANTINED');
      assert.equal(audit.passed, false);
      assert.equal(job.metrics.variance, '0.01');
      const repairs = events.filter(event => event.type === 'TOOL_EXECUTION' && event.payload?.tool === 'run_ocr_normalizer' && event.payload?.status === 'COMPLETED' && event.payload?.cycle > 0);
      row.repair_cycles = [...new Set(repairs.map(event => event.payload.cycle))].sort();
      assert.deepEqual(row.repair_cycles, [1, 2, 3]);
      row.audit_attempts = events.filter(event => event.type === 'METRICS' && typeof event.payload?.passed === 'boolean').length;
      assert.equal(row.audit_attempts, 4);
      assert.ok(!events.some(event => event.payload?.tool === 'evaluate_credit_ml'));
      assert.ok(!job.artifacts.some(item => item.name === 'verification_manifest.json'));
    }
    report.scenarios.push(row);
  }
  const historical = await replay(approval);
  report.completed_history_replay = { job_id: approval.job_id, events: historical.length, terminal_state: historical.at(-1).payload.state };
  assert.equal(historical.at(-1).payload.state, 'COMPLETED');
  assert.deepEqual(fixtureHashes(), originals);
  report.original_fixtures_unchanged = true;
  report.limitations = ['Synthetic inputs and models; simulation only.', 'This script checks API and stream replay, not browser rendering.', 'Hash-link comparison is not event digest verification or external anchoring.', 'Payload checks do not independently authenticate providers or legal identities.'];
  report.success = true;
}
main().catch(error => { report.error = error.message; process.exitCode = 1; }).finally(() => {
  writeFileSync(path.join(__dirname, 'showcase-validation.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
});
