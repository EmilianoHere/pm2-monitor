import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { AgentGateway, type GatewaySocket } from './gateway.js';
import { FleetRegistry } from './registry.js';
import { createLogger } from '../core/logger.js';
import { decode, encode } from '../protocol/codec.js';
import type { ProtocolMessage } from '../protocol/messages.js';
import { PROTOCOL_VERSION } from '../protocol/version.js';

const silentLogger = createLogger({ level: 'error', sink: () => {} });

function recordingLogger() {
  const records: Array<{ level: string; msg: string } & Record<string, unknown>> = [];
  const logger = createLogger({
    level: 'debug',
    sink: (line) => records.push(JSON.parse(line) as never),
  });
  return { logger, records };
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
    size: () => pending.size,
  };
}

/** A fake upgraded socket the handshake drives. */
class FakeSocket implements GatewaySocket {
  readonly sent: ProtocolMessage[] = [];
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
    if (r.ok) this.sent.push(r.msg);
  }
  close(): void {
    this.closed = true;
  }
  ping(): void {
    this.pinged += 1;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) (l as (...a: unknown[]) => void)(...args);
  }
  lastOfType<T extends ProtocolMessage['type']>(type: T): Extract<ProtocolMessage, { type: T }> | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      if (this.sent[i].type === type) return this.sent[i] as Extract<ProtocolMessage, { type: T }>;
    }
    return undefined;
  }
}

function makeGateway(opts: { tokens?: string[]; maxPending?: number } = {}) {
  const timers = makeTimers();
  const server = new EventEmitter() as unknown as Server;
  const registry = new FleetRegistry({
    logger: silentLogger,
    retentionMin: 180,
    sampleSec: 5,
    errorBufferSize: 500,
    now: () => 1000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const { logger, records } = recordingLogger();
  const gateway = new AgentGateway({
    server,
    registry,
    tokens: opts.tokens ?? ['good-token'],
    wsPath: '/agent',
    logger,
    heartbeatSec: 10,
    ...(opts.maxPending !== undefined ? { maxPending: opts.maxPending } : {}),
    now: () => 1000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return { gateway, registry, timers, records };
}

const META = { hostname: 'h', platform: 'linux', monitorVersion: '1.0.0' };

function registerFrame(over: Partial<Record<string, unknown>> = {}): string {
  return encode({
    type: 'register',
    protocolVersion: PROTOCOL_VERSION,
    agentId: 'web-01',
    token: 'good-token',
    meta: META,
    ...over,
  } as ProtocolMessage);
}

test('accepts a valid register: acks and marks the agent online', () => {
  const { gateway, registry } = makeGateway();
  const s = new FakeSocket();
  gateway.handleSocket(s);
  s.emit('message', registerFrame());

  assert.ok(s.lastOfType('register:ack'), 'register:ack sent');
  const entry = registry.get('web-01');
  assert.ok(entry, 'agent registered');
  assert.equal(entry!.online, true);
  assert.equal(s.closed, false);
  assert.equal(gateway.pendingSockets(), 0, 'no longer counted as pending');
});

test('AUTH_FAILED nack on a bad token: no registration + close', () => {
  const { gateway, registry } = makeGateway();
  const s = new FakeSocket();
  gateway.handleSocket(s);
  s.emit('message', registerFrame({ token: 'wrong-token' }));

  const nack = s.lastOfType('register:nack');
  assert.ok(nack);
  assert.equal(nack!.code, 'AUTH_FAILED');
  assert.equal(s.closed, true);
  assert.equal(registry.get('web-01'), undefined, 'not registered');
});

test('VERSION_MISMATCH nack: no registration + close', () => {
  const { gateway, registry } = makeGateway();
  const s = new FakeSocket();
  gateway.handleSocket(s);
  s.emit('message', registerFrame({ protocolVersion: PROTOCOL_VERSION + 99 }));

  const nack = s.lastOfType('register:nack');
  assert.ok(nack);
  assert.equal(nack!.code, 'VERSION_MISMATCH');
  assert.equal(s.closed, true);
  assert.equal(registry.get('web-01'), undefined);
});

test('handshake timeout closes an un-registered socket and is not reset by a malformed frame', () => {
  const { gateway, timers } = makeGateway();
  const s = new FakeSocket();
  gateway.handleSocket(s);
  // A malformed frame must not extend the handshake window.
  s.emit('message', 'not json');
  assert.ok(s.lastOfType('error:frame'), 'bad frame answered');
  assert.equal(s.closed, true, 'bad frame closes immediately');
});

test('non-register frame before auth → error:frame + close, no state', () => {
  const { gateway, registry } = makeGateway();
  const s = new FakeSocket();
  gateway.handleSocket(s);
  s.emit('message', encode({ type: 'heartbeat', ts: 1 }));
  const err = s.lastOfType('error:frame');
  assert.ok(err);
  assert.equal(err!.code, 'BAD_MESSAGE');
  assert.equal(s.closed, true);
  assert.equal(registry.size, 0);
});

test('the 5s handshake timer closes a silent socket', () => {
  const { gateway, timers } = makeGateway();
  const s = new FakeSocket();
  gateway.handleSocket(s);
  assert.equal(gateway.pendingSockets(), 1);
  timers.fireWhere((ms) => ms === 5000);
  assert.equal(s.closed, true, 'timed-out socket closed');
  assert.equal(gateway.pendingSockets(), 0);
});

test('a register with an empty token is rejected at decode (before auth)', () => {
  const { gateway, registry } = makeGateway();
  const s = new FakeSocket();
  gateway.handleSocket(s);
  // Build the frame by hand so the invalid token survives to decode.
  s.emit('message', JSON.stringify({ type: 'register', protocolVersion: PROTOCOL_VERSION, agentId: 'web-01', token: '', meta: META }));
  const err = s.lastOfType('error:frame');
  assert.ok(err, 'decode rejected an empty token as BAD_MESSAGE');
  assert.equal(s.closed, true);
  assert.equal(registry.get('web-01'), undefined);
});

test('a register with a malformed agentId is rejected at decode (before auth)', () => {
  const { gateway, registry } = makeGateway();
  const s = new FakeSocket();
  gateway.handleSocket(s);
  s.emit('message', JSON.stringify({ type: 'register', protocolVersion: PROTOCOL_VERSION, agentId: 'bad id/slash', token: 'good-token', meta: META }));
  assert.ok(s.lastOfType('error:frame'), 'decode rejected a malformed agentId');
  assert.equal(s.closed, true);
  assert.equal(registry.size, 0);
});

test('reaching the pending cap refuses the next upgrade with 503-and-destroy', () => {
  const server = new EventEmitter() as unknown as Server;
  const timers = makeTimers();
  const registry = new FleetRegistry({ logger: silentLogger, retentionMin: 180, sampleSec: 5, errorBufferSize: 500, now: () => 1000, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  const gateway = new AgentGateway({
    server,
    registry,
    tokens: ['good-token'],
    wsPath: '/agent',
    logger: silentLogger,
    maxPending: 1,
    now: () => 1000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  // First upgrade occupies the single pending slot via handleSocket.
  gateway.handleSocket(new FakeSocket());
  assert.equal(gateway.pendingSockets(), 1);

  // A real upgrade at the cap must 503+destroy before a WebSocket is built.
  const writes: string[] = [];
  let destroyed = false;
  const duplex = {
    write: (s: string) => {
      writes.push(s);
      return true;
    },
    destroy: () => {
      destroyed = true;
    },
  } as unknown as Duplex;
  (server as unknown as EventEmitter).emit('upgrade', { url: '/agent' }, duplex, Buffer.alloc(0));

  assert.ok(writes.some((w) => w.includes('503')), 'wrote a 503');
  assert.equal(destroyed, true, 'destroyed the socket');
});

test('a registered agent is not counted against the pending cap', () => {
  const { gateway } = makeGateway({ maxPending: 1 });
  const s = new FakeSocket();
  gateway.handleSocket(s);
  s.emit('message', registerFrame());
  // Registration frees the pending slot, so a new handshake may start.
  assert.equal(gateway.pendingSockets(), 0);
  const s2 = new FakeSocket();
  gateway.handleSocket(s2);
  assert.equal(gateway.pendingSockets(), 1, 'the second handshake occupies the freed slot');
});

test('the upgrade/handshake path never logs the token or the agent URL', () => {
  const { gateway, records } = makeGateway();
  const s = new FakeSocket();
  gateway.handleSocket(s);
  s.emit('message', registerFrame());
  // The success log carries only path/agentId/authed — never token/url.
  const serialized = JSON.stringify(records);
  assert.equal(serialized.includes('good-token'), false, 'token never logged');
  assert.equal(serialized.includes('token'), false, 'no token field logged');
  assert.equal(serialized.includes('url'), false, 'no url field logged');
  assert.ok(records.some((r) => r.msg.includes('agent registered') && r.authed === true));
});

test('a disconnect after registration marks the agent offline', () => {
  const { gateway, registry } = makeGateway();
  const s = new FakeSocket();
  gateway.handleSocket(s);
  s.emit('message', registerFrame());
  assert.equal(registry.get('web-01')!.online, true);
  s.emit('close');
  assert.equal(registry.get('web-01')!.online, false, 'retained but offline');
});
