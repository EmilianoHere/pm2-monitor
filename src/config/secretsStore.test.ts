import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SecretsStore, SecretsValidationError } from './secretsStore.js';
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

const FILE = 'config/secrets.json';

test('setMany persists via atomic temp+rename with 0o600 (AC-30)', async () => {
  const fs = fakeFs();
  const store = new SecretsStore({ file: FILE, logger: silent, ...fs });
  await store.load();
  await store.setMany({ SMTP_PASS: 'swordfish' });
  assert.deepEqual(fs.writes.map((w) => w.file), [`${FILE}.tmp`]);
  assert.equal(fs.writes[0].opts?.mode, 0o600);
  assert.deepEqual(fs.renames, [{ from: `${FILE}.tmp`, to: FILE }]);
});

test('status() returns booleans, never the values', async () => {
  const fs = fakeFs();
  const store = new SecretsStore({ file: FILE, logger: silent, ...fs });
  await store.load();
  await store.setMany({ SMTP_PASS: 'swordfish', TEAMS_WEBHOOK_URL: 'https://hooks.example/x' });
  const status = store.status();
  assert.deepEqual(status, {
    SMTP_PASS: true,
    TEAMS_WEBHOOK_URL: true,
    AGENT_TOKEN: false,
    AGENT_TOKENS: false,
  });
  // No secret value appears in the status output.
  assert.ok(!JSON.stringify(status).includes('swordfish'));
});

test('clear() unsets a field (AC-27)', async () => {
  const fs = fakeFs();
  const store = new SecretsStore({ file: FILE, logger: silent, ...fs });
  await store.load();
  await store.setMany({ SMTP_PASS: 'swordfish', AGENT_TOKEN: 'tok' });
  await store.clear('SMTP_PASS');
  assert.equal(store.status().SMTP_PASS, false);
  assert.equal(store.status().AGENT_TOKEN, true);
  assert.ok(!JSON.stringify(store.get()).includes('swordfish'));
});

test('invalid shape -> empty + warn (AC-31)', async () => {
  const fs = fakeFs({ [FILE]: JSON.stringify({ TEAMS_WEBHOOK_URL: 'not-a-url' }) });
  const { logger, records } = recordingLogger();
  const store = new SecretsStore({ file: FILE, logger, ...fs });
  await store.load();
  assert.deepEqual(store.get(), {});
  assert.ok(records.some((r) => r.level === 'warn' && r.msg.includes('failed validation')));
});

test('setMany rejects a bad webhook URL', async () => {
  const fs = fakeFs();
  const store = new SecretsStore({ file: FILE, logger: silent, ...fs });
  await store.load();
  await assert.rejects(
    () => store.setMany({ TEAMS_WEBHOOK_URL: 'not-a-url' }),
    SecretsValidationError,
  );
  assert.deepEqual(store.get(), {});
});

test('reloads secrets after a restart', async () => {
  const fs = fakeFs();
  const first = new SecretsStore({ file: FILE, logger: silent, ...fs });
  await first.load();
  await first.setMany({ AGENT_TOKEN: 'tok' });
  const second = new SecretsStore({ file: FILE, logger: silent, ...fs });
  await second.load();
  assert.equal(second.status().AGENT_TOKEN, true);
});
