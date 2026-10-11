const API_ROOT = '/api/v2';

export function authHeaders(apiKey) {
  return apiKey ? { 'X-API-Key': apiKey } : {};
}

export async function requestJson(path, { apiKey = '', signal, ...options } = {}) {
  const response = await fetch(`${API_ROOT}${path}`, {
    ...options,
    signal,
    credentials: 'same-origin',
    redirect: 'error',
    headers: { ...authHeaders(apiKey), ...options.headers },
  });
  if (!response.ok) {
    // Never include server response text: it could echo an operator credential.
    if (response.status === 401 || response.status === 403) {
      throw new Error('Access denied. Check the operator API key and retry.');
    }
    throw new Error(`Request failed (HTTP ${response.status}).`);
  }
  return response.json();
}

export function getJob(jobId, apiKey, signal) {
  return requestJson(`/jobs/${encodeURIComponent(jobId)}`, { apiKey, signal });
}

export function submitBatch(files, terms, apiKey, signal) {
  const body = new FormData();
  files.forEach((file) => body.append('files', file, file.name));
  body.append('requested_limit', terms.requested_limit);
  body.append('duration_months', String(terms.duration_months));
  body.append('annual_rate', terms.annual_rate);
  body.append('monthly_debt_service', terms.monthly_debt_service);
  if (terms.myinvois_document_ids) body.append('myinvois_document_ids', terms.myinvois_document_ids);
  return requestJson('/underwrite/batch', { method: 'POST', body, apiKey, signal });
}

// One action, end-to-end: the backend stages its generated synthetic dossier
// with the canonical demo terms. No files or credentials leave the browser.
export function runDemo(apiKey, signal, scenario = 'approval') {
  const body = new FormData();
  body.append('scenario', scenario);
  return requestJson('/demo-run', { method: 'POST', body, apiKey, signal });
}

export async function downloadBlob(path, filename, apiKey = '', signal) {
  const url = new URL(path, window.location.origin);
  // Protected artifact URLs must stay same-origin so the key cannot leak to a host
  // supplied by event payloads. Vite proxies /api to the underwriting backend.
  if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) {
    throw new Error('Download blocked: the backend must provide a same-origin /api/ URL.');
  }
  const response = await fetch(url, {
    headers: authHeaders(apiKey),
    credentials: 'same-origin',
    redirect: 'error',
    signal,
  });
  if (!response.ok) {
    throw new Error(`Download failed (HTTP ${response.status}). Check access and retry.`);
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename.replace(/[\\/\x00-\x1f]/g, '_');
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

export async function readArtifact(path, apiKey, signal) {
  const url = new URL(path, window.location.origin);
  if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) {
    throw new Error('Evidence inspection requires a same-origin /api/ URL.');
  }
  const response = await fetch(url, {
    headers: authHeaders(apiKey), signal, credentials: 'same-origin', redirect: 'error', cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Evidence inspection failed (HTTP ${response.status}).`);
  return response.arrayBuffer();
}

export const DEMO_DOSSIER_URL = `${API_ROOT}/demo-dossier`;
