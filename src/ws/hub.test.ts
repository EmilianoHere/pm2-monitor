import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { WsHub } from './hub.js';
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

async function boot(auth: AuthConfig = { mode: 'apikey', apiKey: API_KEY }): Promise<Harness> {
  const server: Server = createServer();
  const events = new MonitorEvents();
  const hub = new WsHub({ server, events, auth, logger: SILENT, snapshot });
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
