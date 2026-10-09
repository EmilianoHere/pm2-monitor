/**
 * AgentGateway: the inbound agent-facing WebSocket endpoint. It attaches a `ws`
 * WebSocketServer in `noServer` mode to the shared HTTP server and handles ONLY
 * `pathname === AGENT_WS_PATH` (default `/agent`), coexisting with the human
 * WsHub which yields on non-`/ws` paths. The equal-path pathology is rejected
 * at config validation, so the two upgrade handlers never collide.
 *
 * The `/agent` upgrade is accepted unconditionally (no secrets in the URL); the
 * token travels inside the `register` frame. Pre-auth hardening bounds the only
 * pre-auth surface:
 *  - the ONLY frame accepted before auth is `register`; any other frame or a
 *    decode BAD_MESSAGE → `error:frame` + immediate close, no state created;
 *  - a hard, NON-extendable 5s handshake timer closes an un-registered socket
 *    (a malformed frame does not reset it);
 *  - a MAX_PENDING_AGENT_SOCKETS cap (default 50) refuses a new upgrade with
 *    HTTP/1.1 503 + socket.destroy BEFORE a WebSocket is constructed; registered
 *    agents are not counted;
 *  - heartbeat/ping-pong timers start only AFTER register:ack.
 *
 * On `register`: a protocolVersion mismatch → `register:nack VERSION_MISMATCH`
 * (log warn, no registration); an invalid token → `register:nack AUTH_FAILED` +
 * close + no registration; success → register in the FleetRegistry keyed by
 * agentId, `register:ack`, mark online. The upgrade/handshake path NEVER logs
 * the token or the agent URL — only `{ path, agentId, authed }`.
 */

import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import type { Logger } from '../core/logger.js';
import { decode, encode } from '../protocol/codec.js';
import type { ProtocolMessage } from '../protocol/messages.js';
import { PROTOCOL_VERSION } from '../protocol/version.js';
import { validate as validateToken } from './agentAuth.js';
import type { FleetRegistry, AgentWebSocket } from './registry.js';

export const MAX_PENDING_AGENT_SOCKETS = 50;
export const HANDSHAKE_TIMEOUT_MS = 5_000;
export const HEARTBEAT_SEC = 15;

/** The minimal socket surface the handshake drives (a subset of `ws`). */
export interface GatewaySocket extends AgentWebSocket {
  on(event: 'message', listener: (data: unknown) => void): void;
  on(event: 'close', listener: () => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  send(data: string): void;
  close(): void;
  ping?(): void;
}

export interface AgentGatewayOptions {
  server: Server;
  registry: FleetRegistry;
  tokens: string[];
  wsPath: string;
  logger: Logger;
  /** heartbeat seconds advertised in register:ack (default 15). */
  heartbeatSec?: number;
  /** cap on concurrent un-registered sockets (default 50). */
  maxPending?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

/** Per-socket handshake bookkeeping (torn down on register or close). */
interface PendingSocket {
  socket: GatewaySocket;
  handshakeTimer: ReturnType<typeof setTimeout>;
  agentId: string | null;
  settled: boolean;
}

export class AgentGateway {
  private readonly server: Server;
  private readonly registry: FleetRegistry;
  private readonly tokens: string[];
  private readonly wsPath: string;
  private readonly logger: Logger;
  private readonly heartbeatSec: number;
  private readonly maxPending: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;

  private readonly wss: WebSocketServer;
  /** currently un-registered sockets (counts against the cap). */
  private pendingCount = 0;
  /** per-registered-agent liveness timers, keyed by agentId. */
  private readonly heartbeatTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private readonly onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void =>
    this.handleUpgrade(req, socket, head);

  constructor(opts: AgentGatewayOptions) {
    this.server = opts.server;
    this.registry = opts.registry;
    this.tokens = opts.tokens;
    this.wsPath = opts.wsPath;
    this.logger = opts.logger;
    this.heartbeatSec = opts.heartbeatSec ?? HEARTBEAT_SEC;
    this.maxPending = opts.maxPending ?? MAX_PENDING_AGENT_SOCKETS;
    this.now = opts.now ?? (() => Date.now());
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h));

    this.wss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', this.onUpgrade);
  }

  /** Detaches the upgrade handler, clears timers, and closes the server. */
  close(): void {
    this.server.off('upgrade', this.onUpgrade);
    for (const t of this.heartbeatTimers.values()) this.clearTimer(t);
    this.heartbeatTimers.clear();
    this.wss.close();
  }

  // --- upgrade handling ---

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const pathname = (req.url ?? '').split('?')[0];
    if (pathname !== this.wsPath) {
      // Not our endpoint; yield so WsHub (or a future handler) deals with it.
      return;
    }
    // Pre-auth cap: refuse BEFORE constructing a WebSocket.
    if (this.pendingCount >= this.maxPending) {
      this.logger.warn('agent upgrade refused: pending-socket cap reached', { path: this.wsPath });
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.handleSocket(ws as unknown as GatewaySocket);
    });
  }

  /**
   * Drives one freshly-upgraded socket through the bounded handshake. Public so
   * tests can inject a fake socket without a real HTTP upgrade.
   */
  handleSocket(socket: GatewaySocket): void {
    this.pendingCount += 1;
    const pending: PendingSocket = {
      socket,
      agentId: null,
      settled: false,
      handshakeTimer: this.setTimer(() => {
        // Non-extendable 5s timeout: close an un-registered socket.
        if (!pending.settled) {
          this.finishPending(pending);
          this.logger.warn('agent handshake timed out', { path: this.wsPath });
          this.safeClose(socket);
        }
      }, HANDSHAKE_TIMEOUT_MS),
    };

    socket.on('message', (data) => this.onPreAuthMessage(pending, data));
    socket.on('close', () => {
      if (!pending.settled) this.finishPending(pending);
    });
    socket.on('error', () => {
      if (!pending.settled) this.finishPending(pending);
    });
  }

  private onPreAuthMessage(pending: PendingSocket, data: unknown): void {
    if (pending.settled) return;
    const raw = typeof data === 'string' ? data : String(data);
    const result = decode(raw);
    if (!result.ok) {
      // Decode failure (bad JSON / schema / blank token / malformed agentId).
      this.rejectFrame(pending, result.message);
      return;
    }
    const msg = result.msg;
    if (msg.type !== 'register') {
      // Only `register` is accepted before auth.
      this.rejectFrame(pending, `expected register, got ${msg.type}`);
      return;
    }
    this.onRegister(pending, msg);
  }

  private onRegister(pending: PendingSocket, msg: Extract<ProtocolMessage, { type: 'register' }>): void {
    // Version check first (a mismatched peer cannot be trusted to parse frames).
    if (msg.protocolVersion !== PROTOCOL_VERSION) {
      this.logger.warn('agent registration rejected', {
        path: this.wsPath,
        agentId: msg.agentId,
        reason: 'VERSION_MISMATCH',
      });
      this.send(pending.socket, {
        type: 'register:nack',
        ok: false,
        code: 'VERSION_MISMATCH',
        message: `server protocol v${PROTOCOL_VERSION}`,
      });
      this.finishPending(pending);
      this.safeClose(pending.socket);
      return;
    }
    // Token check via throw-safe safeEqual; never log the token.
    if (!validateToken(msg.token, this.tokens)) {
      this.logger.warn('agent registration rejected', {
        path: this.wsPath,
        agentId: msg.agentId,
        authed: false,
      });
      this.send(pending.socket, {
        type: 'register:nack',
        ok: false,
        code: 'AUTH_FAILED',
        message: 'invalid agent token',
      });
      this.finishPending(pending);
      this.safeClose(pending.socket);
      return;
    }

    // Success: register in the fleet, mark online, start liveness.
    this.finishPending(pending);
    pending.agentId = msg.agentId;
    const entry = this.registry.register(msg.agentId, msg.meta, pending.socket);
    this.logger.info('agent registered', { path: this.wsPath, agentId: msg.agentId, authed: true });

    this.send(pending.socket, {
      type: 'register:ack',
      ok: true,
      serverTime: this.now(),
      heartbeatSec: this.heartbeatSec,
    });

    // Post-auth: route every subsequent frame to the registry; heartbeat ack.
    const socket = pending.socket;
    socket.on('message', (data) => this.onAuthedMessage(entry.id, socket, data));
    socket.on('close', () => this.onAgentClose(entry.id));
    socket.on('error', () => this.onAgentClose(entry.id));
    this.startHeartbeat(entry.id, socket);
  }

  private onAuthedMessage(agentId: string, socket: GatewaySocket, data: unknown): void {
    const raw = typeof data === 'string' ? data : String(data);
    const result = decode(raw);
    if (!result.ok) {
      this.logger.debug('agent sent bad frame post-auth', { agentId });
      return;
    }
    const msg = result.msg;
    if (msg.type === 'heartbeat') {
      this.send(socket, { type: 'heartbeat:ack', ts: msg.ts });
      return;
    }
    this.registry.handleFrame(agentId, msg);
  }

  private onAgentClose(agentId: string): void {
    const timer = this.heartbeatTimers.get(agentId);
    if (timer) {
      this.clearTimer(timer);
      this.heartbeatTimers.delete(agentId);
    }
    this.registry.markOffline(agentId);
  }

  // --- liveness (post-auth only) ---

  private startHeartbeat(agentId: string, socket: GatewaySocket): void {
    const existing = this.heartbeatTimers.get(agentId);
    if (existing) {
      this.clearTimer(existing);
      this.heartbeatTimers.delete(agentId);
    }
    const ms = this.heartbeatSec * 1000;
    const tick = (): void => {
      const timer = this.setTimer(() => {
        this.heartbeatTimers.delete(agentId);
        const entry = this.registry.get(agentId);
        if (!entry || !entry.online) return;
        try {
          socket.ping?.();
        } catch {
          /* best-effort */
        }
        tick();
      }, ms);
      this.heartbeatTimers.set(agentId, timer);
    };
    tick();
  }

  // --- helpers ---

  private rejectFrame(pending: PendingSocket, message: string): void {
    this.send(pending.socket, { type: 'error:frame', code: 'BAD_MESSAGE', message });
    this.finishPending(pending);
    this.safeClose(pending.socket);
  }

  /** Clears the handshake timer and decrements the pending count once. */
  private finishPending(pending: PendingSocket): void {
    if (pending.settled) return;
    pending.settled = true;
    this.clearTimer(pending.handshakeTimer);
    this.pendingCount = Math.max(0, this.pendingCount - 1);
  }

  private send(socket: GatewaySocket | null, msg: ProtocolMessage): void {
    if (!socket) return;
    try {
      socket.send(encode(msg));
    } catch (err) {
      this.logger.debug('agent gateway send failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private safeClose(socket: GatewaySocket): void {
    try {
      socket.close();
    } catch {
      /* best-effort */
    }
  }

  /** Current count of un-registered sockets (test/introspection aid). */
  pendingSockets(): number {
    return this.pendingCount;
  }
}

// Re-export WebSocket for callers that need the production socket type.
export type { WebSocket };
