import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AliasStore, AliasValidationError } from './aliasStore.js';
import { createLogger } from '../core/logger.js';

const silentLogger = createLogger({ level: 'error', sink: () => {} });

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

/** An in-memory fake fs honoring the write-to-temp-then-rename contract. */
function fakeFs(seed?: Record<string, string>) {
  const files = new Map<string, string>(seed ? Object.entries(seed) : []);
  const writes: string[] = [];
  const renames: Array<{ from: string; to: string }> = [];
  return {
    files,
    writes,
    renames,
    readFile: async (f: string): Promise<string> => {
      const v = files.get(f);
      if (v === undefined) throw new Error('ENOENT');
      return v;
    },
    writeFile: async (f: string, data: string): Promise<void> => {
      writes.push(f);
      files.set(f, data);
    },
    rename: async (from: string, to: string): Promise<void> => {
      renames.push({ from, to });
      const v = files.get(from);
      if (v === undefined) throw new Error('ENOENT temp');
      files.set(to, v);
      files.delete(from);
    },
  };
}

const FILE = 'config/agent-aliases.json';

test('set() then get() sees the new value and persists to disk', async () => {
  const fs = fakeFs();
  const store = new AliasStore({ file: FILE, logger: silentLogger, ...fs });
  await store.load();
  await store.set('web-01', 'Production Web');
  assert.equal(store.get('web-01'), 'Production Web');
  assert.deepEqual(JSON.parse(fs.files.get(FILE)!), { 'web-01': 'Production Web' });
});

test('reloads persisted aliases after a simulated restart', async () => {
  const fs = fakeFs();
  const first = new AliasStore({ file: FILE, logger: silentLogger, ...fs });
  await first.load();
  await first.set('web-01', 'Web One');
  await first.set('db-02', 'Database Two');

  // New instance over the SAME backing files = a restart.
  const second = new AliasStore({ file: FILE, logger: silentLogger, ...fs });
  await second.load();
  assert.equal(second.get('web-01'), 'Web One');
  assert.equal(second.get('db-02'), 'Database Two');
  assert.deepEqual(second.all(), { 'web-01': 'Web One', 'db-02': 'Database Two' });
});

test('missing file loads as empty and continues', async () => {
  const fs = fakeFs();
  const store = new AliasStore({ file: FILE, logger: silentLogger, ...fs });
  await store.load();
  assert.deepEqual(store.all(), {});
  assert.equal(store.get('anything'), undefined);
});

test('corrupt JSON warns and loads empty without crashing', async () => {
  const fs = fakeFs({ [FILE]: '{ not json' });
  const { logger, records } = recordingLogger();
  const store = new AliasStore({ file: FILE, logger, ...fs });
  await store.load();
  assert.deepEqual(store.all(), {});
  assert.ok(records.some((r) => r.level === 'warn' && r.msg.includes('not valid JSON')));
});

test('schema-invalid file warns and loads empty without crashing', async () => {
  // A control char in a value fails aliasSchema validation.
  const fs = fakeFs({ [FILE]: JSON.stringify({ 'web-01': 'bad\nname' }) });
  const { logger, records } = recordingLogger();
  const store = new AliasStore({ file: FILE, logger, ...fs });
  await store.load();
  assert.deepEqual(store.all(), {});
  assert.ok(records.some((r) => r.level === 'warn' && r.msg.includes('failed validation')));
});

test('invalid alias is rejected and not persisted', async () => {
  const fs = fakeFs();
  const store = new AliasStore({ file: FILE, logger: silentLogger, ...fs });
  await store.load();
  await assert.rejects(() => store.set('web-01', '   '), AliasValidationError);
  assert.equal(store.get('web-01'), undefined);
  assert.equal(fs.files.has(FILE), false, 'nothing written');
});

test('an unknown agent id is accepted and persisted (pre-seeding)', async () => {
  const fs = fakeFs();
  const store = new AliasStore({ file: FILE, logger: silentLogger, ...fs });
  await store.load();
  await store.set('never-connected', 'Future Agent');
  assert.equal(store.get('never-connected'), 'Future Agent');
  assert.deepEqual(JSON.parse(fs.files.get(FILE)!), { 'never-connected': 'Future Agent' });
});

test('each physical write goes to a temp file then renames (atomic)', async () => {
  const fs = fakeFs();
  const store = new AliasStore({ file: FILE, logger: silentLogger, ...fs });
  await store.load();
  await store.set('web-01', 'Web');
  assert.deepEqual(fs.writes, [`${FILE}.tmp`], 'wrote to temp, never directly to the target');
  assert.deepEqual(fs.renames, [{ from: `${FILE}.tmp`, to: FILE }]);
  assert.equal(fs.files.has(`${FILE}.tmp`), false, 'temp removed by rename');
});

test('concurrent sets coalesce to the LATEST value under a slow write', async () => {
  // A gated write lets us land several set()s while the first write is pending.
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let writeCount = 0;
  const files = new Map<string, string>();
  const store = new AliasStore({
    file: FILE,
    logger: silentLogger,
    readFile: async () => {
      throw new Error('ENOENT');
    },
    writeFile: async (f, data) => {
      writeCount += 1;
      if (writeCount === 1) await gate; // hold the first physical write open
      files.set(f, data);
    },
    rename: async (from, to) => {
      const v = files.get(from)!;
      files.set(to, v);
      files.delete(from);
    },
  });
  await store.load();

  const p1 = store.set('web-01', 'v1'); // starts the (held) first write
  const p2 = store.set('web-01', 'v2'); // lands while write 1 is in flight
  const p3 = store.set('web-01', 'v3'); // also lands while in flight
  // get() right after set() sees the newest value before the write settles.
  assert.equal(store.get('web-01'), 'v3');

  release(); // let the first write finish; a re-flush of the latest follows
  await Promise.all([p1, p2, p3]);

  assert.equal(JSON.parse(files.get(FILE)!)['web-01'], 'v3', 'file converged to the latest');
});

test('write failure warns and keeps the in-memory value (no crash)', async () => {
  const { logger, records } = recordingLogger();
  const store = new AliasStore({
    file: FILE,
    logger,
    readFile: async () => {
      throw new Error('ENOENT');
    },
    writeFile: async () => {
      throw new Error('EACCES');
    },
    rename: async () => {},
  });
  await store.load();
  await store.set('web-01', 'Kept In Memory'); // resolves despite the failure
  assert.equal(store.get('web-01'), 'Kept In Memory');
  assert.ok(records.some((r) => r.level === 'warn' && r.msg.includes('failed to persist')));
});
