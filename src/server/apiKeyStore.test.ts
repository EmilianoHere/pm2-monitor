import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ApiKeyStore, ApiKeyService, sha256hex } from './apiKeyStore.js';
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

const FILE = 'config/api-keys.json';
let clock = 1000;
const now = () => clock;

test('generate persists hash+prefix+meta and NOT the raw key (AC-12)', async () => {
  clock = 5000;
  const fs = fakeFs();
  const store = new ApiKeyStore({ file: FILE, logger: silent, now, ...fs });
  await store.load();
  const key = await store.generate('ci');

  const onDisk = JSON.parse(fs.files.get(FILE)!) as { keys: Array<Record<string, unknown>> };
  assert.equal(onDisk.keys.length, 1);
  const rec = onDisk.keys[0];
  assert.equal(rec.label, 'ci');
  assert.equal(rec.status, 'active');
  assert.equal(rec.createdAt, 5000);
  assert.equal(rec.hash, sha256hex(key.rawKey), 'stored hash matches sha256(rawKey)');
  assert.ok(/^pmk_/.test(rec.prefix as string));
  // The raw key appears nowhere on disk.
  assert.ok(!fs.files.get(FILE)!.includes(key.rawKey), 'raw key never persisted');
});

test('list omits the raw key and the full hash (AC-13)', async () => {
  const fs = fakeFs();
  const store = new ApiKeyStore({ file: FILE, logger: silent, now, ...fs });
  await store.load();
  const key = await store.generate('ci');
  const rows = store.list();
  assert.equal(rows.length, 1);
  const row = rows[0] as unknown as Record<string, unknown>;
  assert.deepEqual(Object.keys(row).sort(), ['createdAt', 'id', 'label', 'prefix', 'status'].sort());
  assert.ok(!('hash' in row));
  assert.ok(!('rawKey' in row));
  assert.ok(!JSON.stringify(rows).includes(key.rawKey));
});

test('revoke removes the hash from activeHashes() (AC-14)', async () => {
  const fs = fakeFs();
  const store = new ApiKeyStore({ file: FILE, logger: silent, now, ...fs });
  await store.load();
  const key = await store.generate('ci');
  const h = sha256hex(key.rawKey);
  assert.ok(store.activeHashes().includes(h));
  assert.equal(await store.revoke(key.id), true);
  assert.ok(!store.activeHashes().includes(h), 'revoked hash gone from active set');
  assert.equal(store.list()[0].status, 'revoked');
  assert.equal(await store.revoke('no-such-id'), false);
});

test('relabel changes only the label; hash unchanged (AC-15)', async () => {
  const fs = fakeFs();
  const store = new ApiKeyStore({ file: FILE, logger: silent, now, ...fs });
  await store.load();
  const key = await store.generate('old');
  const h = sha256hex(key.rawKey);
  assert.equal(await store.relabel(key.id, 'new'), true);
  assert.equal(store.list()[0].label, 'new');
  assert.ok(store.activeHashes().includes(h), 'hash still authenticates after relabel');
  assert.equal(await store.relabel('no-such-id', 'x'), false);
});

test('reloads persisted keys after a simulated restart', async () => {
  const fs = fakeFs();
  const first = new ApiKeyStore({ file: FILE, logger: silent, now, ...fs });
  await first.load();
  const key = await first.generate('ci');

  const second = new ApiKeyStore({ file: FILE, logger: silent, now, ...fs });
  await second.load();
  assert.ok(second.activeHashes().includes(sha256hex(key.rawKey)));
  assert.equal(second.list()[0].label, 'ci');
});

test('corrupt file -> empty + warn, no crash (AC-17)', async () => {
  const fs = fakeFs({ [FILE]: '{ not json' });
  const { logger, records } = recordingLogger();
  const store = new ApiKeyStore({ file: FILE, logger, now, ...fs });
  await store.load();
  assert.deepEqual(store.list(), []);
  assert.ok(records.some((r) => r.level === 'warn' && r.msg.includes('not valid JSON')));
});

test('schema-invalid file -> empty + warn', async () => {
  const fs = fakeFs({ [FILE]: JSON.stringify({ keys: [{ id: 'x', hash: 'short' }] }) });
  const { logger, records } = recordingLogger();
  const store = new ApiKeyStore({ file: FILE, logger, now, ...fs });
  await store.load();
  assert.deepEqual(store.list(), []);
  assert.ok(records.some((r) => r.level === 'warn' && r.msg.includes('failed validation')));
});

test('write failure -> keep in-memory + warn (no crash) (AC-17)', async () => {
  const { logger, records } = recordingLogger();
  const store = new ApiKeyStore({
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
  const key = await store.generate('ci'); // resolves despite the failure
  assert.ok(store.activeHashes().includes(sha256hex(key.rawKey)), 'kept in memory');
  assert.ok(records.some((r) => r.level === 'warn' && r.msg.includes('failed to persist')));
});

test('each write goes to temp then rename, with 0o600 mode (AC-26)', async () => {
  const fs = fakeFs();
  const store = new ApiKeyStore({ file: FILE, logger: silent, now, ...fs });
  await store.load();
  await store.generate('ci');
  assert.deepEqual(fs.writes.map((w) => w.file), [`${FILE}.tmp`], 'wrote to temp only');
  assert.equal(fs.writes[0].opts?.mode, 0o600, 'temp written 0o600');
  assert.ok(fs.chmods.some((c) => c.file === FILE && c.mode === 0o600), 'chmod 0o600 on create');
});

test('concurrent double-generate converges (both persisted) (AC-30)', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let writeCount = 0;
  const files = new Map<string, string>();
  const store = new ApiKeyStore({
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
  const onDisk = JSON.parse(files.get(FILE)!) as { keys: unknown[] };
  assert.equal(onDisk.keys.length, 2, 'file converged to both keys');
});

test('two generations never collide on id or raw key (AC-18)', async () => {
  const fs = fakeFs();
  const store = new ApiKeyStore({ file: FILE, logger: silent, now, ...fs });
  await store.load();
  const a = await store.generate('a');
  const b = await store.generate('b');
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.rawKey, b.rawKey);
  assert.notEqual(sha256hex(a.rawKey), sha256hex(b.rawKey));
});

test('ApiKeyService delegates to the store', async () => {
  const fs = fakeFs();
  const store = new ApiKeyStore({ file: FILE, logger: silent, now, ...fs });
  await store.load();
  const svc = new ApiKeyService(store);
  const key = await svc.generate('ci');
  assert.equal(svc.list().length, 1);
  assert.deepEqual(svc.activeHashes(), [createHash('sha256').update(key.rawKey).digest('hex')]);
  assert.equal(await svc.revoke(key.id), true);
  assert.deepEqual(svc.activeHashes(), []);
});
