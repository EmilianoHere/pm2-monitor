import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AgentTokenStore, AgentTokenService } from './agentTokenStore.js';
import { sha256hex } from './apiKeyStore.js';
import { createLogger } from '../core/logger.js';

const silent = createLogger({ level: 'error', sink: () => {} });

function recordingLogger() {
  const records: Array<{ level: string; msg: string }> = [];
  const logger = createLogger({
    level: 'debug',
    sink: (line) => {
      const rec = JSON.parse(line) as { level: string; msg: string };
      records.push({ level: rec.level, msg: rec.msg });
    },
  });
  return { logger, records };
}

/** An in-memory fake fs recording write opts (to assert 0o600). */
function fakeFs(seed?: Record<string, string>) {
  const files = new Map<string, string>(seed ? Object.entries(seed) : []);
  const writes: Array<{ file: string; opts?: { mode?: number } }> = [];
  const chmods: Array<{ file: string; mode: number }> = [];
  return {
    files,
    writes,
    chmods,
    readFile: async (f: string): Promise<string> => {
      const v = files.get(f);
      if (v === undefined) throw new Error('ENOENT');
      return v;
    },
    writeFile: async (f: string, data: string, opts?: { mode?: number }): Promise<void> => {
      writes.push({ file: f, opts });
      files.set(f, data);
    },
    rename: async (from: string, to: string): Promise<void> => {
      const v = files.get(from);
      if (v === undefined) throw new Error('ENOENT temp');
      files.set(to, v);
      files.delete(from);
    },
    chmod: async (f: string, mode: number): Promise<void> => {
      chmods.push({ file: f, mode });
    },
  };
}

const FILE = 'config/agent-tokens.json';
let clock = 1000;
const now = () => clock;

test('generate returns rawToken once + persists 64-hex hash + pmat_ prefix, NOT the raw (AC-1)', async () => {
  clock = 5000;
  const fs = fakeFs();
  const store = new AgentTokenStore({ file: FILE, logger: silent, now, ...fs });
  await store.load();
  const token = await store.generate('web-01');

  const onDisk = JSON.parse(fs.files.get(FILE)!) as { tokens: Array<Record<string, unknown>> };
  assert.equal(onDisk.tokens.length, 1);
  const rec = onDisk.tokens[0];
  assert.equal(rec.label, 'web-01');
  assert.equal(rec.status, 'active');
  assert.equal(rec.createdAt, 5000);
  assert.ok(/^[0-9a-f]{64}$/.test(rec.hash as string), 'stored hash is 64-hex');
  assert.equal(rec.hash, sha256hex(token.rawToken), 'stored hash matches sha256(rawToken)');
  assert.ok(/^pmat_/.test(rec.prefix as string), 'prefix is pmat_');
  assert.ok(!fs.files.get(FILE)!.includes(token.rawToken), 'raw token never persisted');
});

test('list masks: omits the raw token and the full hash (AC-2)', async () => {
  const fs = fakeFs();
  const store = new AgentTokenStore({ file: FILE, logger: silent, now, ...fs });
  await store.load();
  const token = await store.generate('web-01');
  const rows = store.list();
  assert.equal(rows.length, 1);
  const row = rows[0] as unknown as Record<string, unknown>;
  assert.deepEqual(Object.keys(row).sort(), ['createdAt', 'id', 'label', 'prefix', 'status'].sort());
  assert.ok(!('hash' in row));
  assert.ok(!('rawToken' in row));
  assert.ok(!JSON.stringify(rows).includes(token.rawToken));
});

test('activeHashes excludes revoked and rebuilds on load/mutate (AC-3)', async () => {
  const fs = fakeFs();
  const store = new AgentTokenStore({ file: FILE, logger: silent, now, ...fs });
  await store.load();
  const token = await store.generate('web-01');
  const h = sha256hex(token.rawToken);
  assert.ok(store.activeHashes().includes(h));
  assert.equal(await store.revoke(token.id), true);
  assert.ok(!store.activeHashes().includes(h), 'revoked hash gone from active set');
  assert.equal(store.list()[0].status, 'revoked');
  assert.equal(await store.revoke('no-such-id'), false);

  // Rebuilds on load: a fresh store reading the same disk reconstructs the set.
  const reloaded = new AgentTokenStore({ file: FILE, logger: silent, now, ...fs });
  await reloaded.load();
  assert.ok(!reloaded.activeHashes().includes(h), 'revoked token stays excluded after reload');
});

test('relabel changes only the label; hash/prefix/id unchanged (round-trip holds)', async () => {
  const fs = fakeFs();
  const store = new AgentTokenStore({ file: FILE, logger: silent, now, ...fs });
  await store.load();
  const token = await store.generate('old');
  const h = sha256hex(token.rawToken);
  assert.equal(await store.relabel(token.id, 'new'), true);
  const row = store.list()[0];
  assert.equal(row.label, 'new');
  assert.equal(row.prefix, token.prefix, 'prefix unchanged');
  assert.equal(row.id, token.id, 'id unchanged');
  assert.ok(store.activeHashes().includes(h), 'hash still authenticates after relabel');
  assert.equal(await store.relabel('no-such-id', 'x'), false);
});

test('reloads persisted tokens after a simulated restart', async () => {
  const fs = fakeFs();
  const first = new AgentTokenStore({ file: FILE, logger: silent, now, ...fs });
  await first.load();
  const token = await first.generate('web-01');

  const second = new AgentTokenStore({ file: FILE, logger: silent, now, ...fs });
  await second.load();
  assert.ok(second.activeHashes().includes(sha256hex(token.rawToken)));
  assert.equal(second.list()[0].label, 'web-01');
});

test('missing file -> empty, no warn (AC-4)', async () => {
  const { logger, records } = recordingLogger();
  const store = new AgentTokenStore({
    file: FILE,
    logger,
    now,
    readFile: async () => {
      throw new Error('ENOENT');
    },
    writeFile: async () => {},
    rename: async () => {},
    chmod: async () => {},
  });
  await store.load();
  assert.deepEqual(store.list(), []);
  assert.equal(records.filter((r) => r.level === 'warn').length, 0, 'missing file does not warn');
});

test('corrupt file -> empty + warn, no crash (AC-4)', async () => {
  const fs = fakeFs({ [FILE]: '{ not json' });
  const { logger, records } = recordingLogger();
  const store = new AgentTokenStore({ file: FILE, logger, now, ...fs });
  await store.load();
  assert.deepEqual(store.list(), []);
  assert.ok(records.some((r) => r.level === 'warn' && r.msg.includes('not valid JSON')));
});

test('schema-invalid file -> empty + warn (AC-4)', async () => {
  const fs = fakeFs({ [FILE]: JSON.stringify({ tokens: [{ id: 'x', hash: 'short' }] }) });
  const { logger, records } = recordingLogger();
  const store = new AgentTokenStore({ file: FILE, logger, now, ...fs });
  await store.load();
  assert.deepEqual(store.list(), []);
  assert.ok(records.some((r) => r.level === 'warn' && r.msg.includes('failed validation')));
});

test('write failure -> keep in-memory + warn (no crash) (AC-4)', async () => {
  const { logger, records } = recordingLogger();
  const store = new AgentTokenStore({
    file: FILE,
    logger,
    now,
    readFile: async () => {
      throw new Error('ENOENT');
    },
    writeFile: async () => {
      throw new Error('EACCES');
    },
    rename: async () => {},
    chmod: async () => {},
  });
  await store.load();
  const token = await store.generate('web-01'); // resolves despite the failure
  assert.ok(store.activeHashes().includes(sha256hex(token.rawToken)), 'kept in memory');
  assert.ok(records.some((r) => r.level === 'warn' && r.msg.includes('failed to persist')));
});

test('each write goes to temp then rename, with 0o600 mode + chmod on create (AC-4)', async () => {
  const fs = fakeFs();
  const store = new AgentTokenStore({ file: FILE, logger: silent, now, ...fs });
  await store.load();
  await store.generate('web-01');
  assert.deepEqual(fs.writes.map((w) => w.file), [`${FILE}.tmp`], 'wrote to temp only');
  assert.equal(fs.writes[0].opts?.mode, 0o600, 'temp written 0o600');
  assert.ok(fs.chmods.some((c) => c.file === FILE && c.mode === 0o600), 'chmod 0o600 on create');
});

test('concurrent double-generate coalesces and converges (both persisted) (AC-5)', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let writeCount = 0;
  const files = new Map<string, string>();
  const store = new AgentTokenStore({
    file: FILE,
    logger: silent,
    now,
    readFile: async () => {
      throw new Error('ENOENT');
    },
    writeFile: async (f, data) => {
      writeCount += 1;
      if (writeCount === 1) await gate;
      files.set(f, data);
    },
    rename: async (from, to) => {
      const v = files.get(from)!;
      files.set(to, v);
      files.delete(from);
    },
    chmod: async () => {},
  });
  await store.load();
  const p1 = store.generate('a');
  const p2 = store.generate('b');
  release();
  await Promise.all([p1, p2]);
  const onDisk = JSON.parse(files.get(FILE)!) as { tokens: unknown[] };
  assert.equal(onDisk.tokens.length, 2, 'file converged to both tokens');
});

test('two generations never collide on id or raw token', async () => {
  const fs = fakeFs();
  const store = new AgentTokenStore({ file: FILE, logger: silent, now, ...fs });
  await store.load();
  const a = await store.generate('a');
  const b = await store.generate('b');
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.rawToken, b.rawToken);
  assert.notEqual(sha256hex(a.rawToken), sha256hex(b.rawToken));
});

test('sha256hex(rawToken) === stored hash round-trip', async () => {
  const fs = fakeFs();
  const store = new AgentTokenStore({ file: FILE, logger: silent, now, ...fs });
  await store.load();
  const token = await store.generate('rt');
  const onDisk = JSON.parse(fs.files.get(FILE)!) as { tokens: Array<{ hash: string }> };
  assert.equal(createHash('sha256').update(token.rawToken).digest('hex'), onDisk.tokens[0].hash);
});

test('AgentTokenService delegates to the store', async () => {
  const fs = fakeFs();
  const store = new AgentTokenStore({ file: FILE, logger: silent, now, ...fs });
  await store.load();
  const svc = new AgentTokenService(store);
  const token = await svc.generate('web-01');
  assert.equal(svc.list().length, 1);
  assert.deepEqual(svc.activeHashes(), [createHash('sha256').update(token.rawToken).digest('hex')]);
  assert.equal(await svc.revoke(token.id), true);
  assert.deepEqual(svc.activeHashes(), []);
});
