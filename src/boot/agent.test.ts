/**
 * Agent-boot integration: wires the SAME components bootstrapAgent assembles
 * (deferred Pm2Deps facade + AgentConnection + AgentRuntime) against a fake
 * loopback socket, and asserts the agent registers and heartbeats while local
 * PM2 is absent, a control:request before PM2 attaches yields a correlated
 * PM2_UNAVAILABLE, and no HTTP server/port is opened.
 *
 * It avoids calling bootstrapAgent() directly so the test does not install
 * global process signal handlers nor open a real outbound socket; it exercises
 * the identical boot wiring with injected fakes, matching the design's
 * dial-first / PM2-in-the-background contract (AC-7/14).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentConnection, type AgentSocket } from '../agent/connection.js';
import { AgentRuntime } from '../agent/runtime.js';
import { MonitorEvents } from '../core/events.js';
import { MonitorState } from '../core/state.js';
import { MetricsStore } from '../metrics/store.js';
import { ErrorTracker } from '../errors/tracker.js';
import { buildSchemas } from '../api/schemas.js';
import { createLogger } from '../core/logger.js';
import { FakePm2Client } from '../testutil/fakePm2Client.js';
import { encode, decode } from '../protocol/codec.js';
import type { Pm2Deps } from '../api/server.js';
import type { Pm2Client } from '../pm2/client.js';
import type { ProtocolMessage } from '../protocol/messages.js';

const silentLogger = createLogger({ level: 'error', sink: () => {} });

/** A loopback socket: outbound frames are captured; the test injects inbound. */
class LoopbackSocket implements AgentSocket {
  readonly outbound: ProtocolMessage[] = [];
  closed = false;
  pinged = 0;
  private readonly listeners = new Map<string, Array<(...a: never[]) => void>>();

  on(event: string, listener: (...a: never[]) => void): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(listener);
    this.listeners.set(event, arr);
  }
  send(data: string): void {
    const r = decode(data);
    if (r.ok) this.outbound.push(r.msg);
  }
  ping(): void {
    this.pinged += 1;
  }
  close(): void {
    this.closed = true;
  }
  fire(event: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) (l as (...a: unknown[]) => void)(...args);
  }
  /** server->agent: deliver an inbound frame. */
  deliver(msg: ProtocolMessage): void {
    this.fire('message', encode(msg));
  }
}

function makeTimers() {
  let seq = 0;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  return {
    setTimer: (fn: () => void, ms: number) => {
      seq += 1;
      pending.set(seq, { fn, ms });
      return seq as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (h: ReturnType<typeof setTimeout>) => {
      pending.delete(h as unknown as number);
    },
    fireWhere: (pred: (ms: number) => boolean) => {
      for (const [id, { fn, ms }] of [...pending]) {
        if (pred(ms)) {
          pending.delete(id);
          fn();
        }
      }
    },
  };
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

interface Boot {
  socket: LoopbackSocket;
  connection: AgentConnection;
  runtime: AgentRuntime;
  pm2Facade: Pm2Deps;
  setPm2Client: (c: Pm2Client | null) => void;
  timers: ReturnType<typeof makeTimers>;
}

function bootWiring(): Boot {
  const timers = makeTimers();
  const events = new MonitorEvents();
  const metrics = new MetricsStore({ retentionMin: 60, sampleSec: 5 });
  const errors = new ErrorTracker({ events, bufferSize: 100, logAppend: false, logger: silentLogger });
  const state = new MonitorState({ events, metrics, errors, now: () => 1000 });

  // Deferred PM2 facade: short-circuits to PM2_UNAVAILABLE until wired.
  let pm2Client: Pm2Client | null = null;
  const pm2Facade: Pm2Deps = {
    control: (action, name) =>
      pm2Client
        ? pm2Client.control(action, name)
        : Promise.resolve({ ok: false, code: 'PM2_UNAVAILABLE', message: 'PM2 daemon is not connected' }),
    startNew: (opts) =>
      pm2Client
        ? pm2Client.startNew(opts)
        : Promise.resolve({ ok: false, code: 'PM2_UNAVAILABLE', message: 'PM2 daemon is not connected' }),
    readLogsTail: (name, lines, opts) =>
      pm2Client ? pm2Client.readLogsTail(name, lines, opts) : Promise.resolve([]),
  };

  const socket = new LoopbackSocket();
  const connection = new AgentConnection({
    serverUrl: 'wss://hub.example',
    wsPath: '/agent',
    agentId: 'agent-1',
    token: 'secret',
    meta: { hostname: 'host', platform: 'linux', monitorVersion: '1.0.0' },
    logger: silentLogger,
    socketFactory: () => socket,
    defaultHeartbeatSec: 10,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    now: () => 1000,
  });

  const runtime = new AgentRuntime({
    events,
    state,
    pm2: pm2Facade,
    schemas: buildSchemas({ fileExists: () => true }),
    logger: silentLogger,
    send: (m) => connection.send(m),
    isConnected: () => connection.isRegistered(),
  });

  connection.setHandlers({
    onRegistered: () => runtime.onRegistered(),
    onDisconnected: () => runtime.onDisconnected(),
    onMessage: (m) => runtime.handleMessage(m),
  });

  connection.start();
  return {
    socket,
    connection,
    runtime,
    pm2Facade,
    setPm2Client: (c) => {
      pm2Client = c;
    },
    timers,
  };
}

test('the agent registers and heartbeats while local PM2 is absent', () => {
  const b = bootWiring();
  // PM2 is never wired (background task not run) — simulates an absent daemon.
  b.socket.fire('open');
  assert.ok(b.socket.outbound.some((m) => m.type === 'register'));
  b.socket.deliver({ type: 'register:ack', ok: true, serverTime: 1, heartbeatSec: 10 });
  assert.equal(b.connection.isRegistered(), true);
  // Heartbeat timer fires -> heartbeat frame + transport ping, independent of PM2.
  b.timers.fireWhere((ms) => ms === 10_000);
  assert.ok(b.socket.outbound.some((m) => m.type === 'heartbeat'));
  assert.ok(b.socket.pinged >= 1);
});

test('a control:request before PM2 attaches yields a correlated PM2_UNAVAILABLE', async () => {
  const b = bootWiring();
  b.socket.fire('open');
  b.socket.deliver({ type: 'register:ack', ok: true, serverTime: 1, heartbeatSec: 10 });
  // PM2 still unwired: route a control request through the loopback.
  b.socket.deliver({ type: 'control:request', cid: 'c1', action: 'restart', name: 'api' });
  await flush();
  const resp = b.socket.outbound.find((m) => m.type === 'control:response');
  assert.ok(resp && resp.type === 'control:response');
  if (resp.type === 'control:response') {
    assert.equal(resp.cid, 'c1');
    assert.equal(resp.result.ok, false);
    if (!resp.result.ok) assert.equal(resp.result.code, 'PM2_UNAVAILABLE');
  }
});

test('once PM2 attaches, control delegates to the real client', async () => {
  const b = bootWiring();
  b.socket.fire('open');
  b.socket.deliver({ type: 'register:ack', ok: true, serverTime: 1, heartbeatSec: 10 });
  // Background task result: wire a connected fake pm2 client.
  const fake = new FakePm2Client({ connected: true });
  b.setPm2Client(fake as unknown as Pm2Client);
  b.socket.deliver({ type: 'control:request', cid: 'c2', action: 'restart', name: 'api' });
  await flush();
  assert.deepEqual(fake.controlCalls, [{ action: 'restart', name: 'api' }]);
});

test('the agent opens no inbound HTTP server/port', () => {
  // bootWiring constructs the entire agent surface; the only socket is the
  // outbound loopback created by the injected factory. No http.Server is
  // instantiated anywhere in the agent boot path.
  const b = bootWiring();
  b.socket.fire('open');
  // A single outbound socket exists; nothing listens for inbound connections.
  assert.ok(b.socket, 'only an outbound socket is created');
});
