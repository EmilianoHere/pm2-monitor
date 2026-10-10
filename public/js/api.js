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

/**
 * Base path for per-process reads/control. In standalone (no `agentId`) this is
 * the existing `/api/processes` surface — the call sites below pass no `agentId`
 * so the standalone requests are byte-identical. In server mode an `agentId`
 * selects the agent-scoped `/api/agents/:id/processes` surface, which returns
 * the SAME shapes so the overview/detail components are reused unchanged.
 */
function processBase(agentId) {
  return agentId ? `/api/agents/${encodeURIComponent(agentId)}/processes` : '/api/processes';
}

export const api = {
  // --- system ---
  health: () => request('GET', '/api/system/health'),
  status: () => request('GET', '/api/system/status'),

  // --- processes (optional agentId selects the agent-scoped base path) ---
  listProcesses: (agentId) =>
    agentId
      ? request('GET', `/api/agents/${encodeURIComponent(agentId)}/processes`)
      : request('GET', '/api/processes'),
  getProcess: (name, agentId) =>
    request('GET', `${processBase(agentId)}/${encodeURIComponent(name)}`),
  metrics: (name, sinceMs, agentId) =>
    request('GET', `${processBase(agentId)}/${encodeURIComponent(name)}/metrics`, {
      query: { sinceMs },
    }),
  logs: (name, { lines, stream, q, level } = {}, agentId) =>
    request('GET', `${processBase(agentId)}/${encodeURIComponent(name)}/logs`, {
      query: { lines, stream, q, level },
    }),

  // --- control (destructive; optional agentId selects the agent-scoped path) ---
  control: (name, action, agentId) =>
    request('POST', `${processBase(agentId)}/${encodeURIComponent(name)}/${action}`),
  deleteProcess: (name, agentId) =>
    agentId
      ? // Agent-scoped delete is a POST action (routed control), not a DELETE verb.
        request('POST', `${processBase(agentId)}/${encodeURIComponent(name)}/delete`)
      : request('DELETE', `/api/processes/${encodeURIComponent(name)}`),

  // --- errors (optional agentId selects the agent-scoped path) ---
  errors: ({ name, sinceMs, limit } = {}, agentId) =>
    agentId
      ? request('GET', `/api/agents/${encodeURIComponent(agentId)}/errors`, {
          query: { name, sinceMs, limit },
        })
      : request('GET', '/api/errors', { query: { name, sinceMs, limit } }),

  // --- agents (server mode only) ---
  listAgents: () => request('GET', '/api/agents'),
  getAgent: (id) => request('GET', `/api/agents/${encodeURIComponent(id)}`),
  agentProcesses: (id) => request('GET', `/api/agents/${encodeURIComponent(id)}/processes`),
  agentMetrics: (id, name, sinceMs) =>
    request('GET', `/api/agents/${encodeURIComponent(id)}/processes/${encodeURIComponent(name)}/metrics`, {
      query: { sinceMs },
    }),
  agentLogs: (id, name, { lines, stream, q, level } = {}) =>
    request('GET', `/api/agents/${encodeURIComponent(id)}/processes/${encodeURIComponent(name)}/logs`, {
      query: { lines, stream, q, level },
    }),
  agentControl: (id, name, action) =>
    request('POST', `/api/agents/${encodeURIComponent(id)}/processes/${encodeURIComponent(name)}/${action}`),
  setAlias: (id, alias) =>
    request('PUT', `/api/agents/${encodeURIComponent(id)}/alias`, { body: { alias } }),

  // --- alerts / maintenance ---
  rules: () => request('GET', '/api/alerts/rules'),
  reloadRules: () => request('POST', '/api/alerts/rules/reload'),
  testAlert: (channel) => request('POST', '/api/alerts/test', { body: { channel } }),
  recentAlerts: (limit) => request('GET', '/api/alerts/recent', { query: { limit } }),
  getMaintenance: () => request('GET', '/api/maintenance'),
  setMaintenance: ({ active, durationMin, reason } = {}) =>
    request('POST', '/api/maintenance', { body: { active, durationMin, reason } }),
};
