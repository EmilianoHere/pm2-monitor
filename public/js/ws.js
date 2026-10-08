// WebSocket client. Opens new WebSocket(url, ["apikey." + KEY]) where KEY is the
// api key (apikey mode) or the base64 of "user:pass" (basic mode) — the same
// credential the REST client stores. Reconnects with capped backoff + jitter and
// re-sends every active subscription on reconnect. Dispatches server frames
// (hello/state/process:transition/log/alert/pm2/pong) to registered listeners.

import { wsCredential } from './api.js';

const SUBPROTOCOL_PREFIX = 'apikey.';
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;

export class WsClient {
  constructor() {
    this.socket = null;
    this.attempt = 0;
    this.closedByUser = false;
    this.reconnectTimer = null;

    // Subscriptions that must survive a reconnect.
    this.channels = new Set();
    this.logSubs = new Map(); // process -> array of streams

    // type -> Set<handler>
    this.listeners = new Map();
  }

  on(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
    return () => this.listeners.get(type)?.delete(handler);
  }

  emit(type, payload) {
    const set = this.listeners.get(type);
    if (set) for (const fn of set) fn(payload);
  }

  connect() {
    this.closedByUser = false;
    const proto = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    const credential = wsCredential();
    try {
      this.socket = credential
        ? new WebSocket(proto, [SUBPROTOCOL_PREFIX + credential])
        : new WebSocket(proto);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.socket.addEventListener('open', () => {
      this.attempt = 0;
      this.emit('open');
      this.resubscribe();
    });

    this.socket.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg && typeof msg.type === 'string') this.emit(msg.type, msg);
    });

    this.socket.addEventListener('close', () => {
      this.emit('close');
      if (!this.closedByUser) this.scheduleReconnect();
    });

    // 'error' is followed by 'close'; let close drive the reconnect.
    this.socket.addEventListener('error', () => this.emit('socket-error'));
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** this.attempt);
    const jitter = backoff * (0.8 + Math.random() * 0.4);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, jitter);
  }

  resubscribe() {
    if (this.channels.size > 0) {
      this.send({ type: 'subscribe', channels: [...this.channels] });
    }
    for (const [process, streams] of this.logSubs) {
      this.send({ type: 'log:subscribe', process, streams });
    }
  }

  send(obj) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(obj));
    }
  }

  /** Subscribe to top-level channels ('state', 'alerts'); persisted across reconnects. */
  subscribe(channels) {
    for (const c of channels) this.channels.add(c);
    this.send({ type: 'subscribe', channels: [...this.channels] });
  }

  logSubscribe(process, streams = ['out', 'err']) {
    this.logSubs.set(process, streams);
    this.send({ type: 'log:subscribe', process, streams });
  }

  logUnsubscribe(process) {
    this.logSubs.delete(process);
    this.send({ type: 'log:unsubscribe', process });
  }

  ping() {
    this.send({ type: 'ping' });
  }

  close() {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) this.socket.close();
  }
}
