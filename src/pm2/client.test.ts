import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MonitorEvents } from '../core/events.js';
import { MonitorState } from '../core/state.js';
import { MetricsStore } from '../metrics/store.js';
import { ErrorTracker } from '../errors/tracker.js';
import { createLogger } from '../core/logger.js';
import {
  Pm2Client,
  type AdapterCallback,
  type Pm2Adapter,
  type Pm2Bus,
} from './client.js';
import type { RawProcess } from './mapper.js';
import type { ProcessSnapshot, TrackedError } from '../core/types.js';

const silent = createLogger({ level: 'error', sink: () => {} });

// --- fake pm2 bus + adapter (no real daemon) ---

class FakeBus implements Pm2Bus {
  private handlers = new Map<string, Array<(packet: unknown) => void>>();

  on(channel: string, handler: (packet: unknown) => void): void {
    const list = this.handlers.get(channel) ?? [];
    list.push(handler);
    this.handlers.set(channel, list);
  }

  off(channel: string, handler: (packet: unknown) => void): void {
    const list = this.handlers.get(channel) ?? [];
    this.handlers.set(
      channel,
      list.filter((h) => h !== handler),
    );
  }

  close(): void {
    this.handlers.clear();
  }

  /** Test helper: deliver a packet to every subscriber of a channel. */
  emit(channel: string, packet: unknown): void {
    for (const h of this.handlers.get(channel) ?? []) h(packet);
  }
}

interface FakeAdapterOptions {
  describe?: Map<string, RawProcess[]>;
}

class FakeAdapter implements Pm2Adapter {
  readonly bus = new FakeBus();
  connectErr: Error | null = null;
  connectCalls = 0;
  disconnectCalls = 0;
  listResult: RawProcess[] = [];
  listErr: Error | null = null;
  controlCalls: Array<{ action: string; name: string }> = [];
  private describeMap: Map<string, RawProcess[]>;

  constructor(opts: FakeAdapterOptions = {}) {
    this.describeMap = opts.describe ?? new Map();
  }

  setDescribe(name: string, records: RawProcess[]): void {
    this.describeMap.set(name, records);
  }

  connect(cb: (err: Error | null) => void): void {
    this.connectCalls += 1;
    queueMicrotask(() => cb(this.connectErr));
  }

  disconnect(): void {
    this.disconnectCalls += 1;
  }

  list(cb: AdapterCallback<RawProcess[]>): void {
    queueMicrotask(() => cb(this.listErr, this.listResult));
  }

  describe(name: string, cb: AdapterCallback<RawProcess[]>): void {
    queueMicrotask(() => cb(null, this.describeMap.get(name) ?? []));
  }

  start(_options: Record<string, unknown>, cb: AdapterCallback<RawProcess[]>): void {
    queueMicrotask(() => cb(null, []));
  }

  startScript(name: string, cb: AdapterCallback<RawProcess[]>): void {
    this.controlCalls.push({ action: 'start', name });
    queueMicrotask(() => cb(null, []));
  }

  stop(name: string, cb: AdapterCallback<RawProcess[]>): void {
    this.controlCalls.push({ action: 'stop', name });
    queueMicrotask(() => cb(null, []));
  }

  restart(name: string, cb: AdapterCallback<RawProcess[]>): void {
    this.controlCalls.push({ action: 'restart', name });
    queueMicrotask(() => cb(null, []));
  }

  reload(name: string, cb: AdapterCallback<RawProcess[]>): void {
    this.controlCalls.push({ action: 'reload', name });
    queueMicrotask(() => cb(null, []));
  }

  del(name: string, cb: AdapterCallback<RawProcess[]>): void {
    this.controlCalls.push({ action: 'delete', name });
    queueMicrotask(() => cb(null, []));
  }

  launchBus(cb: AdapterCallback<Pm2Bus>): void {
    queueMicrotask(() => cb(null, this.bus));
  }
}

// --- harness ---

function proc(partial: Partial<ProcessSnapshot> & { name: string }): ProcessSnapshot {
  return {
    pmId: 0,
    pid: 1,
    status: 'online',
    cpu: 1,
    memory: 1,
    uptimeMs: 1,
    restarts: 0,
    unstableRestarts: 0,
    mode: 'fork',
    instances: 1,
    execPath: '/x.js',
    lastUpdated: 0,
    ...partial,
  };
}

function makeHarness(nowRef: { t: number }, instances = 1) {
  const events = new MonitorEvents();
  const now = () => nowRef.t;
  const metrics = new MetricsStore({ retentionMin: 180, sampleSec: 5, now });
  const errors = new ErrorTracker({ events, bufferSize: 100, logAppend: false, logger: silent, now });
  const state = new MonitorState({ events, metrics, errors, now });
  const adapter = new FakeAdapter();
  // Seed the snapshot with a known process so instance counts resolve, and make
  // the adapter's list() return the same so a connect() does not wipe it.
  state.applyPm2List([proc({ name: 'api', instances })]);
  // A cluster app shows up as N separate records sharing the name; aggregateList
  // folds them into one snapshot whose `instances` is the record count.
  adapter.listResult = Array.from({ length: instances }, (_unused, i) => ({
    name: 'api',
    pm_id: i,
    pid: 1 + i,
    monit: { cpu: 1, memory: 1 },
    pm2_env: {
      status: 'online',
      instances,
      exec_mode: instances > 1 ? 'cluster_mode' : 'fork_mode',
    },
  }));

  const captured: TrackedError[] = [];
  events.on('error:captured', (e) => captured.push(e));
  const transitions: Array<{ to: string }> = [];
  events.on('process:transition', (e) => transitions.push({ to: e.to }));

  const client = new Pm2Client({
    adapter,
    state,
    events,
    logger: silent,
    sampleSec: 5,
    graceMs: 10_000,
    now,
    // No-op timers so the loop/janitor never fire during unit tests.
    setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
    clearTimer: () => {},
  });

  return { events, state, errors, adapter, client, captured, transitions, now };
}

/** Flush pending microtasks (fake adapter resolves via queueMicrotask). */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Starts the client and waits until it is connected with the bus attached. */
async function connect(client: Pm2Client): Promise<void> {
  client.start();
  // connect -> refreshAndApply (list) -> attachBus (launchBus) resolve via
  // queueMicrotask; a few flushes settle the whole chain.
  await flush();
  await flush();
  await flush();
}

// --- token model tests ---

test('restart exit->online is suppressed and restart is tagged intentional:true', async () => {
  const nowRef = { t: 1000 };
  const { client, adapter, captured, transitions } = makeHarness(nowRef);
  await connect(client);

  await client.control('restart', 'api');

  // An operator restart surfaces as a single `restart` lifecycle event; its
  // exit half consumes the pushed restart token, which tags it intentional.
  adapter.bus.emit('process:event', { event: 'restart', process: { name: 'api', pm_id: 0 } });

  // No crash captured for the suppressed exit half.
  const crashes = captured.filter((c) => c.level === 'crash');
  assert.equal(crashes.length, 0);
  // The restart error is tagged intentional:true.
  const restarts = captured.filter((c) => c.level === 'restart');
  assert.equal(restarts.length, 1);
  assert.equal(restarts[0].intentional, true);
  void transitions;
});

test('unexpected exit with no token captures a crash', async () => {
  const nowRef = { t: 1000 };
  const { client, adapter, captured } = makeHarness(nowRef);
  await connect(client);
  // No control call => no token.
  adapter.bus.emit('process:event', { event: 'exit', process: { name: 'api', pm_id: 0 } });
  const crashes = captured.filter((c) => c.level === 'crash');
  assert.equal(crashes.length, 1);
  assert.equal(crashes[0].processName, 'api');
});

test('one token per instance is consumed (cluster stop)', async () => {
  const nowRef = { t: 1000 };
  const { client, adapter, captured } = makeHarness(nowRef, 3);
  await connect(client);

  await client.control('stop', 'api');

  // Three stop packets, one per instance; each consumes one token.
  adapter.bus.emit('process:event', { event: 'exit', process: { name: 'api', pm_id: 0 } });
  adapter.bus.emit('process:event', { event: 'exit', process: { name: 'api', pm_id: 1 } });
  adapter.bus.emit('process:event', { event: 'exit', process: { name: 'api', pm_id: 2 } });
  // All three suppressed -> no crash.
  assert.equal(captured.filter((c) => c.level === 'crash').length, 0);

  // A fourth exit has no token left -> crash.
  adapter.bus.emit('process:event', { event: 'exit', process: { name: 'api', pm_id: 0 } });
  assert.equal(captured.filter((c) => c.level === 'crash').length, 1);
});

test('tokens are FIFO: restart token precedes a later stop token', async () => {
  const nowRef = { t: 1000 };
  const { client, adapter, captured } = makeHarness(nowRef);
  await connect(client);

  await client.control('restart', 'api'); // pushes 1 restart token
  await client.control('stop', 'api'); // pushes 1 stop token

  // First exit consumes the restart token (FIFO).
  adapter.bus.emit('process:event', { event: 'restart', process: { name: 'api', pm_id: 0 } });
  const restarts = captured.filter((c) => c.level === 'restart');
  assert.equal(restarts.length, 1);
  assert.equal(restarts[0].intentional, true);

  // Second exit consumes the stop token -> suppressed, no crash.
  adapter.bus.emit('process:event', { event: 'exit', process: { name: 'api', pm_id: 0 } });
  assert.equal(captured.filter((c) => c.level === 'crash').length, 0);
});

test('expired token is not consumed; the event is unexpected', async () => {
  const nowRef = { t: 1000 };
  const { client, adapter, captured } = makeHarness(nowRef);
  await connect(client);

  await client.control('stop', 'api'); // token expiresAt = 1000 + 10000

  // Advance past the grace window.
  nowRef.t = 1000 + 10_001;
  adapter.bus.emit('process:event', { event: 'exit', process: { name: 'api', pm_id: 0 } });

  // Token expired -> crash captured.
  assert.equal(captured.filter((c) => c.level === 'crash').length, 1);
});

test('restart with no token is a crash-loop restart tagged intentional:false', async () => {
  const nowRef = { t: 1000 };
  const { client, adapter, captured } = makeHarness(nowRef);
  await connect(client);
  // No control call -> no token.
  adapter.bus.emit('process:event', { event: 'restart', process: { name: 'api', pm_id: 0 } });
  const restarts = captured.filter((c) => c.level === 'restart');
  assert.equal(restarts.length, 1);
  assert.equal(restarts[0].intentional, false);
});

test('restart overlimit drives errored at level crash and does NOT increment the restart counter', async () => {
  const nowRef = { t: 1000 };
  const { client, adapter, captured, errors, transitions } = makeHarness(nowRef);
  // Give the restart ring a window to sum over.
  errors.setMaxWindow(600);
  await connect(client);

  adapter.bus.emit('process:event', { event: 'restart overlimit', process: { name: 'api', pm_id: 0 } });

  // One crash captured, transition to errored.
  const crashes = captured.filter((c) => c.level === 'crash');
  assert.equal(crashes.length, 1);
  assert.ok(transitions.some((t) => t.to === 'errored'));
  // No restart-level error, and the restart-window counter stays 0 (MEDIUM-3).
  assert.equal(captured.filter((c) => c.level === 'restart').length, 0);
  assert.equal(errors.restartsInWindow('api', 600), 0);
});

test('a crash-loop restart (intentional:false) DOES increment the restart counter', async () => {
  const nowRef = { t: 1000 };
  const { client, adapter, errors } = makeHarness(nowRef);
  errors.setMaxWindow(600);
  await connect(client);
  adapter.bus.emit('process:event', { event: 'restart', process: { name: 'api', pm_id: 0 } });
  assert.equal(errors.restartsInWindow('api', 600), 1);
});

// --- control short-circuit + translation ---

test('control short-circuits to PM2_UNAVAILABLE when disconnected and never throws', async () => {
  const nowRef = { t: 1000 };
  const { client } = makeHarness(nowRef);
  const result = await client.control('restart', 'api');
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'PM2_UNAVAILABLE');
  assert.equal(client.isConnected(), false);
});

test('start/connect flips connected and applies the initial list', async () => {
  const nowRef = { t: 1000 };
  const { client, adapter, state } = makeHarness(nowRef);
  adapter.listResult = [
    {
      name: 'svc',
      pm_id: 0,
      pid: 10,
      monit: { cpu: 1, memory: 2 },
      pm2_env: { status: 'online', instances: 1, exec_mode: 'fork_mode' },
    },
  ];
  client.start();
  await flush();
  await flush();
  assert.equal(client.isConnected(), true);
  assert.ok(state.getProcess('svc'));
  await client.stop();
  assert.equal(client.isConnected(), false);
  assert.ok(adapter.disconnectCalls >= 1);
});

test('log:out emits info log lines (not errors); log:err feeds the error tracker', async () => {
  const nowRef = { t: 1000 };
  const { client, adapter, events, captured } = makeHarness(nowRef);
  await connect(client);
  const logs: Array<{ level: string; line: string }> = [];
  events.on('log:line', (e) => logs.push({ level: e.level, line: e.line }));

  adapter.bus.emit('log:out', { process: { name: 'api', pm_id: 0 }, data: 'hello\nworld\n' });
  adapter.bus.emit('log:err', { process: { name: 'api', pm_id: 0 }, data: 'boom' });

  assert.deepEqual(
    logs.filter((l) => l.level === 'info').map((l) => l.line),
    ['hello', 'world'],
  );
  assert.equal(logs.filter((l) => l.level === 'error').length, 1);
  // The err line also feeds the tracker at level error.
  assert.equal(captured.filter((c) => c.level === 'error').length, 1);
});

test('process:exception captures a crash with normalized message', async () => {
  const nowRef = { t: 1000 };
  const { client, adapter, captured } = makeHarness(nowRef);
  await connect(client);
  adapter.bus.emit('process:exception', {
    process: { name: 'api', pm_id: 0 },
    data: { message: 'kaboom', stack: 'Error: kaboom\n at a (/x.js:1:1)' },
  });
  const crashes = captured.filter((c) => c.level === 'crash');
  assert.equal(crashes.length, 1);
  assert.equal(crashes[0].message, 'kaboom');
});

test('nested (data) bus layout is translated the same as the flat layout', async () => {
  const nowRef = { t: 1000 };
  const { client, adapter, captured } = makeHarness(nowRef);
  await connect(client);
  adapter.bus.emit('process:event', { data: { event: 'exit', process: { name: 'api', pm_id: 0 } } });
  assert.equal(captured.filter((c) => c.level === 'crash').length, 1);
});

test('malformed bus packet is skipped without emitting events', async () => {
  const nowRef = { t: 1000 };
  const { client, adapter, captured } = makeHarness(nowRef);
  await connect(client);
  adapter.bus.emit('process:event', { foo: 'bar' });
  assert.equal(captured.length, 0);
});
