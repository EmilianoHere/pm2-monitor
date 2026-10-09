import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { WsHub, type FleetLogRelay, type RelayLogClient } from './hub.js';
import { MonitorEvents } from '../core/events.js';
import { createLogger } from '../core/logger.js';
import type { MonitorSnapshot } from '../core/types.js';
import type { AuthConfig } from '../api/auth.js';

const API_KEY = 'ws-key';
const SILENT = createLogger({ level: 'error', sink: () => {} });

function snapshot(): MonitorSnapshot {
  return { processes: [], pm2Connected: true, maintenance: false, generatedAt: 0 };
}

interface Harness {
  events: MonitorEvents;
  hub: WsHub;
  url: string;
  close: () => Promise<void>;
}

async function boot(
  auth: AuthConfig = { mode: 'apikey', apiKey: API_KEY },
  relay?: FleetLogRelay,
): Promise<Harness> {
  const server: Server = createServer();
  const events = new MonitorEvents();
  const hub = new WsHub({ server, events, auth, logger: SILENT, snapshot, ...(relay ? { relay } : {}) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    events,
    hub,
    url: `ws://127.0.0.1:${port}/ws`,
    close: () =>
      new Promise<void>((resolve) => {
        hub.close();
        server.close(() => resolve());
      }),
  };
}

/**
 * Buffers every message a socket receives from the moment of attachment so a
 * `hello` frame sent immediately on connect is never missed by a later reader.
 */
class MessageQueue {
  private readonly buffered: Record<string, unknown>[] = [];
  private waiter: ((m: Record<string, unknown>) => void) | null = null;

  constructor(ws: WebSocket) {
    ws.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w(msg);
      } else {
        this.buffered.push(msg);
      }
    });
  }

  next(): Promise<Record<string, unknown>> {
    const queued = this.buffered.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
}

// --- upgrade auth ---

test('authenticated upgrade (apikey subprotocol) connects and gets hello', async () => {
  const h = await boot();
  try {
    const ws = new WebSocket(h.url, [`apikey.${API_KEY}`]);
    const q = new MessageQueue(ws);
    await once(ws, 'open');
    const hello = await q.next();
    assert.equal(hello.type, 'hello');
    assert.ok(hello.snapshot);
    ws.close();
    await once(ws, 'close');
  } finally {
    await h.close();
  }
});

test('wrong-length credential is rejected with 401 and does not crash the process', async () => {
  const h = await boot();
  try {
    const ws = new WebSocket(h.url, ['apikey.definitely-the-wrong-key-and-length']);
    // ws emits 'unexpected-response' (not 'error') when the server rejects the
    // upgrade with a raw HTTP 401 before the handshake completes.
    const status = await new Promise<number>((resolve, reject) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', reject);
      ws.on('open', () => reject(new Error('unexpected open on bad credential')));
    });
    assert.equal(status, 401);
    // Process still alive: a fresh authed connection succeeds.
    const good = new WebSocket(h.url, [`apikey.${API_KEY}`]);
    await once(good, 'open');
    good.close();
    await once(good, 'close');
  } finally {
    await h.close();
  }
});

test('?token= fallback authenticates non-browser clients', async () => {
  const h = await boot();
  try {
    const ws = new WebSocket(`${h.url}?token=${API_KEY}`);
    const q = new MessageQueue(ws);
    await once(ws, 'open');
    const hello = await q.next();
    assert.equal(hello.type, 'hello');
    ws.close();
    await once(ws, 'close');
  } finally {
    await h.close();
  }
});

// --- subscription filtering ---

test('state broadcast only reaches clients subscribed to the state channel', async () => {
  const h = await boot();
  try {
    const ws = new WebSocket(h.url, [`apikey.${API_KEY}`]);
    const q = new MessageQueue(ws);
    await once(ws, 'open');
    await q.next(); // hello
    ws.send(JSON.stringify({ type: 'subscribe', channels: ['state'] }));
    // give the server a tick to register the subscription
    await new Promise((r) => setTimeout(r, 20));

    const received = q.next();
    h.events.emit('state:update', snapshot());
    const msg = await received;
    assert.equal(msg.type, 'state');
    ws.close();
    await once(ws, 'close');
  } finally {
    await h.close();
  }
});

test('log fan-out only reaches subscribers of that process+stream', async () => {
  const h = await boot();
  try {
    const ws = new WebSocket(h.url, [`apikey.${API_KEY}`]);
    const q = new MessageQueue(ws);
    await once(ws, 'open');
    await q.next(); // hello
    ws.send(JSON.stringify({ type: 'log:subscribe', process: 'api', streams: ['err'] }));
    await new Promise((r) => setTimeout(r, 20));

    // A line for a non-subscribed process must NOT arrive; the 'api/err' one must.
    const received = q.next();
    h.events.emit('log:line', { process: 'other', stream: 'err', level: 'error', line: 'nope', ts: 1 });
    h.events.emit('log:line', { process: 'api', stream: 'err', level: 'error', line: 'boom', ts: 2 });
    const msg = await received;
    assert.equal(msg.type, 'log');
    assert.equal(msg.process, 'api');
    assert.equal(msg.line, 'boom');
    ws.close();
    await once(ws, 'close');
  } finally {
    await h.close();
  }
});

// --- agent-scoped log relay (server mode) ---

/** A spying fake relay recording every subscribe/unsubscribe call. */
class SpyRelay implements FleetLogRelay {
  readonly subs: Array<{ agentId: string; process: string; streams: Array<'out' | 'err'> }> = [];
  readonly unsubs: Array<{ agentId: string; process: string }> = [];
  private lastClient: RelayLogClient | null = null;

  subscribeLogs(agentId: string, process: string, streams: Array<'out' | 'err'>, client: RelayLogClient): boolean {
    this.subs.push({ agentId, process, streams });
    this.lastClient = client;
    return true;
  }
  unsubscribeLogs(agentId: string, process: string): void {
    this.unsubs.push({ agentId, process });
  }
  pushLine(line: { agentId: string; process: string; stream: 'out' | 'err'; level: 'info' | 'error'; line: string; ts: number }): void {
    this.lastClient?.deliver(line);
  }
}

test('a valid agentId log:subscribe reaches the relay and relayed lines arrive as log frames', async () => {
  const relay = new SpyRelay();
  const h = await boot({ mode: 'apikey', apiKey: API_KEY }, relay);
  try {
    const ws = new WebSocket(h.url, [`apikey.${API_KEY}`]);
    const q = new MessageQueue(ws);
    await once(ws, 'open');
    await q.next(); // hello
    ws.send(JSON.stringify({ type: 'log:subscribe', agentId: 'web-01', process: 'api', streams: ['err'] }));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(relay.subs.length, 1, 'relay received the subscribe');
    assert.deepEqual(relay.subs[0], { agentId: 'web-01', process: 'api', streams: ['err'] });

    const received = q.next();
    relay.pushLine({ agentId: 'web-01', process: 'api', stream: 'err', level: 'error', line: 'boom', ts: 7 });
    const msg = await received;
    assert.equal(msg.type, 'log');
    assert.equal(msg.agentId, 'web-01');
    assert.equal(msg.process, 'api');
    assert.equal(msg.line, 'boom');
    ws.close();
    await once(ws, 'close');
  } finally {
    await h.close();
  }
});

test('a malformed agentId returns BAD_MESSAGE and never touches the relay', async () => {
  const relay = new SpyRelay();
  const h = await boot({ mode: 'apikey', apiKey: API_KEY }, relay);
  try {
    for (const badId of ['bad id!', 'a/b', '__proto__' + '/'.repeat(0) + '!', 42]) {
      const ws = new WebSocket(h.url, [`apikey.${API_KEY}`]);
      const q = new MessageQueue(ws);
      await once(ws, 'open');
      await q.next(); // hello
      const bad = q.next();
      ws.send(JSON.stringify({ type: 'log:subscribe', agentId: badId, process: 'api' }));
      const msg = await bad;
      assert.equal(msg.type, 'error');
      assert.equal(msg.code, 'BAD_MESSAGE');
      ws.close();
      await once(ws, 'close');
    }
    assert.equal(relay.subs.length, 0, 'the relay recorded zero calls for malformed ids');
  } finally {
    await h.close();
  }
});

test('a / in agentId is rejected (not treated as a composite) with BAD_MESSAGE', async () => {
  const relay = new SpyRelay();
  const h = await boot({ mode: 'apikey', apiKey: API_KEY }, relay);
  try {
    const ws = new WebSocket(h.url, [`apikey.${API_KEY}`]);
    const q = new MessageQueue(ws);
    await once(ws, 'open');
    await q.next();
    const bad = q.next();
    ws.send(JSON.stringify({ type: 'log:subscribe', agentId: 'web/01', process: 'api' }));
    const msg = await bad;
    assert.equal(msg.code, 'BAD_MESSAGE');
    assert.equal(relay.subs.length, 0);
    ws.close();
    await once(ws, 'close');
  } finally {
    await h.close();
  }
});

test('no agentId takes the local fan-out path unchanged (relay untouched)', async () => {
  const relay = new SpyRelay();
  const h = await boot({ mode: 'apikey', apiKey: API_KEY }, relay);
  try {
    const ws = new WebSocket(h.url, [`apikey.${API_KEY}`]);
    const q = new MessageQueue(ws);
    await once(ws, 'open');
    await q.next(); // hello
    ws.send(JSON.stringify({ type: 'log:subscribe', process: 'api', streams: ['err'] }));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(relay.subs.length, 0, 'no-agentId subscribe never reaches the relay');

    const received = q.next();
    h.events.emit('log:line', { process: 'api', stream: 'err', level: 'error', line: 'local', ts: 1 });
    const msg = await received;
    assert.equal(msg.type, 'log');
    assert.equal(msg.line, 'local');
    ws.close();
    await once(ws, 'close');
  } finally {
    await h.close();
  }
});

test('ping gets a pong; a malformed frame gets BAD_MESSAGE', async () => {
  const h = await boot();
  try {
    const ws = new WebSocket(h.url, [`apikey.${API_KEY}`]);
    const q = new MessageQueue(ws);
    await once(ws, 'open');
    await q.next(); // hello

    const pong = q.next();
    ws.send(JSON.stringify({ type: 'ping' }));
    assert.equal((await pong).type, 'pong');

    const bad = q.next();
    ws.send('{ not json');
    const badMsg = await bad;
    assert.equal(badMsg.type, 'error');
    assert.equal(badMsg.code, 'BAD_MESSAGE');
    ws.close();
    await once(ws, 'close');
  } finally {
    await h.close();
  }
});
