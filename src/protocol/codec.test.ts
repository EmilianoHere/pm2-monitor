import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode } from './codec.js';
import type { ProtocolMessage } from './messages.js';
import type { ProcessSnapshot } from '../core/types.js';

const snap: ProcessSnapshot = {
  pmId: 1,
  name: 'api',
  pid: 1234,
  status: 'online',
  cpu: 12.5,
  memory: 1048576,
  uptimeMs: 60000,
  restarts: 0,
  unstableRestarts: 0,
  mode: 'cluster',
  instances: 2,
  execPath: '/opt/app/index.js',
  lastUpdated: 1700000000000,
};

const frames: ProtocolMessage[] = [
  {
    type: 'register',
    protocolVersion: 1,
    agentId: 'host-ab12cd34',
    token: 'secret-token',
    meta: { hostname: 'host', platform: 'linux', monitorVersion: '1.0.0', nameHint: 'prod' },
  },
  { type: 'register:ack', ok: true, serverTime: 1700000000000, heartbeatSec: 15 },
  { type: 'register:nack', ok: false, code: 'AUTH_FAILED', message: 'bad token' },
  { type: 'register:nack', ok: false, code: 'VERSION_MISMATCH', message: 'v1 only' },
  { type: 'heartbeat', ts: 1700000000000 },
  { type: 'heartbeat:ack', ts: 1700000000000 },
  { type: 'snapshot', processes: [snap], pm2Connected: true, generatedAt: 1700000000000 },
  { type: 'update:transition', name: 'api', from: 'launching', to: 'online', at: 1700000000000 },
  {
    type: 'update:metrics',
    samples: [{ name: 'api', ts: 1700000000000, cpu: 10, mem: 2048 }],
  },
  {
    type: 'update:error',
    error: {
      signature: 'sig',
      processName: 'api',
      firstSeen: 1,
      lastSeen: 2,
      count: 3,
      level: 'crash',
      message: 'boom',
      sample: 'stack',
    },
  },
  { type: 'update:pm2', connected: false },
  { type: 'control:request', cid: 'c1', action: 'restart', name: 'api' },
  { type: 'control:createRequest', cid: 'c2', opts: { script: '/opt/app/index.js', name: 'api' } },
  { type: 'control:response', cid: 'c1', result: { ok: true, process: snap } },
  {
    type: 'control:response',
    cid: 'c2',
    result: { ok: false, code: 'AGENT_TIMEOUT', message: 'no response' },
  },
  { type: 'log:subscribe', process: 'api', streams: ['out', 'err'] },
  { type: 'log:unsubscribe', process: 'api' },
  { type: 'log:line', process: 'api', stream: 'out', level: 'info', line: 'hello', ts: 1 },
  { type: 'error:frame', code: 'BAD_MESSAGE', message: 'nope' },
];

test('encode -> decode round-trips every frame', () => {
  for (const frame of frames) {
    const result = decode(encode(frame));
    assert.equal(result.ok, true, `frame ${frame.type} should decode`);
    if (result.ok) {
      assert.deepEqual(result.msg, frame);
    }
  }
});

test('decode returns BAD_MESSAGE and never throws for invalid JSON', () => {
  const result = decode('{not json');
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'BAD_MESSAGE');
});

test('decode rejects a missing type', () => {
  const result = decode(JSON.stringify({ ts: 1 }));
  assert.equal(result.ok, false);
});

test('decode rejects an unknown type', () => {
  const result = decode(JSON.stringify({ type: 'nope', ts: 1 }));
  assert.equal(result.ok, false);
});

test('decode rejects a schema-invalid payload (heartbeat without ts)', () => {
  const result = decode(JSON.stringify({ type: 'heartbeat' }));
  assert.equal(result.ok, false);
});

test('decode rejects a blank token in register', () => {
  const result = decode(
    JSON.stringify({
      type: 'register',
      protocolVersion: 1,
      agentId: 'host-ab12',
      token: '',
      meta: { hostname: 'h', platform: 'linux', monitorVersion: '1.0.0' },
    }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'BAD_MESSAGE');
});

test('decode rejects a charset-malformed agentId in register', () => {
  const result = decode(
    JSON.stringify({
      type: 'register',
      protocolVersion: 1,
      agentId: 'bad id/with spaces',
      token: 't',
      meta: { hostname: 'h', platform: 'linux', monitorVersion: '1.0.0' },
    }),
  );
  assert.equal(result.ok, false);
});

test('decode rejects a blank agentId in register', () => {
  const result = decode(
    JSON.stringify({
      type: 'register',
      protocolVersion: 1,
      agentId: '',
      token: 't',
      meta: { hostname: 'h', platform: 'linux', monitorVersion: '1.0.0' },
    }),
  );
  assert.equal(result.ok, false);
});

test('decode never throws on arbitrary garbage', () => {
  for (const raw of ['', '   ', 'null', '123', '"string"', '[]', '{}']) {
    assert.doesNotThrow(() => decode(raw));
    assert.equal(decode(raw).ok, false);
  }
});
