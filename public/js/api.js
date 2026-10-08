// REST client. Reads the stored credential from sessionStorage and attaches it
// to every call as X-API-Key (apikey mode) or Authorization: Basic (basic mode).
// Maps the server's { error: { code, message } } envelope to a thrown ApiError.

const STORAGE_KEY = 'pm2monitor.auth';

/** Error carrying the server envelope's code + HTTP status. */
export class ApiError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Auth is stored as { mode: 'apikey'|'basic', key } where `key` is the raw API
 * key (apikey mode) or the base64 of "user:pass" (basic mode). The same `key`
 * value is reused for the WebSocket subprotocol, so one stored field serves both
 * transports.
 */
export function getAuth() {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function setAuth(auth) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(auth));
}

export function clearAuth() {
  sessionStorage.removeItem(STORAGE_KEY);
}

/** The credential string handed to `new WebSocket(url, ["apikey." + key])`. */
export function wsCredential() {
  const auth = getAuth();
  return auth ? auth.key : '';
}

function authHeaders() {
  const auth = getAuth();
  if (!auth) return {};
  if (auth.mode === 'basic') {
    return { Authorization: `Basic ${auth.key}` };
  }
  return { 'X-API-Key': auth.key };
}

async function request(method, path, { query, body } = {}) {
  let url = path;
  if (query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  const headers = { ...authHeaders() };
  const init = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new ApiError(`network error: ${err.message}`, 'NETWORK', 0);
  }

  // Downloads (export) and empty bodies are handled by the caller via raw().
  const contentType = res.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');
  const data = isJson ? await res.json().catch(() => null) : null;

  if (!res.ok) {
    const envelope = data && data.error ? data.error : {};
    throw new ApiError(
      envelope.message || `HTTP ${res.status}`,
      envelope.code || 'HTTP_ERROR',
      res.status,
    );
  }
  return data;
}

export const api = {
  // --- system ---
  health: () => request('GET', '/api/system/health'),
  status: () => request('GET', '/api/system/status'),

  // --- processes ---
  listProcesses: () => request('GET', '/api/processes'),
  getProcess: (name) => request('GET', `/api/processes/${encodeURIComponent(name)}`),
  metrics: (name, sinceMs) =>
    request('GET', `/api/processes/${encodeURIComponent(name)}/metrics`, { query: { sinceMs } }),
  logs: (name, { lines, stream, q, level } = {}) =>
    request('GET', `/api/processes/${encodeURIComponent(name)}/logs`, {
      query: { lines, stream, q, level },
    }),

  // --- control (destructive) ---
  control: (name, action) =>
    request('POST', `/api/processes/${encodeURIComponent(name)}/${action}`),
  deleteProcess: (name) => request('DELETE', `/api/processes/${encodeURIComponent(name)}`),

  // --- errors ---
  errors: ({ name, sinceMs, limit } = {}) =>
    request('GET', '/api/errors', { query: { name, sinceMs, limit } }),

  // --- alerts / maintenance ---
  rules: () => request('GET', '/api/alerts/rules'),
  reloadRules: () => request('POST', '/api/alerts/rules/reload'),
  testAlert: (channel) => request('POST', '/api/alerts/test', { body: { channel } }),
  recentAlerts: (limit) => request('GET', '/api/alerts/recent', { query: { limit } }),
  getMaintenance: () => request('GET', '/api/maintenance'),
  setMaintenance: ({ active, durationMin, reason } = {}) =>
    request('POST', '/api/maintenance', { body: { active, durationMin, reason } }),
};
