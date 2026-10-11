import assert from 'node:assert/strict';
import test from 'node:test';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { applyEvent } from './src/hooks/useAgentStream.js';
import { readArtifact } from './src/api.js';

const require = createRequire(import.meta.url);
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const compiled = await build({
  entryPoints: [fileURLToPath(new URL('./src/FeatureShowcase.jsx', import.meta.url))],
  bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic', external: ['react', 'react/jsx-runtime'],
});
const filename = fileURLToPath(new URL('./src/showcase-test-bundle.cjs', import.meta.url));
const bundled = new Module(filename);
bundled.filename = filename;
bundled.paths = require.resolve.paths('react');
bundled._compile(compiled.outputFiles[0].text, filename);
const { default: FeatureShowcase, featureStatuses } = bundled.exports;

const event = (type, payload) => ({ type, payload, job_id: 'synthetic-job' });

test('replayed audit PASS cannot overwrite a failed credit verdict', () => {
  const current = { id: 'synthetic-job', state: 'REVIEW_REQUIRED', metrics: {
    default_probability: '0.1', passed: false, dsr: '0.5', approved_limit: '0.00',
  } };
  const next = applyEvent(current, event('METRICS', { variance: '0.00', passed: true }));
  assert.equal(next.metrics.passed, false);
  assert.equal(featureStatuses(next, [event('METRICS', { variance: '0.00', passed: true })], {})[1].text, 'REVIEW REQUIRED');
});

test('new risk verdict replaces audit verdict and self-check preserves it', () => {
  let job = applyEvent(null, event('METRICS', { variance: '0.00', passed: true }));
  job = applyEvent(job, event('METRICS', { default_probability: '0.2', passed: false }));
  job = applyEvent(job, event('METRICS', { self_check: { verified: true } }));
  assert.equal(job.metrics.passed, false);
});

test('missing evidence and a completed state do not imply verification', () => {
  const statuses = featureStatuses({ state: 'COMPLETED', metrics: {} }, [], { mode: 'demo' });
  assert.equal(statuses[0].text, 'AWAITING RUN');
  assert.equal(statuses[3].text, 'AWAITING SELF-CHECK');
  assert.equal(statuses[7].text, 'NOT EXECUTED IN DEMO');
});

test('zero variance with failed delivery remains AUDIT FAILED', () => {
  const statuses = featureStatuses({ metrics: { variance: '0' } }, [event('METRICS', { variance: '0', passed: false })], {});
  assert.equal(statuses[0].text, 'AUDIT FAILED');
  assert.equal(statuses[0].tone, 'negative');
});

test('repair cycles are distinct and not counted per PDF', () => {
  const events = [1, 1, 2, 2, 3, 3].map((cycle) => event('TOOL_EXECUTION', {
    tool: 'run_ocr_normalizer', cycle, status: 'COMPLETED',
  }));
  assert.equal(featureStatuses({}, events, {})[2].text, '3 REPAIR CYCLES OBSERVED');
});

test('idle showcase renders nine capabilities without invented metrics', () => {
  const html = renderToStaticMarkup(createElement(FeatureShowcase, {
    job: null, events: [], config: { mode: 'demo' }, apiKey: '',
  }));
  assert.equal((html.match(/class="panel feature-card"/g) || []).length, 9);
  assert.match(html, /NOT REPORTED/);
  assert.doesNotMatch(html, /BACKEND VERIFIED/);
  assert.doesNotMatch(html, /AUDIT PASSED/);
});

test('protected evidence reader blocks credential leakage to external URLs', async () => {
  const prior = globalThis.window;
  globalThis.window = { location: { origin: 'http://127.0.0.1:8000' } };
  try {
    await assert.rejects(readArtifact('https://example.com/api/steal', 'synthetic-key'), /same-origin/);
    await assert.rejects(readArtifact('/not-api', 'synthetic-key'), /same-origin/);
  } finally { globalThis.window = prior; }
});
