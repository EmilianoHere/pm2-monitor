import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentConnection, joinUrl, type AgentSocket } from './connection.js';
import { createLogger } from '../core/logger.js';
import { decode, encode } from '../protocol/codec.js';
import type { ProtocolMessage } from '../protocol/messages.js';

/** A controllable timer harness mirroring the Pm2Client/WsHub test pattern. */
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
    /** fire every currently-armed timer once. */
    fireAll: () => {
      for (const [id, { fn }] of [...pending]) {
        pending.delete(id);
        fn();
      }
    },
    /** fire only timers whose ms matches the predicate. */
    fireWhere: (pred: (ms: number) => boolean) => {
      for (const [id, { fn, ms }] of [...pending]) {
        if (pred(ms)) {
          pending.delete(id);
          fn();
        }
      }
    },
    size: () => pending.size,
    delays: () => [...pending.values()].map((p) => p.ms),
  };
}

/** A fake AgentSocket that records sends and lets the test drive its events. */
class FakeSocket implements AgentSocket {
  readonly sent: string[] = [];
  closed = false;
  pinged = 0;
  private readonly listeners = new Map<string, Array<(...args: never[]) => void>>();

  on(event: string, listener: (...args: never[]) => void): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(listener);
    this.listeners.set(event, arr);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  ping(): void {
    this.pinged += 1;
  }
  close(): void {
    this.closed = true;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) (l as (...a: unknown[]) => void)(...args);
  }
  /** the last decoded outbound frame of a given type, if present. */
  lastSent(): ProtocolMessage | null {
    const raw = this.sent[this.sent.length - 1];
    if (raw === undefined) return null;
    const r = decode(raw);
    return r.ok ? r.msg : null;
  }
}

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

interface Harness {
  conn: AgentConnection;
  sockets: FakeSocket[];
  timers: ReturnType<typeof makeTimers>;
  factoryOpts: Array<{ url: string; rejectUnauthorized: boolean }>;
  records: Array<{ level: string; msg: string }>;
}

function makeHarness(opts: { insecure?: boolean } = {}): Harness {
  const timers = makeTimers();
  const sockets: FakeSocket[] = [];
  const factoryOpts: Array<{ url: string; rejectUnauthorized: boolean }> = [];
  const { logger, records } = recordingLogger();
  const conn = new AgentConnection({
    serverUrl: 'wss://hub.example',
    wsPath: '/agent',
    agentId: 'agent-1',
    token: 'secret',
    meta: { hostname: 'host', platform: 'linux', monitorVersion: '1.0.0' },
    logger,
    ...(opts.insecure !== undefined ? { insecure: opts.insecure } : {}),
    socketFactory: (o) => {
      factoryOpts.push(o);
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    defaultHeartbeatSec: 10,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    now: () => 1000,
  });
  return { conn, sockets, timers, factoryOpts, records };
}

function ackFrame(heartbeatSec = 10): string {
  return encode({ type: 'register:ack', ok: true, serverTime: 1, heartbeatSec });
}

test('register is sent on socket open', () => {
  const h = makeHarness();
  h.conn.start();
  const s = h.sockets[0];
  s.emit('open');
  const frame = s.lastSent();
  assert.ok(frame && frame.type === 'register');
  if (frame.type === 'register') {
    assert.equal(frame.agentId, 'agent-1');
    assert.equal(frame.token, 'secret');
  }
});

test('does not crash when the server is unreachable and keeps retrying', () => {
  const h = makeHarness();
  h.conn.start();
  const first = h.sockets[0];
  // Transport error before any ack -> link dead -> reconnect scheduled.
  first.emit('error', new Error('ECONNREFUSED'));
  assert.equal(first.closed, true);
  assert.equal(h.timers.size(), 1, 'exactly one reconnect timer armed');
  // Fire the reconnect: a brand-new socket is dialed.
  h.timers.fireAll();
  assert.equal(h.sockets.length, 2, 'a second dial attempt happened');
});

test('register:nack holds at the 30s cap rather than hot-looping', () => {
  const h = makeHarness();
  h.conn.start();
  // Drive several nack->reconnect cycles; the backoff attempt counter is never
  // reset (no register:ack), so the delay climbs to and holds at the 30s cap.
  for (let i = 0; i < 12; i += 1) {
    const s = h.sockets[h.sockets.length - 1];
    s.emit('open');
    s.emit('message', encode({ type: 'register:nack', ok: false, code: 'AUTH_FAILED', message: 'no' }));
    assert.equal(h.timers.size(), 1);
    // The latest reconnect delay should never drop back to ~base once climbed.
    h.timers.fireAll();
  }
  // After many un-reset attempts the next reconnect delay sits at the cap band.
  const s = h.sockets[h.sockets.length - 1];
  s.emit('open');
  s.emit('message', encode({ type: 'register:nack', ok: false, code: 'AUTH_FAILED', message: 'no' }));
  const [delay] = h.timers.delays();
  assert.ok(delay >= 24_000, `expected a near-cap delay, got ${delay}`);
  // nack is logged with its code.
  assert.ok(
    h.records.some((r) => r.level === 'warn' && r.msg.includes('registration rejected')),
    'nack code is logged at warn',
  );
});

test('a later-accepted token eventually registers (unbounded retries)', () => {
  const h = makeHarness();
  h.conn.start();
  // First attempt rejected.
  let s = h.sockets[0];
  s.emit('open');
  s.emit('message', encode({ type: 'register:nack', ok: false, code: 'AUTH_FAILED', message: 'no' }));
  h.timers.fireAll(); // reconnect dial
  // Operator added the token server-side; the next attempt is accepted.
  s = h.sockets[h.sockets.length - 1];
  s.emit('open');
  s.emit('message', ackFrame());
  assert.equal(h.conn.isRegistered(), true);
});

test('register:ack resets the backoff so a later drop reconnects quickly', () => {
  const h = makeHarness();
  h.conn.start();
  const s = h.sockets[0];
  s.emit('open');
  s.emit('message', ackFrame());
  assert.equal(h.conn.isRegistered(), true);
  // A subsequent transport close schedules a reconnect at the base band.
  s.emit('close');
  const [delay] = h.timers.delays();
  assert.ok(delay <= 1_200, `expected a reset base-band delay, got ${delay}`);
});

test('insecure toggle passes rejectUnauthorized:false and logs the warning', () => {
  const h = makeHarness({ insecure: true });
  h.conn.start();
  assert.equal(h.factoryOpts[0].rejectUnauthorized, false);
  assert.ok(
    h.records.some((r) => r.level === 'warn' && r.msg.includes('INSECURE')),
    'insecure warning logged',
  );
});

test('secure (default) passes rejectUnauthorized:true', () => {
  const h = makeHarness();
  h.conn.start();
  assert.equal(h.factoryOpts[0].rejectUnauthorized, true);
});

test('onLinkDead is idempotent: a second trigger is a no-op', () => {
  const h = makeHarness();
  h.conn.start();
  const s = h.sockets[0];
  s.emit('open');
  // Two near-simultaneous teardown triggers (error then close).
  s.emit('error', new Error('boom'));
  s.emit('close');
  assert.equal(h.timers.size(), 1, 'exactly one reconnect scheduled despite two triggers');
});

test('a dead link (no heartbeat:ack / pong) tears down after 2x heartbeat', () => {
  const h = makeHarness();
  h.conn.start();
  const s = h.sockets[0];
  s.emit('open');
  s.emit('message', ackFrame(10));
  // Fire the heartbeat tick (10s): sends heartbeat + ping, re-arms.
  h.timers.fireWhere((ms) => ms === 10_000);
  assert.ok(s.pinged >= 1, 'a transport ping was sent');
  assert.ok(s.lastSent()?.type === 'heartbeat');
  // Fire the dead-link check (20s) with no liveness observed -> link dead.
  h.timers.fireWhere((ms) => ms === 20_000);
  assert.equal(s.closed, true, 'socket closed on dead link');
});

test('joinUrl avoids a doubled slash', () => {
  assert.equal(joinUrl('wss://h/', '/agent'), 'wss://h/agent');
  assert.equal(joinUrl('wss://h', 'agent'), 'wss://h/agent');
});
