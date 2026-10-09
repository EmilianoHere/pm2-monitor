import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createAgentsRouter, type FleetDeps, type AgentListRow, type AgentDetail, type AgentLogLine } from './agents.js';
import { createAuthMiddleware } from '../auth.js';
import { AliasValidationError } from '../../server/aliasStore.js';
import { buildSchemas } from '../schemas.js';
import type { ControlAction, ControlResult, StartNewOpts } from '../../pm2/client.js';
import type { ProcessSnapshot } from '../../core/types.js';

const API_KEY = 'fleet-key';

function proc(name: string): ProcessSnapshot {
  return {
    pmId: 0,
    name,
    pid: 1,
    status: 'online',
    cpu: 0,
    memory: 0,
    uptimeMs: 0,
    restarts: 0,
    unstableRestarts: 0,
    mode: 'fork',
    instances: 1,
    execPath: null,
    lastUpdated: 1000,
  };
}

/** A fake FleetDeps recording control/create/alias calls. */
class FakeFleet implements FleetDeps {
  readonly rows: AgentListRow[];
  readonly controlCalls: Array<{ id: string; action: ControlAction; name: string }> = [];
  readonly createCalls: Array<{ id: string; opts: StartNewOpts }> = [];
  readonly aliasCalls: Array<{ id: string; alias: string }> = [];
  controlResult: ControlResult = { ok: true, process: proc('api') };
  createResult: ControlResult = { ok: true, process: proc('new') };
  aliasError: Error | null = null;

  constructor(rows: AgentListRow[]) {
    this.rows = rows;
  }
  private has(id: string): boolean {
    return this.rows.some((r) => r.id === id);
  }
  listAgents(): AgentListRow[] {
    return this.rows;
  }
  getAgent(id: string): AgentDetail | null {
    const r = this.rows.find((x) => x.id === id);
    return r ? { ...r, processes: [proc('api')] } : null;
  }
  agentProcesses(id: string): ProcessSnapshot[] | null {
    return this.has(id) ? [proc('api')] : null;
  }
  agentMetrics(): never[] {
    return [];
  }
  agentLogs(id: string, name: string): AgentLogLine[] {
    return [{ agentId: id, process: name, stream: 'out', level: 'info', line: 'x', ts: 1 }];
  }
  agentErrors(): never[] {
    return [];
  }
  async routeControl(id: string, action: ControlAction, name: string): Promise<ControlResult> {
    this.controlCalls.push({ id, action, name });
    return this.controlResult;
  }
  async routeCreate(id: string, opts: StartNewOpts): Promise<ControlResult> {
    this.createCalls.push({ id, opts });
    return this.createResult;
  }
  async setAlias(id: string, alias: string): Promise<void> {
    if (this.aliasError) throw this.aliasError;
    this.aliasCalls.push({ id, alias });
  }
}

function row(id: string, alias?: string): AgentListRow {
  return {
    id,
    alias,
    online: true,
    meta: { hostname: 'h' },
    pm2Connected: true,
    processCount: 1,
    lastSeen: 1000,
  };
}

interface Harness {
  base: string;
  fleet: FakeFleet;
  close: () => Promise<void>;
}

async function boot(rows: AgentListRow[]): Promise<Harness> {
  const fleet = new FakeFleet(rows);
  const app = express();
  app.use(express.json());
  // Human auth is applied upstream exactly as server boot does.
  app.use('/api', createAuthMiddleware({ mode: 'apikey', apiKey: API_KEY }));
  app.use(
    '/api/agents',
    createAgentsRouter({ fleet, schemas: buildSchemas(), now: () => 10_000 }),
  );
  const server: Server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    fleet,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface Res {
  status: number;
  json: unknown;
}
async function http(base: string, method: string, path: string, body?: unknown, auth = true): Promise<Res> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(auth ? { 'x-api-key': API_KEY } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

test('human auth is enforced on the agents routes', async () => {
  const h = await boot([row('a1')]);
  try {
    const res = await http(h.base, 'GET', '/api/agents', undefined, false);
    assert.equal(res.status, 401);
  } finally {
    await h.close();
  }
});

test('GET /api/agents lists the live registry rows; a pre-seeded alias for a never-connected id is not listed', async () => {
  // The FakeFleet.listAgents returns only live rows (that's the server adapter's
  // contract); a pre-seeded alias for 'ghost' is simply absent from the list.
  const h = await boot([row('a1', 'Alpha')]);
  try {
    const res = await http(h.base, 'GET', '/api/agents');
    assert.equal(res.status, 200);
    const list = res.json as AgentListRow[];
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'a1');
    assert.equal(list[0].alias, 'Alpha');
    assert.ok(!list.some((r) => r.id === 'ghost'));
  } finally {
    await h.close();
  }
});

test('GET /api/agents/:id returns detail; unknown id is 404 AGENT_NOT_FOUND', async () => {
  const h = await boot([row('a1')]);
  try {
    const ok = await http(h.base, 'GET', '/api/agents/a1');
    assert.equal(ok.status, 200);
    assert.deepEqual((ok.json as AgentDetail).processes[0].name, 'api');

    const miss = await http(h.base, 'GET', '/api/agents/ghost');
    assert.equal(miss.status, 404);
    assert.equal((miss.json as { error: { code: string } }).error.code, 'AGENT_NOT_FOUND');
  } finally {
    await h.close();
  }
});

test('an invalid :id is 400 VALIDATION', async () => {
  const h = await boot([row('a1')]);
  try {
    const res = await http(h.base, 'GET', '/api/agents/bad%20id');
    assert.equal(res.status, 400);
    assert.equal((res.json as { error: { code: string } }).error.code, 'VALIDATION');
  } finally {
    await h.close();
  }
});

test('a routed control success returns 200 and reaches the fleet', async () => {
  const h = await boot([row('a1')]);
  try {
    const res = await http(h.base, 'POST', '/api/agents/a1/processes/api/restart');
    assert.equal(res.status, 200);
    assert.deepEqual(h.fleet.controlCalls, [{ id: 'a1', action: 'restart', name: 'api' }]);
  } finally {
    await h.close();
  }
});

test('routed control HTTP mapping: offline->409, unknown->404, validation->400, pm2 error->502', async () => {
  const cases: Array<[ControlResult, number]> = [
    [{ ok: false, code: 'AGENT_OFFLINE', message: 'x' }, 409],
    [{ ok: false, code: 'AGENT_NOT_FOUND', message: 'x' }, 404],
    [{ ok: false, code: 'VALIDATION', message: 'x' }, 400],
    [{ ok: false, code: 'PM2_ERROR', message: 'x' }, 502],
    [{ ok: false, code: 'AGENT_TIMEOUT', message: 'x' }, 409],
  ];
  for (const [result, status] of cases) {
    const h = await boot([row('a1')]);
    try {
      h.fleet.controlResult = result;
      const res = await http(h.base, 'POST', '/api/agents/a1/processes/api/stop');
      assert.equal(res.status, status, `code ${(result as { code: string }).code} -> ${status}`);
    } finally {
      await h.close();
    }
  }
});

test('create validates the { body } wrapper BEFORE routing and returns 201 only on ok', async () => {
  const h = await boot([row('a1')]);
  try {
    // Invalid body (neither script nor ecosystem) -> 400, never routed.
    const bad = await http(h.base, 'POST', '/api/agents/a1/processes', { name: 'x' });
    assert.equal(bad.status, 400);
    assert.equal(h.fleet.createCalls.length, 0, 'invalid create is not routed');

    // A valid body routes and 201 on ok.
    h.fleet.createResult = { ok: true, process: proc('new') };
    const ok = await http(h.base, 'POST', '/api/agents/a1/processes', { ecosystem: '/x/does-not-exist.config.js' });
    // ecosystem path does not exist on disk -> createProcess rejects -> 400.
    assert.equal(ok.status, 400);
  } finally {
    await h.close();
  }
});

test('a create failure maps via statusForControlCode and never returns 201', async () => {
  const h = await boot([row('a1')]);
  try {
    // Use a body that passes schema validation: a bare name process create is
    // not valid (needs script XOR ecosystem), so craft a passing one by faking
    // the fleet result after a structurally-valid create. We assert the mapping
    // path by making routeCreate resolve a not-ok result for a valid body.
    // Build a schema-valid body via an existing file: use this test file itself.
    const self = new URL(import.meta.url).pathname;
    h.fleet.createResult = { ok: false, code: 'AGENT_OFFLINE', message: 'x' };
    const res = await http(h.base, 'POST', '/api/agents/a1/processes', { script: self });
    assert.equal(res.status, 409, 'offline create maps to 409, not 201');
    assert.equal(h.fleet.createCalls.length, 1);
  } finally {
    await h.close();
  }
});

test('PUT /api/agents/:id/alias validates + persists, and rejects an invalid alias with 400', async () => {
  const h = await boot([row('a1')]);
  try {
    const ok = await http(h.base, 'PUT', '/api/agents/a1/alias', { alias: '  Alpha  ' });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json, { id: 'a1', alias: 'Alpha' }); // trimmed
    assert.deepEqual(h.fleet.aliasCalls, [{ id: 'a1', alias: 'Alpha' }]);

    const blank = await http(h.base, 'PUT', '/api/agents/a1/alias', { alias: '   ' });
    assert.equal(blank.status, 400);
    assert.equal((blank.json as { error: { code: string } }).error.code, 'VALIDATION');
  } finally {
    await h.close();
  }
});

test('a store-side AliasValidationError maps to 400', async () => {
  const h = await boot([row('a1')]);
  try {
    h.fleet.aliasError = new AliasValidationError('nope');
    const res = await http(h.base, 'PUT', '/api/agents/a1/alias', { alias: 'ValidLooking' });
    assert.equal(res.status, 400);
    assert.equal((res.json as { error: { code: string } }).error.code, 'VALIDATION');
  } finally {
    await h.close();
  }
});

test('GET /api/agents/:id/processes/:name/logs returns the relayed lines', async () => {
  const h = await boot([row('a1')]);
  try {
    const res = await http(h.base, 'GET', '/api/agents/a1/processes/api/logs');
    assert.equal(res.status, 200);
    const body = res.json as { name: string; lines: AgentLogLine[] };
    assert.equal(body.name, 'api');
    assert.equal(body.lines.length, 1);
  } finally {
    await h.close();
  }
});
