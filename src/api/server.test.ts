import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { request } from 'node:http';
import { createServer, type ApiDeps, type ReloadRulesResult } from './server.js';
import { buildSchemas } from './schemas.js';
import { createLogger } from '../core/logger.js';
import { FakePm2Client, makeSnapshot } from '../testutil/fakePm2Client.js';
import type { MonitorSnapshot, ProcessSnapshot, TrackedError, MetricSample } from '../core/types.js';
import type { MaintenanceState, SetMaintenanceInput } from '../core/state.js';
import type { RecentAlert } from '../alerts/engine.js';

const API_KEY = 'test-key';
const SILENT = createLogger({ level: 'error', sink: () => {} });

/** A minimal in-memory state satisfying the API's StateDeps surface. */
function makeState(processes: ProcessSnapshot[], connected: boolean) {
  let maintenance: MaintenanceState = { active: false };
  const byName = new Map(processes.map((p) => [p.name, p]));
  return {
    snapshot(): MonitorSnapshot {
      return { processes: [...byName.values()], pm2Connected: connected, maintenance: maintenance.active, generatedAt: 0 };
    },
    getProcess: (name: string) => byName.get(name) ?? null,
    getMetrics: (_name: string, _sinceMs: number): MetricSample[] => [{ ts: 1, cpu: 10, mem: 100 }],
    isConnected: () => connected,
    getMaintenance: () => maintenance,
    setMaintenance(input: SetMaintenanceInput): MaintenanceState {
      maintenance = input.active ? { active: true } : { active: false };
      return maintenance;
    },
  };
}

interface Harness {
  deps: ApiDeps;
  pm2: FakePm2Client;
  base: string;
  close: () => Promise<void>;
}

async function boot(opts: { connected?: boolean; processes?: ProcessSnapshot[]; pm2?: FakePm2Client } = {}): Promise<Harness> {
  const processes = opts.processes ?? [makeSnapshot({ name: 'api', pmId: 1 })];
  const connected = opts.connected ?? true;
  const pm2 = opts.pm2 ?? new FakePm2Client({ connected, processes });
  let rules: never[] = [];
  const errorList: TrackedError[] = [];
  const recent: RecentAlert[] = [];

  const deps: ApiDeps = {
    state: makeState(processes, connected),
    pm2,
    engine: {
      reload: (r) => {
        rules = r as never[];
      },
      recentAlerts: () => recent,
      test: async () => {
        /* no-op success */
      },
    },
    errors: { list: () => errorList },
    schemas: buildSchemas({ fileExists: () => true }),
    auth: { mode: 'apikey', apiKey: API_KEY },
    logger: SILENT,
    publicDir: new URL('../../public', import.meta.url).pathname,
    version: '1.0.0',
    startedAt: 0,
    now: () => 1000,
    getRules: () => rules,
    setRules: (r) => {
      rules = r as never[];
    },
    reloadRules: (): ReloadRulesResult => ({ ok: true, rules: [] }),
  };

  const server = createServer(deps);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    deps,
    pm2,
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface HttpResult {
  status: number;
  body: string;
  json: unknown;
  headers: Record<string, string | string[] | undefined>;
}

function http(
  base: string,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const payload = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const req = request(
      base + path,
      {
        method,
        headers: {
          ...(payload !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
          ...(opts.headers ?? {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          let json: unknown;
          try {
            json = JSON.parse(body);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, body, json, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const authed = { 'x-api-key': API_KEY };

// --- auth ---

test('GET /api/system/health is reachable WITHOUT auth and reports pm2Connected', async () => {
  const h = await boot({ connected: false });
  try {
    const res = await http(h.base, 'GET', '/api/system/health');
    assert.equal(res.status, 200);
    assert.equal((res.json as { pm2Connected: boolean }).pm2Connected, false);
    assert.equal((res.json as { status: string }).status, 'ok');
  } finally {
    await h.close();
  }
});

test('protected endpoints 401 without auth, 200 with it', async () => {
  const h = await boot();
  try {
    const noAuth = await http(h.base, 'GET', '/api/processes');
    assert.equal(noAuth.status, 401);
    assert.equal((noAuth.json as { error: { code: string } }).error.code, 'UNAUTHORIZED');

    const withAuth = await http(h.base, 'GET', '/api/processes', { headers: authed });
    assert.equal(withAuth.status, 200);
    assert.equal((withAuth.json as ProcessSnapshot[]).length, 1);
  } finally {
    await h.close();
  }
});

test('GET /api/system/status requires auth', async () => {
  const h = await boot();
  try {
    assert.equal((await http(h.base, 'GET', '/api/system/status')).status, 401);
    const ok = await http(h.base, 'GET', '/api/system/status', { headers: authed });
    assert.equal(ok.status, 200);
    assert.ok(Array.isArray((ok.json as MonitorSnapshot).processes));
  } finally {
    await h.close();
  }
});

// --- processes ---

test('GET /api/processes/:name 404 for unknown', async () => {
  const h = await boot();
  try {
    const res = await http(h.base, 'GET', '/api/processes/ghost', { headers: authed });
    assert.equal(res.status, 404);
    assert.equal((res.json as { error: { code: string } }).error.code, 'NOT_FOUND');
  } finally {
    await h.close();
  }
});

test('control happy path returns the ControlResult (200)', async () => {
  const h = await boot();
  try {
    const res = await http(h.base, 'POST', '/api/processes/api/restart', { headers: authed });
    assert.equal(res.status, 200);
    assert.equal((res.json as { ok: boolean }).ok, true);
    assert.deepEqual(h.pm2.controlCalls.at(-1), { action: 'restart', name: 'api' });
  } finally {
    await h.close();
  }
});

test('control returns 409 PM2_UNAVAILABLE when disconnected', async () => {
  const h = await boot({ connected: false });
  try {
    const res = await http(h.base, 'POST', '/api/processes/api/stop', { headers: authed });
    assert.equal(res.status, 409);
    assert.equal((res.json as { error: { code: string } }).error.code, 'PM2_UNAVAILABLE');
  } finally {
    await h.close();
  }
});

test('control returns 502 on a pm2-side error', async () => {
  const pm2 = new FakePm2Client({
    connected: true,
    processes: [makeSnapshot({ name: 'api' })],
    controlResult: { ok: false, code: 'PM2_ERROR', message: 'boom' },
  });
  const h = await boot({ pm2 });
  try {
    const res = await http(h.base, 'POST', '/api/processes/api/restart', { headers: authed });
    assert.equal(res.status, 502);
    assert.equal((res.json as { error: { code: string } }).error.code, 'PM2_ERROR');
  } finally {
    await h.close();
  }
});

test('POST /api/processes validation: bad name is 400 VALIDATION', async () => {
  const h = await boot();
  try {
    const res = await http(h.base, 'POST', '/api/processes', {
      headers: authed,
      body: { name: 'bad name', script: '/opt/app/server.js' },
    });
    assert.equal(res.status, 400);
    assert.equal((res.json as { error: { code: string } }).error.code, 'VALIDATION');
  } finally {
    await h.close();
  }
});

test('POST /api/processes create returns 201 on success', async () => {
  const h = await boot();
  try {
    const res = await http(h.base, 'POST', '/api/processes', {
      headers: authed,
      body: { name: 'newproc', script: '/opt/app/server.js' },
    });
    assert.equal(res.status, 201);
    assert.equal((res.json as { ok: boolean }).ok, true);
    assert.equal(h.pm2.startNewCalls.length, 1);
  } finally {
    await h.close();
  }
});

test('GET /api/processes/:name/logs 404 for unknown name (resolved first)', async () => {
  const h = await boot();
  try {
    const res = await http(h.base, 'GET', '/api/processes/ghost/logs', { headers: authed });
    assert.equal(res.status, 404);
  } finally {
    await h.close();
  }
});

test('GET /api/processes/:name/logs returns lines for a known process', async () => {
  const pm2 = new FakePm2Client({
    connected: true,
    processes: [makeSnapshot({ name: 'api' })],
    logs: [{ stream: 'out', level: 'info', line: 'hello', ts: 1 }],
  });
  const h = await boot({ pm2 });
  try {
    const res = await http(h.base, 'GET', '/api/processes/api/logs?lines=10', { headers: authed });
    assert.equal(res.status, 200);
    assert.equal((res.json as { lines: unknown[] }).lines.length, 1);
  } finally {
    await h.close();
  }
});

// --- graceful degradation: static + health still serve with pm2 down ---

test('graceful degradation: GET / serves HTML and health reports disconnected', async () => {
  const h = await boot({ connected: false });
  try {
    const root = await http(h.base, 'GET', '/');
    assert.equal(root.status, 200);
    assert.match(root.body, /<html/i);

    const health = await http(h.base, 'GET', '/api/system/health');
    assert.equal((health.json as { pm2Connected: boolean }).pm2Connected, false);
  } finally {
    await h.close();
  }
});

// --- maintenance round-trip ---

test('maintenance GET/POST round-trip', async () => {
  const h = await boot();
  try {
    const set = await http(h.base, 'POST', '/api/maintenance', { headers: authed, body: { active: true } });
    assert.equal(set.status, 200);
    assert.equal((set.json as { active: boolean }).active, true);
    const get = await http(h.base, 'GET', '/api/maintenance', { headers: authed });
    assert.equal((get.json as { active: boolean }).active, true);
  } finally {
    await h.close();
  }
});
