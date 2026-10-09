/**
 * AgentConnection: the agent's outbound-only WebSocket client. It dials the
 * server (SERVER_URL + AGENT_WS_PATH), sends `register` on open, and keeps the
 * link alive with an app-level heartbeat plus a transport ping/pong backstop.
 *
 * Reconnect reuses the shared {@link backoffDelay} (base 1s, cap 30s, +/-20%
 * jitter) from `src/core/backoff.ts`. Retries are UNBOUNDED and the agent NEVER
 * crashes when the server is unreachable (NFR-2): a later-accepted token (added
 * to the server after the fact) is picked up on the next capped retry.
 *
 * The backoff attempt counter resets ONLY on a successful `register:ack` — not
 * on raw socket `open`. This is the one place the agent's reset point
 * deliberately differs from Pm2Client: a wrong token opens the socket, gets
 * `register:nack AUTH_FAILED`, closes, and reconnects at the NEXT backoff step,
 * so it climbs to and holds at the 30s cap instead of hot-looping (~1s).
 *
 * Every teardown path (register:nack, handshake-timeout/transport close, and
 * the heartbeat/pong dead-link) funnels through a single idempotent
 * `onLinkDead()` guarded by `alreadyDead`, so a double trigger closes the socket
 * once and schedules exactly one reconnect at the current (un-reset) delay.
 *
 * No inbound port is opened; the only socket is this outbound client (AC-7).
 */

import type { Logger } from '../core/logger.js';
import { backoffDelay } from '../core/backoff.js';
import { decode, encode } from '../protocol/codec.js';
import type { ProtocolMessage } from '../protocol/messages.js';
import { PROTOCOL_VERSION } from '../protocol/version.js';

/** Minimal socket surface the connection drives (a subset of `ws` WebSocket). */
export interface AgentSocket {
  on(event: 'open', listener: () => void): void;
  on(event: 'message', listener: (data: unknown) => void): void;
  on(event: 'close', listener: () => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  on(event: 'pong', listener: () => void): void;
  send(data: string): void;
  ping(): void;
  close(): void;
  terminate?(): void;
}

export interface AgentSocketFactoryOptions {
  url: string;
  rejectUnauthorized: boolean;
}

export type AgentSocketFactory = (opts: AgentSocketFactoryOptions) => AgentSocket;

/** The register meta the agent presents on the handshake. */
export interface AgentRegisterMeta {
  hostname: string;
  platform: string;
  pm2Version?: string;
  monitorVersion: string;
  nameHint?: string;
}

export interface AgentConnectionOptions {
  /** base server URL (ws:// or wss://). */
  serverUrl: string;
  /** path appended to serverUrl (AGENT_WS_PATH, default '/agent'). */
  wsPath: string;
  agentId: string;
  token: string;
  meta: AgentRegisterMeta;
  logger: Logger;
  /** TLS_INSECURE: when true, cert verification is disabled + a warn is logged. */
  insecure?: boolean;
  /** socket factory (injectable; defaults to a `ws` WebSocket). */
  socketFactory: AgentSocketFactory;
  /** fallback heartbeat seconds until the server's register:ack value arrives. */
  defaultHeartbeatSec?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

/** Hooks the runtime wires to react to connection lifecycle + inbound frames. */
export interface AgentConnectionHandlers {
  /** called after register:ack: the agent should send its initial snapshot. */
  onRegistered?: (ack: { serverTime: number; heartbeatSec: number }) => void;
  /** called on every link teardown (before the reconnect is scheduled). */
  onDisconnected?: () => void;
  /** called for every decoded inbound frame (post-handshake dispatch). */
  onMessage?: (msg: ProtocolMessage) => void;
}

const HANDSHAKE_TIMEOUT_MS = 5_000;
const DEFAULT_HEARTBEAT_SEC = 15;

export class AgentConnection {
  private readonly opts: AgentConnectionOptions;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
  private readonly defaultHeartbeatSec: number;

  private handlers: AgentConnectionHandlers = {};
  private socket: AgentSocket | null = null;
  private stopped = false;
  private registered = false;
  private alreadyDead = false;
  private backoffAttempt = 0;
  private heartbeatSec: number;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private deadLinkTimer: ReturnType<typeof setTimeout> | null = null;
  /** set true by a heartbeat:ack or a transport pong within the current window. */
  private livenessSeen = false;

  constructor(opts: AgentConnectionOptions) {
    this.opts = opts;
    this.logger = opts.logger;
    this.now = opts.now ?? (() => Date.now());
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h));
    this.defaultHeartbeatSec = opts.defaultHeartbeatSec ?? DEFAULT_HEARTBEAT_SEC;
    this.heartbeatSec = this.defaultHeartbeatSec;
  }

  setHandlers(handlers: AgentConnectionHandlers): void {
    this.handlers = handlers;
  }

  isRegistered(): boolean {
    return this.registered;
  }

  /** Begins the dial + reconnect loop. Non-blocking; never throws. */
  start(): void {
    this.stopped = false;
    this.dial();
  }

  /** Stops the loop, cancels timers, and closes the socket. */
  stop(): void {
    this.stopped = true;
    this.clearReconnectTimer();
    this.clearHandshakeTimer();
    this.clearLivenessTimers();
    this.registered = false;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        /* best-effort */
      }
    }
  }

  /** Sends a frame if the handshake has completed (dropped otherwise). */
  send(msg: ProtocolMessage): void {
    if (!this.registered || !this.socket) return;
    try {
      this.socket.send(encode(msg));
    } catch (err) {
      this.logger.debug('agent send failed', { err: err instanceof Error ? err.message : String(err) });
    }
  }

  // --- dial ---

  private dial(): void {
    if (this.stopped) return;
    this.registered = false;
    this.alreadyDead = false;
    this.livenessSeen = false;

    const insecure = this.opts.insecure === true;
    if (insecure) {
      this.logger.warn('INSECURE: TLS certificate verification disabled', { serverUrl: this.opts.serverUrl });
    }

    const url = joinUrl(this.opts.serverUrl, this.opts.wsPath);
    let socket: AgentSocket;
    try {
      socket = this.opts.socketFactory({ url, rejectUnauthorized: !insecure });
    } catch (err) {
      // A synchronous construction failure must not crash the agent — treat it
      // as an immediately-dead link and schedule the next retry.
      this.logger.debug('agent socket construction failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.on('open', () => this.onOpen());
    socket.on('message', (data) => this.onRawMessage(data));
    socket.on('close', () => this.onLinkDead('transport close'));
    socket.on('error', (err) => {
      this.logger.debug('agent socket error', { err: err instanceof Error ? err.message : String(err) });
      this.onLinkDead('transport error');
    });
    socket.on('pong', () => {
      this.livenessSeen = true;
    });

    // Hard, non-extendable handshake timeout: register:ack must arrive in 5s.
    this.clearHandshakeTimer();
    this.handshakeTimer = this.setTimer(() => {
      this.handshakeTimer = null;
      if (!this.registered) {
        this.logger.warn('agent handshake timed out', { serverUrl: this.opts.serverUrl });
        this.onLinkDead('handshake timeout');
      }
    }, HANDSHAKE_TIMEOUT_MS);
  }

  private onOpen(): void {
    // NOTE: the backoff counter is intentionally NOT reset here; it resets only
    // on register:ack (see onRegisterAck) to avoid a nack hot-loop.
    const register: ProtocolMessage = {
      type: 'register',
      protocolVersion: PROTOCOL_VERSION,
      agentId: this.opts.agentId,
      token: this.opts.token,
      meta: {
        hostname: this.opts.meta.hostname,
        platform: this.opts.meta.platform,
        ...(this.opts.meta.pm2Version !== undefined ? { pm2Version: this.opts.meta.pm2Version } : {}),
        monitorVersion: this.opts.meta.monitorVersion,
        ...(this.opts.meta.nameHint !== undefined ? { nameHint: this.opts.meta.nameHint } : {}),
      },
    };
    this.rawSend(register);
  }

  private onRawMessage(data: unknown): void {
    const raw = typeof data === 'string' ? data : String(data);
    const result = decode(raw);
    if (!result.ok) {
      this.logger.debug('agent received bad frame', { message: result.message });
      return;
    }
    const msg = result.msg;
    switch (msg.type) {
      case 'register:ack':
        this.onRegisterAck(msg.serverTime, msg.heartbeatSec);
        return;
      case 'register:nack':
        this.logger.warn('agent registration rejected', { code: msg.code });
        this.onLinkDead(`register:nack ${msg.code}`);
        return;
      case 'heartbeat:ack':
        this.livenessSeen = true;
        return;
      default:
        if (this.registered) this.handlers.onMessage?.(msg);
    }
  }

  private onRegisterAck(serverTime: number, heartbeatSec: number): void {
    this.registered = true;
    this.backoffAttempt = 0; // reset ONLY on successful registration
    this.heartbeatSec = heartbeatSec > 0 ? heartbeatSec : this.defaultHeartbeatSec;
    this.clearHandshakeTimer();
    this.startLiveness();
    this.handlers.onRegistered?.({ serverTime, heartbeatSec: this.heartbeatSec });
  }

  // --- liveness: app-level heartbeat + transport ping/pong backstop ---

  private startLiveness(): void {
    this.clearLivenessTimers();
    this.livenessSeen = false;
    const ms = this.heartbeatSec * 1000;
    const tick = (): void => {
      this.heartbeatTimer = this.setTimer(() => {
        this.heartbeatTimer = null;
        if (this.stopped || !this.registered) return;
        this.rawSend({ type: 'heartbeat', ts: this.now() });
        try {
          this.socket?.ping();
        } catch {
          /* best-effort */
        }
        tick();
      }, ms);
    };
    tick();

    // Dead-link check at 2x the heartbeat window: if neither a heartbeat:ack nor
    // a transport pong was observed, the link is dead.
    const armDeadCheck = (): void => {
      this.deadLinkTimer = this.setTimer(() => {
        this.deadLinkTimer = null;
        if (this.stopped || !this.registered) return;
        if (!this.livenessSeen) {
          this.onLinkDead('dead link (no heartbeat/pong)');
          return;
        }
        this.livenessSeen = false;
        armDeadCheck();
      }, ms * 2);
    };
    armDeadCheck();
  }

  private clearLivenessTimers(): void {
    if (this.heartbeatTimer) {
      this.clearTimer(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.deadLinkTimer) {
      this.clearTimer(this.deadLinkTimer);
      this.deadLinkTimer = null;
    }
  }

  // --- teardown (single idempotent path) ---

  private onLinkDead(reason: string): void {
    if (this.alreadyDead) return;
    this.alreadyDead = true;
    this.registered = false;
    this.clearHandshakeTimer();
    this.clearLivenessTimers();
    this.logger.debug('agent link down', { reason });

    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        /* best-effort */
      }
    }
    this.handlers.onDisconnected?.();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.clearReconnectTimer();
    const delay = backoffDelay(this.backoffAttempt);
    this.backoffAttempt += 1;
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      this.dial();
    }, delay);
  }

  // --- helpers ---

  /** Sends a frame on the raw socket regardless of registration (handshake). */
  private rawSend(msg: ProtocolMessage): void {
    if (!this.socket) return;
    try {
      this.socket.send(encode(msg));
    } catch (err) {
      this.logger.debug('agent raw send failed', { err: err instanceof Error ? err.message : String(err) });
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      this.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer) {
      this.clearTimer(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }
}

/** Joins a base URL and a path, avoiding a doubled slash. */
export function joinUrl(base: string, wsPath: string): string {
  const trimmed = base.replace(/\/+$/, '');
  const suffix = wsPath.startsWith('/') ? wsPath : `/${wsPath}`;
  return `${trimmed}${suffix}`;
}
