/**
 * WsHub: attaches a `ws` WebSocketServer in noServer mode to the shared
 * http.Server and authenticates every upgrade with the SAME `safeEqual` used by
 * the REST auth (so a wrong-length credential returns 401 instead of throwing).
 *
 * Upgrade auth extracts the credential from the offered `apikey.<KEY>`
 * subprotocol or a `?token=<KEY>` query param. On success it calls
 * `handleUpgrade` and echoes the exact offered subprotocol back (compliant
 * browsers abort if the server does not echo one). On failure it writes
 * `HTTP/1.1 401` and destroys the socket before any WebSocket is constructed.
 *
 * The upgrade path NEVER logs `req.url` (which may carry `?token=`); it logs the
 * fixed path "/ws" plus an `authed` boolean only.
 *
 * Each client has its own subscription set. The hub subscribes to the state hub
 * events and fans out: `state` (throttled/coalesced to ≤1/sec), `process:transition`,
 * `log` (per-process, only to subscribers of that process+stream), `alert`,
 * `pm2`, and `pong`. Malformed client frames get an `error` with code BAD_MESSAGE.
 */

import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import type { Logger } from '../core/logger.js';
import type { MonitorEvents, ProcessTransitionEvent, LogLineEvent, AlertEvent } from '../core/events.js';
import type { MonitorSnapshot } from '../core/types.js';
import { validateWsCredential, type AuthConfig, type KeyVerifier } from '../api/auth.js';
import { agentIdSchema } from '../protocol/shapes.js';
import { processNameSchema } from '../api/schemas.js';

const SUBPROTOCOL_PREFIX = 'apikey.';
const STATE_THROTTLE_MS = 1000;

/** One relayed log line delivered back to a subscribed human client. */
export interface RelayLogLine {
  agentId: string;
  process: string;
  stream: 'out' | 'err';
  level: 'info' | 'error';
  line: string;
  ts: number;
}

/** A per-subscription human client the relay pushes lines to (ref-counted upstream). */
export interface RelayLogClient {
  deliver(line: RelayLogLine): void;
}

/**
 * The fleet log-relay hook the hub uses for agent-scoped `log:subscribe`
 * (server mode only; undefined in standalone). Mirrors the FleetRegistry
 * subscribeLogs/unsubscribeLogs surface. `agentId`/`process` are validated by
 * the hub BEFORE any call here.
 */
export interface FleetLogRelay {
  subscribeLogs(
    agentId: string,
    process: string,
    streams: Array<'out' | 'err'>,
    client: RelayLogClient,
  ): boolean;
  unsubscribeLogs(agentId: string, process: string, client: RelayLogClient): void;
}

interface ClientState {
  socket: WebSocket;
  /** top-level channels: 'state' and/or 'alerts'. */
  channels: Set<string>;
  /** per-process log-tail subscriptions: process name -> set of streams. */
  logSubs: Map<string, Set<'out' | 'err'>>;
  /** agent-scoped relay subscriptions (server mode): set of `${agentId}/${process}`. */
  relaySubs: Set<string>;
  /** the relay client view of this socket (lazily created on first relay subscribe). */
  relayClient: RelayLogClient | null;
}

export interface WsHubOptions {
  server: Server;
  events: MonitorEvents;
  auth: AuthConfig;
  /**
   * Optional secondary-key verifier (apikey mode). When set, an active secondary
   * key authenticates a WS upgrade too. Undefined → byte-identical to today.
   */
  keys?: KeyVerifier;
  logger: Logger;
  /** supplies the current snapshot for the hello frame + throttled state. */
  snapshot: () => MonitorSnapshot;
  now?: () => number;
  /** injectable timer (tests). */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  /**
   * Optional fleet log relay (server mode). When set, a `log:subscribe` that
   * carries an `agentId` routes through this instead of the local fan-out.
   * Undefined in standalone — the standalone path stays byte-identical.
   */
  relay?: FleetLogRelay;
}

export class WsHub {
  private readonly wss: WebSocketServer;
  private readonly server: Server;
  private readonly events: MonitorEvents;
  private readonly auth: AuthConfig;
  private readonly keys: KeyVerifier | undefined;
  private readonly logger: Logger;
  private readonly getSnapshot: () => MonitorSnapshot;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
  private readonly relay: FleetLogRelay | undefined;

  private readonly clients = new Set<ClientState>();

  // state-broadcast throttle
  private pendingState: MonitorSnapshot | null = null;
  private stateTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly onStateUpdate = (snap: MonitorSnapshot): void => this.queueState(snap);
  private readonly onTransition = (e: ProcessTransitionEvent): void => this.broadcastTransition(e);
  private readonly onLogLine = (e: LogLineEvent): void => this.fanOutLog(e);
  private readonly onAlert = (e: AlertEvent): void => this.broadcastAlert(e);
  private readonly onConnected = (): void => this.broadcastPm2(true);
  private readonly onDisconnected = (): void => this.broadcastPm2(false);
  private readonly onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void =>
    this.handleUpgrade(req, socket, head);

  constructor(options: WsHubOptions) {
    this.server = options.server;
    this.events = options.events;
    this.auth = options.auth;
    this.keys = options.keys;
    this.logger = options.logger;
    this.getSnapshot = options.snapshot;
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h));
    this.relay = options.relay;

    // Echo back the client's offered subprotocol: compliant browsers abort the
    // handshake unless the server selects exactly one of the offered protocols.
    this.wss = new WebSocketServer({
      noServer: true,
      handleProtocols: (protocols: Set<string>) => {
        for (const p of protocols) {
          if (p.startsWith(SUBPROTOCOL_PREFIX)) return p;
        }
        // No subprotocol offered (e.g. ?token= path): select none.
        return false;
      },
    });

    this.server.on('upgrade', this.onUpgrade);
    this.events.on('state:update', this.onStateUpdate);
    this.events.on('process:transition', this.onTransition);
    this.events.on('log:line', this.onLogLine);
    this.events.on('alert', this.onAlert);
    this.events.on('pm2:connected', this.onConnected);
    this.events.on('pm2:disconnected', this.onDisconnected);
  }

  /** Detaches listeners, cancels timers, and closes every client + the server. */
  close(): void {
    this.server.off('upgrade', this.onUpgrade);
    this.events.off('state:update', this.onStateUpdate);
    this.events.off('process:transition', this.onTransition);
    this.events.off('log:line', this.onLogLine);
    this.events.off('alert', this.onAlert);
    this.events.off('pm2:connected', this.onConnected);
    this.events.off('pm2:disconnected', this.onDisconnected);
    if (this.stateTimer) {
      this.clearTimer(this.stateTimer);
      this.stateTimer = null;
    }
    for (const client of this.clients) {
      try {
        client.socket.close();
      } catch {
        /* best-effort */
      }
    }
    this.clients.clear();
    this.wss.close();
  }

  // --- upgrade handling ---

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = req.url ?? '';
    const pathname = url.split('?')[0];
    if (pathname !== '/ws') {
      // Not our endpoint; let any other upgrade handler deal with it. We do not
      // destroy here so a future second WS path is not clobbered.
      return;
    }

    const credential = this.extractCredential(req);
    const authed = validateWsCredential(this.auth, credential, this.keys).ok;
    // NEVER log req.url on the upgrade path — only the fixed path + authed flag.
    this.logger.debug('ws upgrade', { path: '/ws', authed });

    if (!authed) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    // handleProtocols (set on the WebSocketServer) echoes the offered apikey.*
    // subprotocol back in the 101 response.
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.registerClient(ws);
    });
  }

  /** Extracts the credential from the offered subprotocol or ?token= param. */
  private extractCredential(req: IncomingMessage): string {
    const header = req.headers['sec-websocket-protocol'];
    const offered = typeof header === 'string' ? header.split(',').map((s) => s.trim()) : [];
    for (const proto of offered) {
      if (proto.startsWith(SUBPROTOCOL_PREFIX)) {
        return proto.slice(SUBPROTOCOL_PREFIX.length);
      }
    }
    // Fallback: ?token= query param (non-browser clients).
    const url = req.url ?? '';
    const qIndex = url.indexOf('?');
    if (qIndex !== -1) {
      const params = new URLSearchParams(url.slice(qIndex + 1));
      const token = params.get('token');
      if (token) return token;
    }
    return '';
  }

  private registerClient(socket: WebSocket): void {
    const client: ClientState = {
      socket,
      channels: new Set(),
      logSubs: new Map(),
      relaySubs: new Set(),
      relayClient: null,
    };
    this.clients.add(client);

    socket.on('message', (data) => this.handleMessage(client, data.toString()));
    socket.on('close', () => this.dropClient(client));
    socket.on('error', () => this.dropClient(client));

    // hello with the current snapshot immediately on connect.
    this.sendTo(client, { type: 'hello', snapshot: this.getSnapshot(), serverTime: this.now() });
  }

  // --- client → server messages ---

  private handleMessage(client: ClientState, raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.sendTo(client, { type: 'error', code: 'BAD_MESSAGE', message: 'invalid JSON' });
      return;
    }
    if (typeof msg !== 'object' || msg === null || typeof (msg as { type?: unknown }).type !== 'string') {
      this.sendTo(client, { type: 'error', code: 'BAD_MESSAGE', message: 'missing type' });
      return;
    }
    const m = msg as Record<string, unknown>;
    switch (m.type) {
      case 'subscribe': {
        const channels = Array.isArray(m.channels) ? m.channels : [];
        client.channels = new Set(channels.filter((c): c is string => typeof c === 'string'));
        return;
      }
      case 'log:subscribe': {
        // Agent-scoped (server mode): validate agentId + process BEFORE any
        // registry lookup or upstream frame, then route through the relay.
        if (m.agentId !== undefined) {
          this.handleRelaySubscribe(client, m);
          return;
        }
        if (typeof m.process !== 'string') {
          this.sendTo(client, { type: 'error', code: 'BAD_MESSAGE', message: 'log:subscribe needs process' });
          return;
        }
        const streams = Array.isArray(m.streams)
          ? (m.streams.filter((s): s is 'out' | 'err' => s === 'out' || s === 'err'))
          : (['out', 'err'] as Array<'out' | 'err'>);
        client.logSubs.set(m.process, new Set(streams.length > 0 ? streams : ['out', 'err']));
        return;
      }
      case 'log:unsubscribe': {
        if (m.agentId !== undefined) {
          this.handleRelayUnsubscribe(client, m);
          return;
        }
        if (typeof m.process === 'string') client.logSubs.delete(m.process);
        return;
      }
      case 'ping':
        this.sendTo(client, { type: 'pong' });
        return;
      default:
        this.sendTo(client, { type: 'error', code: 'BAD_MESSAGE', message: `unknown type: ${String(m.type)}` });
    }
  }

  // --- agent-scoped log relay (server mode) ---

  /**
   * Validates `agentId` (agentIdSchema) and `process` (processNameSchema) on the
   * hot path BEFORE touching the relay. On any failure the existing BAD_MESSAGE
   * frame is returned and NEITHER the relay nor the registry is touched.
   */
  private handleRelaySubscribe(client: ClientState, m: Record<string, unknown>): void {
    const idOk = agentIdSchema.safeParse(m.agentId);
    const procOk = typeof m.process === 'string' && processNameSchema.safeParse(m.process).success;
    if (!idOk.success || !procOk) {
      this.sendTo(client, { type: 'error', code: 'BAD_MESSAGE', message: 'invalid agentId or process' });
      return;
    }
    const agentId = idOk.data;
    const process = m.process as string;
    const streams = Array.isArray(m.streams)
      ? (m.streams.filter((s): s is 'out' | 'err' => s === 'out' || s === 'err'))
      : (['out', 'err'] as Array<'out' | 'err'>);
    const useStreams = streams.length > 0 ? streams : (['out', 'err'] as Array<'out' | 'err'>);

    if (!this.relay) {
      this.sendTo(client, { type: 'error', code: 'BAD_MESSAGE', message: 'agent logs not available' });
      return;
    }
    const relayClient = this.relayClientFor(client);
    const key = `${agentId}/${process}`;
    if (this.relay.subscribeLogs(agentId, process, useStreams, relayClient)) {
      client.relaySubs.add(key);
    }
  }

  private handleRelayUnsubscribe(client: ClientState, m: Record<string, unknown>): void {
    const idOk = agentIdSchema.safeParse(m.agentId);
    const procOk = typeof m.process === 'string' && processNameSchema.safeParse(m.process).success;
    if (!idOk.success || !procOk) {
      this.sendTo(client, { type: 'error', code: 'BAD_MESSAGE', message: 'invalid agentId or process' });
      return;
    }
    const agentId = idOk.data;
    const process = m.process as string;
    const key = `${agentId}/${process}`;
    if (!client.relaySubs.has(key)) return;
    client.relaySubs.delete(key);
    if (client.relayClient && this.relay) {
      this.relay.unsubscribeLogs(agentId, process, client.relayClient);
    }
  }

  /** The relay client view for a socket (delivers lines as a `log` frame). */
  private relayClientFor(client: ClientState): RelayLogClient {
    if (client.relayClient) return client.relayClient;
    const relayClient: RelayLogClient = {
      deliver: (line: RelayLogLine) => {
        this.sendTo(client, {
          type: 'log',
          agentId: line.agentId,
          process: line.process,
          stream: line.stream,
          line: line.line,
          level: line.level,
          ts: line.ts,
        });
      },
    };
    client.relayClient = relayClient;
    return relayClient;
  }

  /** Removes a client, tearing down any agent-scoped relay subscriptions first. */
  private dropClient(client: ClientState): void {
    if (this.relay && client.relayClient && client.relaySubs.size > 0) {
      for (const key of client.relaySubs) {
        const idx = key.indexOf('/');
        if (idx === -1) continue;
        const agentId = key.slice(0, idx);
        const process = key.slice(idx + 1);
        this.relay.unsubscribeLogs(agentId, process, client.relayClient);
      }
    }
    client.relaySubs.clear();
    client.relayClient = null;
    this.clients.delete(client);
  }

  // --- server → client broadcasts ---

  private queueState(snap: MonitorSnapshot): void {
    this.pendingState = snap;
    if (this.stateTimer) return; // already scheduled within the throttle window
    this.flushState();
    this.stateTimer = this.setTimer(() => {
      this.stateTimer = null;
      if (this.pendingState) this.flushState();
    }, STATE_THROTTLE_MS);
  }

  private flushState(): void {
    if (!this.pendingState) return;
    const snap = this.pendingState;
    this.pendingState = null;
    this.broadcast((c) => c.channels.has('state'), { type: 'state', snapshot: snap });
  }

  private broadcastTransition(e: ProcessTransitionEvent): void {
    this.broadcast((c) => c.channels.has('state'), {
      type: 'process:transition',
      name: e.name,
      from: e.from,
      to: e.to,
      at: e.at,
    });
  }

  private fanOutLog(e: LogLineEvent): void {
    this.broadcast(
      (c) => {
        const streams = c.logSubs.get(e.process);
        return streams !== undefined && streams.has(e.stream);
      },
      { type: 'log', process: e.process, stream: e.stream, line: e.line, level: e.level, ts: e.ts },
    );
  }

  private broadcastAlert(e: AlertEvent): void {
    this.broadcast((c) => c.channels.has('alerts'), {
      type: 'alert',
      payload: e.payload,
      delivered: e.delivered,
    });
  }

  private broadcastPm2(connected: boolean): void {
    this.broadcast(() => true, { type: 'pm2', connected });
  }

  private broadcast(predicate: (c: ClientState) => boolean, message: unknown): void {
    const text = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.socket.readyState !== WebSocket.OPEN) continue;
      if (!predicate(client)) continue;
      try {
        client.socket.send(text);
      } catch {
        /* best-effort; a broken socket is cleaned up on its close/error event */
      }
    }
  }

  private sendTo(client: ClientState, message: unknown): void {
    if (client.socket.readyState !== WebSocket.OPEN) return;
    try {
      client.socket.send(JSON.stringify(message));
    } catch {
      /* best-effort */
    }
  }

  /** Number of connected clients (for tests/metrics). */
  clientCount(): number {
    return this.clients.size;
  }
}
