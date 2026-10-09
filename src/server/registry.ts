/**
 * FleetRegistry: the server's per-agent in-memory view of the fleet, keyed by a
 * stable `agentId`. Each {@link AgentEntry} holds fully isolated state — its own
 * process map, {@link MetricsStore}, {@link ErrorTracker}, pm2-connectivity
 * flag, pending-control correlation map, and live-log subscriber set — so one
 * agent's data or disconnect never affects another (AC-29).
 *
 * Frame handling reconstructs a MonitorState-shaped view from wire frames:
 *  - `snapshot` replaces the process map wholesale, then PRUNES every metric
 *    series whose name is absent from the new snapshot (the authoritative
 *    process set), porting MonitorState.onMetricsTick's prune so a deleted
 *    process leaves no ghost series (NFR-4).
 *  - `update:metrics` pushes samples with their wire `ts` carried VERBATIM and
 *    does NOT prune (it does not carry the full process set).
 *  - `control:response` settles the correlated pending request.
 *  - `log:line` fans out to that process's subscribed human clients.
 *
 * `routeControl` returns defined, NON-blocking failures for unknown/offline
 * agents and correlates a real response otherwise (15s AGENT_TIMEOUT, or
 * AGENT_OFFLINE on disconnect). On disconnect the entry is RETAINED (so the
 * operator still sees it offline) while in-flight commands fail fast.
 *
 * Live logs are kept in a bounded 200-line ring per (agentId, process),
 * ref-counted: created on first subscribe, torn down on last unsubscribe.
 */

import { EventEmitter } from 'node:events';
import { MetricsStore } from '../metrics/store.js';
import { ErrorTracker } from '../errors/tracker.js';
import { MonitorEvents } from '../core/events.js';
import { PendingRequests, newCid } from '../protocol/correlation.js';
import { encode } from '../protocol/codec.js';
import type { ProtocolMessage } from '../protocol/messages.js';
import type { Logger } from '../core/logger.js';
import type {
  ProcessSnapshot,
  MetricSample,
  LogLine,
  TrackedError,
  ProcStatus,
} from '../core/types.js';
import type { ControlResult, ControlAction, StartNewOpts } from '../pm2/client.js';

/** The subset of a server-side agent socket the registry drives. */
export interface AgentWebSocket {
  send(data: string): void;
}

/** A human client subscribed to a relayed log stream for a given process. */
export interface HumanLogClient {
  /** delivers one relayed log line to this client. */
  deliver(line: LogLineForClient): void;
}

/** The shape pushed to a subscribed human client (agent-scoped). */
export interface LogLineForClient {
  agentId: string;
  process: string;
  stream: 'out' | 'err';
  level: 'info' | 'error';
  line: string;
  ts: number;
}

/** Agent metadata captured from the register frame. */
export interface AgentMeta {
  hostname: string;
  platform: string;
  pm2Version?: string;
  monitorVersion: string;
  nameHint?: string;
}

const LOG_RING_CAPACITY = 200;
const DEFAULT_CONTROL_TIMEOUT_MS = 15_000;

interface LogRing {
  lines: LogLineForClient[];
  subscribers: Set<HumanLogClient>;
}

/** Per-agent isolated state. */
export interface AgentEntry {
  id: string;
  meta: AgentMeta;
  online: boolean;
  lastSeen: number;
  socket: AgentWebSocket | null;
  processes: Map<string, ProcessSnapshot>;
  metrics: MetricsStore;
  errors: ErrorTracker;
  pm2Connected: boolean;
  pending: PendingRequests<ControlResult>;
  /** per-agent typed event stream (re-emits transitions/errors for alerts/WS). */
  events: MonitorEvents;
  /** process -> bounded live log ring (created on first subscribe). */
  logRings: Map<string, LogRing>;
}

/** Fleet-level lifecycle events the server wires to (alerts/WS/health). */
export interface FleetEventMap {
  'agent:online': [string];
  'agent:offline': [string];
}

export interface FleetRegistryOptions {
  logger: Logger;
  /** METRICS_RETENTION_MIN (per-agent store). */
  retentionMin: number;
  /** METRICS_SAMPLE_SEC (per-agent store). */
  sampleSec: number;
  /** ERROR_BUFFER_SIZE (per-agent tracker). */
  errorBufferSize: number;
  /** routed-control timeout; default 15s. */
  controlTimeoutMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  rand?: () => number;
}

export class FleetRegistry {
  private readonly logger: Logger;
  private readonly retentionMin: number;
  private readonly sampleSec: number;
  private readonly errorBufferSize: number;
  private readonly controlTimeoutMs: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
  private readonly rand: () => number;

  private readonly entries = new Map<string, AgentEntry>();
  private readonly fleetEvents = new EventEmitter();

  constructor(opts: FleetRegistryOptions) {
    this.logger = opts.logger;
    this.retentionMin = opts.retentionMin;
    this.sampleSec = opts.sampleSec;
    this.errorBufferSize = opts.errorBufferSize;
    this.controlTimeoutMs = opts.controlTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS;
    this.now = opts.now ?? (() => Date.now());
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h));
    this.rand = opts.rand ?? Math.random;
  }

  // --- fleet event stream ---

  on<E extends keyof FleetEventMap>(event: E, listener: (...args: FleetEventMap[E]) => void): this {
    this.fleetEvents.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  off<E extends keyof FleetEventMap>(event: E, listener: (...args: FleetEventMap[E]) => void): this {
    this.fleetEvents.off(event, listener as (...args: unknown[]) => void);
    return this;
  }

  private emitFleet<E extends keyof FleetEventMap>(event: E, ...args: FleetEventMap[E]): void {
    this.fleetEvents.emit(event, ...args);
  }

  // --- registration / lifecycle ---

  /** Known agent ids (online or retained-offline). */
  ids(): string[] {
    return [...this.entries.keys()];
  }

  get(agentId: string): AgentEntry | undefined {
    return this.entries.get(agentId);
  }

  /** Number of known agents. */
  get size(): number {
    return this.entries.size;
  }

  /** Number of currently-online agents. */
  onlineCount(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.online) n += 1;
    return n;
  }

  /**
   * Registers (or re-attaches) an agent keyed by its STABLE id. A reconnecting
   * agent reuses its retained entry (preserving metrics/errors history) and
   * simply re-binds the socket and marks online.
   */
  register(agentId: string, meta: AgentMeta, socket: AgentWebSocket): AgentEntry {
    let entry = this.entries.get(agentId);
    if (!entry) {
      const events = new MonitorEvents();
      entry = {
        id: agentId,
        meta,
        online: true,
        lastSeen: this.now(),
        socket,
        processes: new Map(),
        metrics: new MetricsStore({ retentionMin: this.retentionMin, sampleSec: this.sampleSec, now: this.now }),
        errors: new ErrorTracker({
          events,
          bufferSize: this.errorBufferSize,
          logAppend: false,
          logger: this.logger,
          now: this.now,
        }),
        pm2Connected: false,
        pending: new PendingRequests<ControlResult>({
          timeoutMs: this.controlTimeoutMs,
          setTimer: this.setTimer,
          clearTimer: this.clearTimer,
          now: this.now,
          onTimeout: (cid) => ({ ok: false, code: 'AGENT_TIMEOUT', message: `control request ${cid} timed out` }),
        }),
        events,
        logRings: new Map(),
      };
      this.entries.set(agentId, entry);
    } else {
      entry.meta = meta;
      entry.socket = socket;
      entry.online = true;
      entry.lastSeen = this.now();
    }
    this.emitFleet('agent:online', agentId);
    return entry;
  }

  /**
   * Marks an agent offline on socket close/error: rejects every in-flight
   * command with AGENT_OFFLINE (so nothing hangs), clears its log subscribers,
   * and RETAINS the entry (and its alias) so it shows as offline. Emits a
   * single `agent:offline`.
   */
  markOffline(agentId: string): void {
    const entry = this.entries.get(agentId);
    if (!entry || !entry.online) return;
    entry.online = false;
    entry.socket = null;
    entry.pm2Connected = false;
    entry.lastSeen = this.now();
    entry.pending.rejectAll({ ok: false, code: 'AGENT_OFFLINE', message: 'agent disconnected' });
    entry.logRings.clear();
    this.emitFleet('agent:offline', agentId);
  }

  // --- inbound frame handling (A->S) ---

  /**
   * Routes an inbound agent frame into its entry. Unknown agent or a frame type
   * not handled here is a no-op (handshake frames are handled by the gateway).
   */
  handleFrame(agentId: string, msg: ProtocolMessage): void {
    const entry = this.entries.get(agentId);
    if (!entry) return;
    entry.lastSeen = this.now();
    switch (msg.type) {
      case 'snapshot':
        this.onSnapshot(entry, msg.processes, msg.pm2Connected);
        return;
      case 'update:transition':
        this.onTransition(entry, msg.name, msg.from, msg.to, msg.at);
        return;
      case 'update:metrics':
        this.onMetrics(entry, msg.samples);
        return;
      case 'update:error':
        this.onError(entry, msg.error);
        return;
      case 'update:pm2':
        entry.pm2Connected = msg.connected;
        return;
      case 'control:response':
        entry.pending.settle(msg.cid, msg.result);
        return;
      case 'log:line':
        this.onLogLine(entry, msg.process, msg.stream, msg.level, msg.line, msg.ts);
        return;
      default:
        // handshake/other frames are not registry concerns.
        return;
    }
  }

  private onSnapshot(entry: AgentEntry, processes: ProcessSnapshot[], pm2Connected: boolean): void {
    entry.processes = new Map(processes.map((p) => [p.name, p]));
    entry.pm2Connected = pm2Connected;
    entry.online = true;
    // Prune every metric series whose process is gone from the authoritative
    // snapshot (ported from MonitorState.onMetricsTick).
    const names = new Set(processes.map((p) => p.name));
    for (const name of entry.metrics.names()) {
      if (!names.has(name)) entry.metrics.drop(name);
    }
  }

  private onTransition(entry: AgentEntry, name: string, from: ProcStatus, to: ProcStatus, at: number): void {
    const prev = entry.processes.get(name);
    if (prev) entry.processes.set(name, { ...prev, status: to });
    entry.events.emit('process:transition', { name, from, to, at });
  }

  private onMetrics(entry: AgentEntry, samples: Array<{ name: string } & MetricSample>): void {
    // Push only — ts carried VERBATIM from the wire; NO prune here.
    for (const s of samples) {
      entry.metrics.push(s.name, { ts: s.ts, cpu: s.cpu, mem: s.mem });
    }
  }

  private onError(entry: AgentEntry, error: TrackedError): void {
    // Feed the per-agent tracker (via its event bus) and re-emit for alerts.
    entry.events.emit('error:captured', error);
  }

  private onLogLine(
    entry: AgentEntry,
    process: string,
    stream: 'out' | 'err',
    level: 'info' | 'error',
    line: string,
    ts: number,
  ): void {
    const ring = entry.logRings.get(process);
    if (!ring) return; // no active subscription for this process
    const payload: LogLineForClient = { agentId: entry.id, process, stream, level, line, ts };
    ring.lines.push(payload);
    while (ring.lines.length > LOG_RING_CAPACITY) ring.lines.shift();
    for (const client of ring.subscribers) {
      try {
        client.deliver(payload);
      } catch {
        /* best-effort fan-out */
      }
    }
  }

  // --- command routing (S->A) ---

  /**
   * Routes a name-only control action to the agent and resolves the correlated
   * ControlResult. Unknown/offline agents resolve defined, non-blocking
   * failures without sending anything.
   */
  routeControl(agentId: string, action: ControlAction, name: string): Promise<ControlResult> {
    const entry = this.entries.get(agentId);
    if (!entry) {
      return Promise.resolve({ ok: false, code: 'AGENT_NOT_FOUND', message: `unknown agent ${agentId}` });
    }
    if (!entry.online || !entry.socket) {
      return Promise.resolve({ ok: false, code: 'AGENT_OFFLINE', message: `agent ${agentId} is offline` });
    }
    const cid = newCid(this.now, this.rand);
    const p = entry.pending.create(cid);
    this.sendTo(entry, { type: 'control:request', cid, action, name });
    return p;
  }

  /** Routes a start-new (create) request to the agent. */
  routeCreate(agentId: string, opts: StartNewOpts): Promise<ControlResult> {
    const entry = this.entries.get(agentId);
    if (!entry) {
      return Promise.resolve({ ok: false, code: 'AGENT_NOT_FOUND', message: `unknown agent ${agentId}` });
    }
    if (!entry.online || !entry.socket) {
      return Promise.resolve({ ok: false, code: 'AGENT_OFFLINE', message: `agent ${agentId} is offline` });
    }
    const cid = newCid(this.now, this.rand);
    const p = entry.pending.create(cid);
    this.sendTo(entry, { type: 'control:createRequest', cid, opts });
    return p;
  }

  // --- live log relay (ref-counted per process) ---

  /**
   * Subscribes a human client to a process's live log relay. Creates the
   * bounded ring on first subscribe and sends `log:subscribe` upstream to the
   * agent then. Returns false (and sends nothing) if the agent is unknown.
   */
  subscribeLogs(agentId: string, process: string, streams: Array<'out' | 'err'>, client: HumanLogClient): boolean {
    const entry = this.entries.get(agentId);
    if (!entry) return false;
    let ring = entry.logRings.get(process);
    const first = ring === undefined;
    if (!ring) {
      ring = { lines: [], subscribers: new Set() };
      entry.logRings.set(process, ring);
    }
    ring.subscribers.add(client);
    if (first && entry.online && entry.socket) {
      const useStreams = streams.length > 0 ? streams : (['out', 'err'] as Array<'out' | 'err'>);
      this.sendTo(entry, { type: 'log:subscribe', process, streams: useStreams });
    }
    return true;
  }

  /**
   * Unsubscribes a human client; on the LAST subscriber the ring is torn down
   * and `log:unsubscribe` is sent upstream.
   */
  unsubscribeLogs(agentId: string, process: string, client: HumanLogClient): void {
    const entry = this.entries.get(agentId);
    if (!entry) return;
    const ring = entry.logRings.get(process);
    if (!ring) return;
    ring.subscribers.delete(client);
    if (ring.subscribers.size === 0) {
      entry.logRings.delete(process);
      if (entry.online && entry.socket) {
        this.sendTo(entry, { type: 'log:unsubscribe', process });
      }
    }
  }

  /** A snapshot of the live log ring for a process (empty if no subscription). */
  recentLogs(agentId: string, process: string): LogLineForClient[] {
    const ring = this.entries.get(agentId)?.logRings.get(process);
    return ring ? [...ring.lines] : [];
  }

  private sendTo(entry: AgentEntry, msg: ProtocolMessage): void {
    if (!entry.socket) return;
    try {
      entry.socket.send(encode(msg));
    } catch (err) {
      this.logger.debug('fleet send failed', {
        agentId: entry.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
