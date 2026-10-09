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
  } as unknown as AppConfig;
}

async function boot(): Promise<{ base: string; registry: FleetRegistry; aliases: AliasStore; close: () => Promise<void> }> {
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
