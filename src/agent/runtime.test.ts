import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntime } from './runtime.js';
import { MonitorEvents } from '../core/events.js';
import { MonitorState } from '../core/state.js';
import { MetricsStore } from '../metrics/store.js';
import { ErrorTracker } from '../errors/tracker.js';
import { buildSchemas, type RequestSchemas } from '../api/schemas.js';
import { createLogger } from '../core/logger.js';
import { FakePm2Client, makeSnapshot } from '../testutil/fakePm2Client.js';
import type { ProtocolMessage } from '../protocol/messages.js';
import type { ControlResult } from '../pm2/client.js';

const silentLogger = createLogger({ level: 'error', sink: () => {} });

interface Harness {
  runtime: AgentRuntime;
  events: MonitorEvents;
  state: MonitorState;
  pm2: FakePm2Client;
  sent: ProtocolMessage[];
  fire: () => void;
}

function makeHarness(opts: { schemas?: RequestSchemas; connected?: () => boolean } = {}): Harness {
  const events = new MonitorEvents();
  const metrics = new MetricsStore({ retentionMin: 60, sampleSec: 5 });
  const errors = new ErrorTracker({ events, bufferSize: 100, logAppend: false, logger: silentLogger });
  const state = new MonitorState({ events, metrics, errors, now: () => 1000 });
  const pm2 = new FakePm2Client({ connected: true });
  const sent: ProtocolMessage[] = [];
  // A simple immediate timer so throttled snapshots flush synchronously here.
  const timerFns: Array<() => void> = [];
  const schemas =
    opts.schemas ?? buildSchemas({ fileExists: () => true });
  const runtime = new AgentRuntime({
    events,
    state,
    pm2: pm2 as unknown as import('../api/server.js').Pm2Deps,
    schemas,
    logger: silentLogger,
    send: (m) => sent.push(m),
    isConnected: opts.connected ?? (() => true),
    now: () => 1000,
    setTimer: (fn) => {
      timerFns.push(fn);
      return timerFns.length as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => {},
  });
  return { runtime, events, state, pm2, sent, fire: () => timerFns.splice(0).forEach((f) => f()) };
}

function sentOfType<T extends ProtocolMessage['type']>(
  sent: ProtocolMessage[],
  type: T,
): Extract<ProtocolMessage, { type: T }>[] {
  return sent.filter((m) => m.type === type) as Extract<ProtocolMessage, { type: T }>[];
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

test('valid control:request calls PM2 and returns a correlated response', async () => {
  const h = makeHarness();
  h.pm2.processes = [makeSnapshot({ name: 'api' })];
  h.runtime.handleMessage({ type: 'control:request', cid: 'c1', action: 'restart', name: 'api' });
  await flush();
  const responses = sentOfType(h.sent, 'control:response');
  assert.equal(responses.length, 1);
  assert.equal(responses[0].cid, 'c1');
  assert.equal(responses[0].result.ok, true);
  assert.deepEqual(h.pm2.controlCalls, [{ action: 'restart', name: 'api' }]);
});

test('invalid process name returns VALIDATION and never touches PM2', async () => {
  const h = makeHarness();
  h.runtime.handleMessage({ type: 'control:request', cid: 'c2', action: 'stop', name: 'bad name!' });
  await flush();
  const responses = sentOfType(h.sent, 'control:response');
  assert.equal(responses.length, 1);
  const r = responses[0].result as ControlResult;
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'VALIDATION');
  assert.equal(h.pm2.controlCalls.length, 0, 'PM2 must not be called on validation failure');
});

test('control:createRequest uses the { body } wrapper and reaches startNew', async () => {
  const h = makeHarness();
  h.runtime.handleMessage({
    type: 'control:createRequest',
    cid: 'c3',
    opts: { script: '/srv/app.js', name: 'app' },
  });
  await flush();
  const responses = sentOfType(h.sent, 'control:response');
  assert.equal(responses.length, 1);
  assert.equal(responses[0].result.ok, true);
  assert.equal(h.pm2.startNewCalls.length, 1);
  assert.equal(h.pm2.startNewCalls[0].script, '/srv/app.js');
});

test('instances>1 with no exec_mode is transformed to cluster before startNew', async () => {
  const h = makeHarness();
  h.runtime.handleMessage({
    type: 'control:createRequest',
    cid: 'c4',
    opts: { script: '/srv/app.js', name: 'app', instances: 4 },
  });
  await flush();
  assert.equal(h.pm2.startNewCalls.length, 1);
  assert.equal(h.pm2.startNewCalls[0].exec_mode, 'cluster', 'cluster default injected by the transform');
});

test('a non-existent script on the agent disk is rejected with VALIDATION', async () => {
  const schemas = buildSchemas({ fileExists: () => false });
  const h = makeHarness({ schemas });
  h.runtime.handleMessage({
    type: 'control:createRequest',
    cid: 'c5',
    opts: { script: '/srv/missing.js', name: 'app' },
  });
  await flush();
  const r = sentOfType(h.sent, 'control:response')[0].result as ControlResult;
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'VALIDATION');
  assert.equal(h.pm2.startNewCalls.length, 0);
});

test('unknown keys in create opts are rejected by .strict()', async () => {
  const h = makeHarness();
  h.runtime.handleMessage({
    type: 'control:createRequest',
    cid: 'c6',
    // extra key not in the schema
    opts: { script: '/srv/app.js', bogus: true } as never,
  });
  await flush();
  const r = sentOfType(h.sent, 'control:response')[0].result as ControlResult;
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'VALIDATION');
  assert.equal(h.pm2.startNewCalls.length, 0);
});

test('a control before PM2 attaches returns a correlated PM2_UNAVAILABLE', async () => {
  const h = makeHarness();
  // Simulate the deferred facade: not connected to PM2 yet.
  h.pm2.connected = false;
  h.runtime.handleMessage({ type: 'control:request', cid: 'c7', action: 'restart', name: 'api' });
  await flush();
  const r = sentOfType(h.sent, 'control:response')[0].result as ControlResult;
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'PM2_UNAVAILABLE');
});

test('onRegistered sends an initial snapshot', () => {
  const h = makeHarness();
  h.state.applyPm2List([makeSnapshot({ name: 'api' })]);
  h.sent.length = 0; // ignore the state:update emitted above
  h.runtime.onRegistered();
  const snaps = sentOfType(h.sent, 'snapshot');
  assert.equal(snaps.length, 1);
  assert.equal(snaps[0].processes[0].name, 'api');
});

test('a process-set change triggers a throttled snapshot resend', () => {
  const h = makeHarness();
  h.runtime.onRegistered(); // establishes the initial (empty) name set
  h.sent.length = 0;
  // Adding a process changes the name set -> snapshot resend.
  h.state.applyPm2List([makeSnapshot({ name: 'api' })]);
  const snaps = sentOfType(h.sent, 'snapshot');
  assert.equal(snaps.length, 1, 'process-set change resends a snapshot');
  assert.equal(snaps[0].processes[0].name, 'api');
});

test('a pure metrics tick forwards update:metrics for online processes only', () => {
  const h = makeHarness();
  h.events.emit('metrics:tick', [
    makeSnapshot({ name: 'api', status: 'online', cpu: 10, memory: 2048, lastUpdated: 999 }),
    makeSnapshot({ name: 'down', status: 'stopped', cpu: 0, memory: 0 }),
  ]);
  const metrics = sentOfType(h.sent, 'update:metrics');
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].samples.length, 1, 'only the online process is sampled');
  assert.deepEqual(metrics[0].samples[0], { name: 'api', ts: 999, cpu: 10, mem: 2048 });
});

test('frames are dropped while disconnected', () => {
  const h = makeHarness({ connected: () => false });
  h.events.emit('metrics:tick', [makeSnapshot({ name: 'api', status: 'online' })]);
  h.events.emit('process:transition', { name: 'api', from: 'stopped', to: 'online', at: 1 });
  assert.equal(h.sent.length, 0, 'nothing is sent when not registered');
});

test('pm2 connectivity transitions forward update:pm2', () => {
  const h = makeHarness();
  h.state.setConnected(true);
  const pm2Frames = sentOfType(h.sent, 'update:pm2');
  assert.ok(pm2Frames.some((f) => f.connected === true));
});
