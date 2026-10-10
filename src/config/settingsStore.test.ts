import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SettingsStore, SettingsValidationError } from './settingsStore.js';
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

function fakeFs(seed?: Record<string, string>) {
  const files = new Map<string, string>(seed ? Object.entries(seed) : []);
  const writes: Array<{ file: string; opts?: { mode?: number } }> = [];
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
    writeFile: async (f: string, data: string, opts?: { mode?: number }): Promise<void> => {
      writes.push({ file: f, opts });
      files.set(f, data);
    },
    rename: async (from: string, to: string): Promise<void> => {
      renames.push({ from, to });
      const v = files.get(from);
      if (v === undefined) throw new Error('ENOENT temp');
      files.set(to, v);
      files.delete(from);
    },
    chmod: async (): Promise<void> => {},
  };
}

const FILE = 'config/settings.json';

test('setMany persists via atomic temp+rename with 0o600 (AC-30)', async () => {
  const fs = fakeFs();
  const store = new SettingsStore({ file: FILE, logger: silent, ...fs });
  await store.load();
  await store.setMany({ LOG_LEVEL: 'debug', DEFAULT_COOLDOWN_SEC: 120 });
  assert.deepEqual(store.get(), { LOG_LEVEL: 'debug', DEFAULT_COOLDOWN_SEC: 120 });
  assert.deepEqual(fs.writes.map((w) => w.file), [`${FILE}.tmp`]);
  assert.equal(fs.writes[0].opts?.mode, 0o600);
  assert.deepEqual(fs.renames, [{ from: `${FILE}.tmp`, to: FILE }]);
});

test('invalid shape -> empty + warn (AC-31)', async () => {
  const fs = fakeFs({ [FILE]: JSON.stringify({ LOG_LEVEL: 'nope' }) });
  const { logger, records } = recordingLogger();
  const store = new SettingsStore({ file: FILE, logger, ...fs });
  await store.load();
  assert.deepEqual(store.get(), {});
  assert.ok(records.some((r) => r.level === 'warn' && r.msg.includes('failed validation')));
});

test('corrupt JSON -> empty + warn', async () => {
  const fs = fakeFs({ [FILE]: '{ nope' });
  const { logger, records } = recordingLogger();
  const store = new SettingsStore({ file: FILE, logger, ...fs });
  await store.load();
  assert.deepEqual(store.get(), {});
  assert.ok(records.some((r) => r.level === 'warn' && r.msg.includes('not valid JSON')));
});

test('setMany rejects a secret key (never lands in settings.json)', async () => {
  const fs = fakeFs();
  const store = new SettingsStore({ file: FILE, logger: silent, ...fs });
  await store.load();
  await assert.rejects(
    () => store.setMany({ SMTP_PASS: 'x' } as never),
    SettingsValidationError,
  );
  assert.deepEqual(store.get(), {});
  assert.equal(fs.files.has(FILE), false, 'nothing written');
});

test('setMany rejects an unknown key (strict)', async () => {
  const fs = fakeFs();
  const store = new SettingsStore({ file: FILE, logger: silent, ...fs });
  await store.load();
  await assert.rejects(() => store.setMany({ NOPE: 1 } as never), SettingsValidationError);
  assert.deepEqual(store.get(), {});
});

test('reloads overlay after a restart; get() is a copy', async () => {
  const fs = fakeFs();
  const first = new SettingsStore({ file: FILE, logger: silent, ...fs });
  await first.load();
  await first.setMany({ LOG_LEVEL: 'warn' });
  const copy = first.get();
  copy.LOG_LEVEL = 'error';
  assert.equal(first.get().LOG_LEVEL, 'warn', 'get() returns a shallow copy');

  const second = new SettingsStore({ file: FILE, logger: silent, ...fs });
  await second.load();
  assert.equal(second.get().LOG_LEVEL, 'warn');
});
