import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { request } from 'node:http';
import { createServer, type ApiDeps, type ReloadRulesResult } from '../server.js';
import { buildSchemas } from '../schemas.js';
import { createLogger } from '../../core/logger.js';
import { FakePm2Client, makeSnapshot } from '../../testutil/fakePm2Client.js';
import type { MonitorSnapshot, ProcessSnapshot, MetricSample } from '../../core/types.js';
import type { MaintenanceState, SetMaintenanceInput } from '../../core/state.js';
import { ApiKeyStore, ApiKeyService } from '../../server/apiKeyStore.js';
import { SettingsStore } from '../../config/settingsStore.js';
import { SecretsStore } from '../../config/secretsStore.js';
import { SettingsService, type SettingsHandles } from '../../config/settingsService.js';
import { parseConfig, type AppConfig } from '../../config/env.js';
import type { SmtpConfig } from '../../alerts/channels/email.js';

const API_KEY = 'master-key';

/** A sink that records every emitted log line (for the no-secret-in-logs test). */
function recordingLogger() {
  const lines: string[] = [];
  const logger = createLogger({ level: 'debug', sink: (line) => lines.push(line) });
  return { logger, lines };
}

function makeState(processes: ProcessSnapshot[], connected: boolean) {
  let maintenance: MaintenanceState = { active: false };
  const byName = new Map(processes.map((p) => [p.name, p]));
  return {
    snapshot: (): MonitorSnapshot => ({
      processes: [...byName.values()],
      pm2Connected: connected,
      maintenance: maintenance.active,
      generatedAt: 0,
    }),
    getProcess: (name: string) => byName.get(name) ?? null,
    getMetrics: (_n: string, _s: number): MetricSample[] => [],
    isConnected: () => connected,
    getMaintenance: () => maintenance,
    setMaintenance: (input: SetMaintenanceInput): MaintenanceState => {
      maintenance = input.active ? { active: true } : { active: false };
      return maintenance;
    },
  };
}

function fakeFs() {
  const files = new Map<string, string>();
  return {
    readFile: async (f: string): Promise<string> => {
      const v = files.get(f);
      if (v === undefined) throw new Error('ENOENT');
      return v;
    },
    writeFile: async (f: string, data: string): Promise<void> => {
      files.set(f, data);
    },
    rename: async (from: string, to: string): Promise<void> => {
      files.set(to, files.get(from)!);
      files.delete(from);
    },
    chmod: async (): Promise<void> => {},
    files,
  };
}

function baseConfig(): AppConfig {
  const result = parseConfig({ AUTH_MODE: 'apikey', API_KEY });
  assert.ok(result.success);
  return result.data;
}

interface Harness {
  base: string;
  apiKeys: ApiKeyService;
  settings: SettingsService;
  logLines: string[];
  calls: Record<string, unknown[]>;
  close: () => Promise<void>;
}

async function boot(): Promise<Harness> {
  const { logger, lines } = recordingLogger();
  const fs = fakeFs();
  const apiKeyStore = new ApiKeyStore({ file: 'config/api-keys.json', logger, ...fs });
  const settingsStore = new SettingsStore({ file: 'config/settings.json', logger, ...fs });
  const secretsStore = new SecretsStore({ file: 'config/secrets.json', logger, ...fs });
  await apiKeyStore.load();
  await settingsStore.load();
  await secretsStore.load();
  const apiKeys = new ApiKeyService(apiKeyStore);

  const calls: Record<string, unknown[]> = { logLevel: [], email: [] };
  const handles: SettingsHandles = {
    teams: { reconfigure: () => {} },
    email: { reconfigure: (smtp?: SmtpConfig) => calls.email.push(smtp) },
    engine: { setDefaultCooldownSec: () => {} },
    digest: { setEnabled: () => {}, setDigestHour: () => {} },
    errors: { setLogAppend: () => {} },
    logger: { ...logger, setLevel: (l) => calls.logLevel.push(l) } as typeof logger,
  };
  const settings = new SettingsService({ settingsStore, secretsStore, base: baseConfig(), handles });

  const processes = [makeSnapshot({ name: 'api', pmId: 1 })];
  const pm2 = new FakePm2Client({ connected: true, processes });
  const deps: ApiDeps = {
    state: makeState(processes, true),
    pm2,
    engine: { reload: () => {}, recentAlerts: () => [], test: async () => {} },
    errors: { list: () => [] },
    schemas: buildSchemas({ fileExists: () => true }),
    auth: { mode: 'apikey', apiKey: API_KEY },
    keys: apiKeyStore,
    apiKeys,
    settings,
    logger,
    publicDir: new URL('../../../public', import.meta.url).pathname,
    version: '1.0.0',
    startedAt: 0,
    now: () => 1000,
    getRules: () => [],
    setRules: () => {},
    reloadRules: (): ReloadRulesResult => ({ ok: true, rules: [] }),
  };

  const server = createServer(deps);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    apiKeys,
    settings,
    logLines: lines,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface HttpResult {
  status: number;
  json: unknown;
  body: string;
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
          ...(payload !== undefined
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            : {}),
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
          resolve({ status: res.statusCode ?? 0, json, body });
        });
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const master = { 'x-api-key': API_KEY };

// --- authz (AC-7, AC-8, AC-16, AC-34) ---

test('no creds -> 401 on every settings route', async () => {
  const h = await boot();
  try {
    for (const [m, p] of [
      ['GET', '/api/settings'],
      ['PUT', '/api/settings'],
      ['GET', '/api/settings/keys'],
      ['POST', '/api/settings/keys'],
      ['GET', '/api/settings/whoami'],
    ] as const) {
      const res = await http(h.base, m, p);
      assert.equal(res.status, 401, `${m} ${p}`);
    }
  } finally {
    await h.close();
  }
});

test('a valid secondary key -> 403 on settings routes (master only)', async () => {
  const h = await boot();
  try {
    const gen = await h.apiKeys.generate('ci');
    const secondary = { 'x-api-key': gen.rawKey };
    const res = await http(h.base, 'GET', '/api/settings', { headers: secondary });
    assert.equal(res.status, 403);
    assert.equal((res.json as { error: { code: string } }).error.code, 'FORBIDDEN');
    const who = await http(h.base, 'GET', '/api/settings/whoami', { headers: secondary });
    assert.equal(who.status, 403);
  } finally {
    await h.close();
  }
});

test('master -> 200 on GET settings and whoami', async () => {
  const h = await boot();
  try {
    const res = await http(h.base, 'GET', '/api/settings', { headers: master });
    assert.equal(res.status, 200);
    const grouped = res.json as { hot: unknown[]; restart: unknown[] };
    assert.ok(Array.isArray(grouped.hot));
    assert.ok(Array.isArray(grouped.restart));
    const who = await http(h.base, 'GET', '/api/settings/whoami', { headers: master });
    assert.equal(who.status, 200);
    assert.deepEqual(who.json, { isMaster: true, authMode: 'apikey' });
  } finally {
    await h.close();
  }
});

// --- keys lifecycle (AC-11, AC-13, AC-14) ---

test('POST keys returns rawKey once; GET keys masks; DELETE revokes', async () => {
  const h = await boot();
  try {
    const gen = await http(h.base, 'POST', '/api/settings/keys', {
      headers: master,
      body: { label: 'ci' },
    });
    assert.equal(gen.status, 201);
    const created = gen.json as { id: string; label: string; prefix: string; rawKey: string };
    assert.ok(created.rawKey && created.rawKey.length > 0);
    assert.equal(created.label, 'ci');

    const list = await http(h.base, 'GET', '/api/settings/keys', { headers: master });
    assert.equal(list.status, 200);
    const rows = list.json as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.ok(!('rawKey' in rows[0]));
    assert.ok(!('hash' in rows[0]));
    // The raw key never appears in a list response.
    assert.ok(!list.body.includes(created.rawKey));

    // The key authenticates (as secondary) before revocation.
    const beforeRevoke = await http(h.base, 'GET', '/api/processes', {
      headers: { 'x-api-key': created.rawKey },
    });
    assert.equal(beforeRevoke.status, 200);

    const del = await http(h.base, 'DELETE', `/api/settings/keys/${created.id}`, { headers: master });
    assert.equal(del.status, 200);

    // After revocation the key no longer authenticates.
    const afterRevoke = await http(h.base, 'GET', '/api/processes', {
      headers: { 'x-api-key': created.rawKey },
    });
    assert.equal(afterRevoke.status, 401);
  } finally {
    await h.close();
  }
});

test('DELETE unknown key id -> 404', async () => {
  const h = await boot();
  try {
    const res = await http(h.base, 'DELETE', '/api/settings/keys/00000000-0000-0000-0000-000000000000', {
      headers: master,
    });
    assert.equal(res.status, 404);
  } finally {
    await h.close();
  }
});

test('POST keys with a blank label -> 400 VALIDATION', async () => {
  const h = await boot();
  try {
    const res = await http(h.base, 'POST', '/api/settings/keys', { headers: master, body: { label: '  ' } });
    assert.equal(res.status, 400);
    assert.equal((res.json as { error: { code: string } }).error.code, 'VALIDATION');
  } finally {
    await h.close();
  }
});

// --- settings PUT: hot vs restart, masked GET (AC-20, AC-21, AC-22, AC-25) ---

test('PUT invalid field -> 400 VALIDATION, nothing persisted', async () => {
  const h = await boot();
  try {
    const res = await http(h.base, 'PUT', '/api/settings', { headers: master, body: { LOG_LEVEL: 'nope' } });
    assert.equal(res.status, 400);
    assert.equal((res.json as { error: { code: string } }).error.code, 'VALIDATION');
    assert.equal(h.settings.getEffective().LOG_LEVEL, 'info', 'unchanged');
  } finally {
    await h.close();
  }
});

test('PUT breaking a cross-field group -> 400 VALIDATION, nothing persisted (AC-22)', async () => {
  const h = await boot();
  try {
    // SMTP_HOST alone passes stage-1 shape but fails the stage-2 email-group
    // cross-field guard (SMTP_USER/SMTP_PASS/MAIL_FROM/MAIL_TO still unset).
    const res = await http(h.base, 'PUT', '/api/settings', {
      headers: master,
      body: { SMTP_HOST: 'smtp.example.com' },
    });
    assert.equal(res.status, 400);
    assert.equal((res.json as { error: { code: string } }).error.code, 'VALIDATION');
    // Nothing persisted: the effective config still has no SMTP_HOST.
    assert.equal(h.settings.getEffective().SMTP_HOST, undefined, 'nothing persisted');
    // No hot setter fired.
    assert.deepEqual(h.calls.email, []);
  } finally {
    await h.close();
  }
});

test('saving LOG_LEVEL takes effect live (hot setter invoked)', async () => {
  const h = await boot();
  try {
    const res = await http(h.base, 'PUT', '/api/settings', { headers: master, body: { LOG_LEVEL: 'debug' } });
    assert.equal(res.status, 200);
    assert.deepEqual(h.calls.logLevel, ['debug']);
    assert.equal(h.settings.getEffective().LOG_LEVEL, 'debug');
  } finally {
    await h.close();
  }
});

test('saving PORT persists + reports pendingRestart; live config unchanged basis', async () => {
  const h = await boot();
  try {
    const res = await http(h.base, 'PUT', '/api/settings', { headers: master, body: { PORT: 4100 } });
    assert.equal(res.status, 200);
    const grouped = res.json as { restart: Array<{ key: string; pendingRestart?: boolean; value?: unknown }> };
    const portField = grouped.restart.find((f) => f.key === 'PORT');
    assert.ok(portField);
    assert.equal(portField!.pendingRestart, true);
    // No hot setter fired for a restart-only field.
    assert.deepEqual(h.calls.logLevel, []);
  } finally {
    await h.close();
  }
});

test('GET /api/settings never contains a plaintext secret (AC-25,29)', async () => {
  const h = await boot();
  try {
    await http(h.base, 'PUT', '/api/settings', {
      headers: master,
      body: { TEAMS_WEBHOOK_URL: 'https://hooks.example/super-secret-path' },
    });
    const res = await http(h.base, 'GET', '/api/settings', { headers: master });
    assert.equal(res.status, 200);
    assert.ok(!res.body.includes('super-secret-path'), 'secret value never echoed');
    const grouped = res.json as {
      hot: Array<{ key: string; masked: boolean; isSet?: boolean }>;
      restart: Array<{ key: string; masked: boolean; isSet?: boolean; value?: unknown }>;
    };
    const teams = grouped.hot.find((f) => f.key === 'TEAMS_WEBHOOK_URL');
    assert.ok(teams);
    assert.equal(teams!.masked, true);
    assert.equal(teams!.isSet, true);

    // The master API_KEY must never travel in cleartext (NFR-4/AC-25/AC-29).
    assert.ok(!res.body.includes(API_KEY), 'master API_KEY never echoed');
    const apiKeyField = grouped.restart.find((f) => f.key === 'API_KEY');
    assert.ok(apiKeyField, 'API_KEY rendered as a masked field');
    assert.equal(apiKeyField!.masked, true);
    assert.equal(apiKeyField!.isSet, true);
    assert.ok(!('value' in apiKeyField!), 'API_KEY carries no value property');
  } finally {
    await h.close();
  }
});

test('GET /api/settings masks BASIC_USER/BASIC_PASS and the master key (AC-25,29)', async () => {
  const BASIC_USER = 'operator';
  const BASIC_PASS = 'SECRET-BASIC-PASS';
  const parsed = parseConfig({ AUTH_MODE: 'basic', BASIC_USER, BASIC_PASS });
  assert.ok(parsed.success);
  const base = parsed.data;
  const { logger } = recordingLogger();
  const fs = fakeFs();
  const settingsStore = new SettingsStore({ file: 'config/settings.json', logger, ...fs });
  const secretsStore = new SecretsStore({ file: 'config/secrets.json', logger, ...fs });
  await settingsStore.load();
  await secretsStore.load();
  const handles: SettingsHandles = {
    teams: { reconfigure: () => {} },
    email: { reconfigure: () => {} },
    engine: { setDefaultCooldownSec: () => {} },
    digest: { setEnabled: () => {}, setDigestHour: () => {} },
    errors: { setLogAppend: () => {} },
    logger,
  };
  const settings = new SettingsService({ settingsStore, secretsStore, base, handles });
  const grouped = settings.readEffective();
  const all = [...grouped.hot, ...grouped.restart];
  for (const key of ['BASIC_USER', 'BASIC_PASS']) {
    const field = all.find((f) => f.key === key);
    assert.ok(field, `${key} rendered`);
    assert.equal(field!.masked, true, `${key} masked`);
    assert.equal(field!.isSet, true, `${key} isSet`);
    assert.ok(!('value' in field!), `${key} carries no value`);
  }
  const serialized = JSON.stringify(grouped);
  assert.ok(!serialized.includes(BASIC_PASS), 'BASIC_PASS value never serialized');
});

test('DELETE /secrets/:field clears; unknown field -> 400', async () => {
  const h = await boot();
  try {
    await http(h.base, 'PUT', '/api/settings', {
      headers: master,
      body: { AGENT_TOKEN: 'tok-value' },
    });
    const del = await http(h.base, 'DELETE', '/api/settings/secrets/AGENT_TOKEN', { headers: master });
    assert.equal(del.status, 200);
    const bad = await http(h.base, 'DELETE', '/api/settings/secrets/NOPE', { headers: master });
    assert.equal(bad.status, 400);
  } finally {
    await h.close();
  }
});

// --- no secret/raw-key material in logs (AC-29) ---

test('a full generate+save+clear flow leaks no rawKey/secret into logs', async () => {
  const h = await boot();
  try {
    const gen = await http(h.base, 'POST', '/api/settings/keys', { headers: master, body: { label: 'ci' } });
    const created = gen.json as { rawKey: string };
    await http(h.base, 'PUT', '/api/settings', {
      headers: master,
      body: { AGENT_TOKEN: 'tok-secret-value', TEAMS_WEBHOOK_URL: 'https://hooks.example/leak-check' },
    });
    await http(h.base, 'DELETE', '/api/settings/secrets/AGENT_TOKEN', { headers: master });

    const logged = h.logLines.join('\n');
    assert.ok(!logged.includes(created.rawKey), 'raw key never logged');
    assert.ok(!logged.includes('tok-secret-value'), 'secret value never logged');
    assert.ok(!logged.includes('leak-check'), 'webhook URL never logged');
  } finally {
    await h.close();
  }
});
