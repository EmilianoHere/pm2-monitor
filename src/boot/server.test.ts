import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildServerApp, buildFleetDeps } from './server.js';
import { createLogger } from '../core/logger.js';
import { buildSchemas } from '../api/schemas.js';
import { FleetRegistry, type AgentWebSocket } from '../server/registry.js';
import { AliasStore } from '../server/aliasStore.js';
import { AgentTokenStore, AgentTokenService } from '../server/agentTokenStore.js';
import { AlertEngine } from '../alerts/engine.js';
import { MonitorEvents } from '../core/events.js';
import {
  GlobalMaintenanceState,
  FleetStateHub,
  FleetErrorWindows,
  buildResolveAgent,
} from '../server/fleetEvents.js';
import type { AppConfig } from '../config/env.js';

const silent = createLogger({ level: 'error', sink: () => {} });
const API_KEY = 'boot-key';

class FakeSocket implements AgentWebSocket {
  send(): void {}
}

function fakeConfig(): AppConfig {
  // Only the fields buildServerApp/buildAuthConfig read are needed.
  return {
    AUTH_MODE: 'apikey',
    API_KEY,
    ALERT_RULES_FILE: 'config/does-not-exist.json',
    METRICS_RETENTION_MIN: 180,
    METRICS_SAMPLE_SEC: 5,
    ERROR_BUFFER_SIZE: 500,
    DEFAULT_COOLDOWN_SEC: 300,
    ALLOWED_SCRIPT_ROOT: undefined,
    AGENT_WS_PATH: '/agent',
  } as unknown as AppConfig;
}

/** An agent-token service backed by an in-memory (no-disk) store. */
function makeAgentTokens(): AgentTokenService {
  const store = new AgentTokenStore({
    file: '/tmp/none-agent-tokens.json',
    logger: silent,
    readFile: async () => {
      throw new Error('ENOENT');
    },
    writeFile: async () => {},
    rename: async () => {},
    chmod: async () => {},
  });
  return new AgentTokenService(store);
}

async function boot(): Promise<{
  base: string;
  registry: FleetRegistry;
  aliases: AliasStore;
  agentTokens: AgentTokenService;
  close: () => Promise<void>;
}> {
  const config = fakeConfig();
  const maintenance = new GlobalMaintenanceState();
  const registry = new FleetRegistry({ logger: silent, retentionMin: 180, sampleSec: 5, errorBufferSize: 500 });
  const aliases = new AliasStore({
    file: '/tmp/none.json',
    logger: silent,
    readFile: async () => '{}',
    writeFile: async () => {},
    rename: async () => {},
  });
  await aliases.load();
  const agentTokens = makeAgentTokens();
  const engine = new AlertEngine({
    rules: [],
    state: new FleetStateHub(registry, maintenance),
    events: new MonitorEvents(),
    errors: new FleetErrorWindows(registry),
    channels: [],
    defaultCooldownSec: 300,
    logger: silent,
    resolveAgent: buildResolveAgent(registry, aliases),
  });
  const app = buildServerApp({
    config,
    logger: silent,
    maintenance,
    registry,
    aliases,
    agentTokens,
    engine,
    schemas: buildSchemas(),
    startedAt: 1000,
    getRules: () => [],
    setRules: () => {},
  });
  const server: Server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    registry,
    aliases,
    agentTokens,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function http(base: string, method: string, path: string, auth = true): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: auth ? { 'x-api-key': API_KEY } : {},
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

/** Richer request helper: body + an optional explicit credential (null = none). */
async function req(
  base: string,
  method: string,
  path: string,
  opts: { body?: unknown; key?: string | null } = {},
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = {};
  if (opts.key !== null) headers['x-api-key'] = opts.key ?? API_KEY;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

test('server health reports mode:"server" with an agents summary and no pm2Connected (unauthenticated)', async () => {
  const h = await boot();
  try {
    h.registry.register('a1', { hostname: 'h', platform: 'linux', monitorVersion: '1.0.0' }, new FakeSocket());
    const res = await http(h.base, 'GET', '/api/system/health', false);
    assert.equal(res.status, 200);
    const body = res.json as Record<string, unknown>;
    assert.equal(body.mode, 'server');
    assert.deepEqual(body.agents, { total: 1, online: 1 });
    assert.ok(!('pm2Connected' in body));
  } finally {
    await h.close();
  }
});

test('the /api/agents router is mounted behind the human auth', async () => {
  const h = await boot();
  try {
    h.registry.register('a1', { hostname: 'h', platform: 'linux', monitorVersion: '1.0.0' }, new FakeSocket());
    const noAuth = await http(h.base, 'GET', '/api/agents', false);
    assert.equal(noAuth.status, 401);

    const ok = await http(h.base, 'GET', '/api/agents');
    assert.equal(ok.status, 200);
    const list = ok.json as Array<{ id: string }>;
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'a1');
  } finally {
    await h.close();
  }
});

test('/api/system/status is NOT mounted in server mode (404)', async () => {
  const h = await boot();
  try {
    const res = await http(h.base, 'GET', '/api/system/status');
    assert.equal(res.status, 404);
  } finally {
    await h.close();
  }
});

test('the global maintenance route toggles the holder read by health', async () => {
  const h = await boot();
  try {
    const set = await fetch(`${h.base}/api/maintenance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ active: true }),
    });
    assert.equal(set.status, 200);
    const health = await http(h.base, 'GET', '/api/system/health', false);
    assert.equal((health.json as { maintenance: boolean }).maintenance, true);
  } finally {
    await h.close();
  }
});

test('buildFleetDeps keys the list by the live registry (pre-seeded-only alias not listed)', async () => {
  const h = await boot();
  try {
    await h.aliases.set('ghost', 'NeverConnected'); // pre-seed only
    h.registry.register('a1', { hostname: 'h', platform: 'linux', monitorVersion: '1.0.0' }, new FakeSocket());
    const deps = buildFleetDeps(h.registry, h.aliases);
    const list = deps.listAgents();
    assert.deepEqual(
      list.map((r) => r.id),
      ['a1'],
      'only live agents are listed; the pre-seeded ghost alias is not',
    );
    assert.equal(h.aliases.get('ghost'), 'NeverConnected', 'but the alias is still stored');
  } finally {
    await h.close();
  }
});

// --- master-only agent-token routes (server mode) ---

test('GET /api/settings/agent-tokens: master 200 masked list (AC-14)', async () => {
  const h = await boot();
  try {
    await h.agentTokens.generate('web-01');
    const res = await req(h.base, 'GET', '/api/settings/agent-tokens');
    assert.equal(res.status, 200);
    const rows = res.json as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.deepEqual(Object.keys(rows[0]).sort(), ['createdAt', 'id', 'label', 'prefix', 'status'].sort());
    assert.ok(!('hash' in rows[0]) && !('rawToken' in rows[0]), 'no hash/raw emitted');
  } finally {
    await h.close();
  }
});

test('POST /api/settings/agent-tokens: 201 rawToken once; invalid -> 400 VALIDATION (AC-15)', async () => {
  const h = await boot();
  try {
    const ok = await req(h.base, 'POST', '/api/settings/agent-tokens', { body: { label: 'web-01' } });
    assert.equal(ok.status, 201);
    const token = ok.json as Record<string, unknown>;
    assert.ok(typeof token.rawToken === 'string' && (token.rawToken as string).length > 0);
    assert.ok(/^pmat_/.test(token.prefix as string));
    assert.ok(!('hash' in token), 'POST never emits the hash');

    const bad = await req(h.base, 'POST', '/api/settings/agent-tokens', { body: { label: '' } });
    assert.equal(bad.status, 400);
    assert.equal((bad.json as { error: { code: string } }).error.code, 'VALIDATION');
  } finally {
    await h.close();
  }
});

test('DELETE /api/settings/agent-tokens/:id: existing 200, unknown 404 (AC-16)', async () => {
  const h = await boot();
  try {
    const token = await h.agentTokens.generate('web-01');
    const del = await req(h.base, 'DELETE', `/api/settings/agent-tokens/${token.id}`);
    assert.equal(del.status, 200);
    assert.equal(h.agentTokens.list()[0].status, 'revoked');

    const unknown = await req(h.base, 'DELETE', '/api/settings/agent-tokens/00000000-0000-4000-8000-000000000000');
    assert.equal(unknown.status, 404);
    assert.equal((unknown.json as { error: { code: string } }).error.code, 'NOT_FOUND');
  } finally {
    await h.close();
  }
});

test('PATCH /api/settings/agent-tokens/:id: relabel 200 (hash/prefix/id unchanged), unknown 404 (AC-17)', async () => {
  const h = await boot();
  try {
    const token = await h.agentTokens.generate('old');
    const before = h.agentTokens.list()[0];
    const patch = await req(h.base, 'PATCH', `/api/settings/agent-tokens/${token.id}`, { body: { label: 'new' } });
    assert.equal(patch.status, 200);
    const after = h.agentTokens.list()[0];
    assert.equal(after.label, 'new');
    assert.equal(after.prefix, before.prefix, 'prefix unchanged');
    assert.equal(after.id, before.id, 'id unchanged');

    const unknown = await req(h.base, 'PATCH', '/api/settings/agent-tokens/00000000-0000-4000-8000-000000000000', {
      body: { label: 'x' },
    });
    assert.equal(unknown.status, 404);
  } finally {
    await h.close();
  }
});

test('agent-token routes: no/invalid credential -> 401 (AC-18)', async () => {
  const h = await boot();
  try {
    const noCred = await req(h.base, 'GET', '/api/settings/agent-tokens', { key: null });
    assert.equal(noCred.status, 401);
    const badCred = await req(h.base, 'GET', '/api/settings/agent-tokens', { key: 'not-the-master-key' });
    assert.equal(badCred.status, 401);
    // POST/DELETE/PATCH equally gated before any handler runs.
    const postNoCred = await req(h.base, 'POST', '/api/settings/agent-tokens', { key: null, body: { label: 'x' } });
    assert.equal(postNoCred.status, 401);
  } finally {
    await h.close();
  }
});

test('no route emits a hash; only POST emits a raw token (AC-19)', async () => {
  const h = await boot();
  try {
    const gen = await req(h.base, 'POST', '/api/settings/agent-tokens', { body: { label: 'web-01' } });
    assert.ok('rawToken' in (gen.json as Record<string, unknown>));
    const list = await req(h.base, 'GET', '/api/settings/agent-tokens');
    assert.ok(!JSON.stringify(list.json).includes('rawToken'));
    assert.ok(!JSON.stringify(list.json).includes('hash'));
  } finally {
    await h.close();
  }
});

test('GET /api/settings/whoami in server mode: master 200 {isMaster:true, authMode}', async () => {
  const h = await boot();
  try {
    const res = await req(h.base, 'GET', '/api/settings/whoami');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { isMaster: true, authMode: 'apikey' });
    const noCred = await req(h.base, 'GET', '/api/settings/whoami', { key: null });
    assert.equal(noCred.status, 401);
  } finally {
    await h.close();
  }
});
