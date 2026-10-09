import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAgentId } from './identity.js';
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

test('generates and persists a new suffix when the file is missing', () => {
  const writes: Array<{ path: string; data: string }> = [];
  const { logger, records } = recordingLogger();
  const id = resolveAgentId({
    idFile: 'config/agent-id',
    hostname: 'web-01',
    logger,
    readFile: () => {
      throw new Error('ENOENT');
    },
    writeFile: (p, data) => writes.push({ path: p, data }),
    randomSuffix: () => 'deadbeef',
  });
  assert.equal(id, 'web-01-deadbeef');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].data, 'deadbeef');
  assert.ok(records.some((r) => r.level === 'info' && r.msg.includes('generated agent id suffix')));
});

test('reuses the same id when the suffix file already exists', () => {
  let wrote = false;
  const id = resolveAgentId({
    idFile: 'config/agent-id',
    hostname: 'web-01',
    logger: silentLogger,
    readFile: () => 'cafebabe\n',
    writeFile: () => {
      wrote = true;
    },
    randomSuffix: () => 'should-not-be-used',
  });
  assert.equal(id, 'web-01-cafebabe');
  assert.equal(wrote, false, 'an existing suffix must not be overwritten');
});

test('regenerates and logs info on an unreadable/empty file', () => {
  const { logger, records } = recordingLogger();
  const id = resolveAgentId({
    idFile: 'config/agent-id',
    hostname: 'web-01',
    logger,
    readFile: () => '   ',
    writeFile: () => {},
    randomSuffix: () => 'f00d',
  });
  assert.equal(id, 'web-01-f00d');
  assert.ok(records.some((r) => r.level === 'info' && r.msg.includes('generated agent id suffix')));
});

test('is stable across simulated restarts (persisted suffix survives)', () => {
  let stored: string | null = null;
  const readFile = (): string => {
    if (stored === null) throw new Error('ENOENT');
    return stored;
  };
  const writeFile = (_p: string, data: string): void => {
    stored = data;
  };
  const first = resolveAgentId({
    idFile: 'config/agent-id',
    hostname: 'host',
    logger: silentLogger,
    readFile,
    writeFile,
    randomSuffix: () => '0a0a0a0a',
  });
  const second = resolveAgentId({
    idFile: 'config/agent-id',
    hostname: 'host',
    logger: silentLogger,
    readFile,
    writeFile,
    randomSuffix: () => 'different',
  });
  assert.equal(first, second);
  assert.equal(first, 'host-0a0a0a0a');
});

test('sanitizes an unsafe hostname to the safe charset', () => {
  const id = resolveAgentId({
    idFile: 'config/agent-id',
    hostname: 'host with spaces/and:colons',
    logger: silentLogger,
    readFile: () => 'abcd',
    writeFile: () => {},
    randomSuffix: () => 'abcd',
  });
  assert.match(id, /^[A-Za-z0-9._-]+$/);
  assert.equal(id, 'host-with-spaces-and-colons-abcd');
});

test('falls back to an in-memory id and warns when the dir is unwritable', () => {
  const { logger, records } = recordingLogger();
  const id = resolveAgentId({
    idFile: '/root/forbidden/agent-id',
    hostname: 'host',
    logger,
    readFile: () => {
      throw new Error('ENOENT');
    },
    writeFile: () => {
      throw new Error('EACCES');
    },
    randomSuffix: () => 'aaaa',
  });
  assert.equal(id, 'host-aaaa');
  assert.ok(records.some((r) => r.level === 'warn' && r.msg.includes('could not persist')));
});
