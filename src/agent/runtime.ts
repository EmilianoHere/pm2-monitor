/**
 * AgentRuntime: the event<->wire bridge. It subscribes to MonitorEvents and
 * forwards state/transition/metrics/error/pm2 frames to the server (only while
 * registered), dispatches inbound control/log frames, and owns a LogForwarder.
 *
 * Control dispatch re-validates every request with the SAME `src/api/schemas.ts`
 * validators the REST layer uses (defense in depth, AC-17) BEFORE touching PM2:
 *  - name-only actions: processNameSchema.safeParse(name).
 *  - start-new: createProcess.safeParse({ body: opts }) — the mandatory `{ body }`
 *    wrapper. On success the POST-transform body is consumed (so instances>1 with
 *    no exec_mode becomes cluster) and reconstructed into StartNewOpts exactly as
 *    the REST route does; path existence is checked against the AGENT's disk via
 *    the injected RequestSchemas.
 * A validation failure returns a correlated control:response { VALIDATION } and
 * never calls PM2 (AC-18). PM2 is reached through a Pm2Deps facade (not a raw
 * Pm2Client), so a command before PM2 attaches returns PM2_UNAVAILABLE (AC-14).
 *
 * Snapshot resend: on (re)connect AND whenever the process NAME SET changes (a
 * start-new/delete), throttled/coalesced to <=1/sec like WsHub state throttling,
 * so the server's authoritative process set + metric prune stay correct in
 * steady state. Pure status/metric changes flow as transition/metrics deltas.
 */

import type { Logger } from '../core/logger.js';
import type { MonitorEvents, ProcessTransitionEvent } from '../core/events.js';
import type { MonitorState } from '../core/state.js';
import type { MonitorSnapshot, ProcessSnapshot, TrackedError } from '../core/types.js';
import type { Pm2Deps } from '../api/server.js';
import type { ControlAction, StartNewOpts } from '../pm2/client.js';
import type { CreateProcessBody, RequestSchemas } from '../api/schemas.js';
import { processNameSchema } from '../api/schemas.js';
import type { ProtocolMessage } from '../protocol/messages.js';
import { LogForwarder } from './logForwarder.js';

const STATE_THROTTLE_MS = 1000;

export interface AgentRuntimeOptions {
  events: MonitorEvents;
  state: MonitorState;
  /** the Pm2Deps facade (short-circuits to PM2_UNAVAILABLE until wired). */
  pm2: Pm2Deps;
  /** RequestSchemas built with the AGENT's ALLOWED_SCRIPT_ROOT. */
  schemas: RequestSchemas;
  logger: Logger;
  /** sends an outbound frame when registered (typically AgentConnection.send). */
  send: (msg: ProtocolMessage) => void;
  /** true while the link is registered; frames are dropped when false. */
  isConnected: () => boolean;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

export class AgentRuntime {
  private readonly events: MonitorEvents;
  private readonly state: MonitorState;
  private readonly pm2: Pm2Deps;
  private readonly schemas: RequestSchemas;
  private readonly logger: Logger;
  private readonly send: (msg: ProtocolMessage) => void;
  private readonly isConnected: () => boolean;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
  private readonly logForwarder: LogForwarder;

  /** last process name set we told the server about (for resend-on-change). */
  private lastNameSet = new Set<string>();
  private pendingSnapshot: MonitorSnapshot | null = null;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly onStateUpdate = (snap: MonitorSnapshot): void => this.onState(snap);
  private readonly onTransition = (e: ProcessTransitionEvent): void => this.onProcessTransition(e);
  private readonly onMetricsTick = (list: ProcessSnapshot[]): void => this.onMetrics(list);
  private readonly onErrorCaptured = (err: TrackedError): void => this.onError(err);
  private readonly onPm2Connected = (): void => this.onPm2(true);
  private readonly onPm2Disconnected = (): void => this.onPm2(false);

  constructor(opts: AgentRuntimeOptions) {
    this.events = opts.events;
    this.state = opts.state;
    this.pm2 = opts.pm2;
    this.schemas = opts.schemas;
    this.logger = opts.logger;
    this.send = opts.send;
    this.isConnected = opts.isConnected;
    this.now = opts.now ?? (() => Date.now());
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h));
    this.logForwarder = new LogForwarder({ events: this.events, send: (m) => this.sendIfConnected(m) });

    this.events.on('state:update', this.onStateUpdate);
    this.events.on('process:transition', this.onTransition);
    this.events.on('metrics:tick', this.onMetricsTick);
    this.events.on('error:captured', this.onErrorCaptured);
    this.events.on('pm2:connected', this.onPm2Connected);
    this.events.on('pm2:disconnected', this.onPm2Disconnected);
  }

  /** Detaches listeners and cancels timers. */
  stop(): void {
    this.events.off('state:update', this.onStateUpdate);
    this.events.off('process:transition', this.onTransition);
    this.events.off('metrics:tick', this.onMetricsTick);
    this.events.off('error:captured', this.onErrorCaptured);
    this.events.off('pm2:connected', this.onPm2Connected);
    this.events.off('pm2:disconnected', this.onPm2Disconnected);
    this.logForwarder.stop();
    if (this.snapshotTimer) {
      this.clearTimer(this.snapshotTimer);
      this.snapshotTimer = null;
    }
    this.pendingSnapshot = null;
  }

  /**
   * Called by the connection on register:ack: resets the name-set tracker and
   * sends a fresh snapshot immediately (resync-by-snapshot, AC-13/16).
   */
  onRegistered(): void {
    this.lastNameSet = new Set();
    this.pendingSnapshot = null;
    if (this.snapshotTimer) {
      this.clearTimer(this.snapshotTimer);
      this.snapshotTimer = null;
    }
    this.sendSnapshot(this.state.snapshot());
  }

  /** Called by the connection on link teardown: clears log subscriptions. */
  onDisconnected(): void {
    this.logForwarder.clear();
  }

  /** Dispatches a decoded inbound frame (control/log). */
  handleMessage(msg: ProtocolMessage): void {
    switch (msg.type) {
      case 'control:request':
        void this.handleControlRequest(msg.cid, msg.action, msg.name);
        return;
      case 'control:createRequest':
        void this.handleCreateRequest(msg.cid, msg.opts);
        return;
      case 'log:subscribe':
        this.logForwarder.subscribe(msg.process, msg.streams);
        return;
      case 'log:unsubscribe':
        this.logForwarder.unsubscribe(msg.process);
        return;
      default:
        // Other frame types are not inbound-dispatched on the agent.
        this.logger.debug('agent ignored inbound frame', { type: msg.type });
    }
  }

  // --- inbound control ---

  private async handleControlRequest(cid: string, action: ControlAction, name: string): Promise<void> {
    const parsed = processNameSchema.safeParse(name);
    if (!parsed.success) {
      this.respondValidation(cid, parsed.error.issues.map((i) => i.message).join('; '));
      return;
    }
    const result = await this.pm2.control(action, name);
    this.sendIfConnected({ type: 'control:response', cid, result });
  }

  private async handleCreateRequest(cid: string, opts: StartNewOpts): Promise<void> {
    // Mandatory { body } wrapper: validate against the agent's RequestSchemas so
    // path existence is checked on the agent disk and the transform (cluster
    // default-injection) is applied before reaching PM2.
    const parsed = this.schemas.createProcess.safeParse({ body: opts });
    if (!parsed.success) {
      this.respondValidation(
        cid,
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
      return;
    }
    // Consume the POST-transform body (exec_mode:'cluster' already injected when
    // instances>1), reconstructing StartNewOpts exactly as the REST route does.
    const body = (parsed.data as CreateProcessBody).body;
    const startOpts: StartNewOpts = {
      ...(body.script !== undefined ? { script: body.script } : {}),
      ...(body.ecosystem !== undefined ? { ecosystem: body.ecosystem } : {}),
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.instances !== undefined ? { instances: body.instances } : {}),
      ...(body.exec_mode !== undefined ? { exec_mode: body.exec_mode } : {}),
    };
    const result = await this.pm2.startNew(startOpts);
    this.sendIfConnected({ type: 'control:response', cid, result });
  }

  private respondValidation(cid: string, message: string): void {
    this.sendIfConnected({
      type: 'control:response',
      cid,
      result: { ok: false, code: 'VALIDATION', message },
    });
  }

  // --- outbound event bridge ---

  private onState(snap: MonitorSnapshot): void {
    if (!this.isConnected()) return;
    const names = new Set(snap.processes.map((p) => p.name));
    if (!sameSet(names, this.lastNameSet)) {
      // The process set changed (start-new/delete): re-assert the authoritative
      // set with a throttled snapshot resend.
      this.queueSnapshot(snap);
    }
  }

  private onProcessTransition(e: ProcessTransitionEvent): void {
    this.sendIfConnected({ type: 'update:transition', name: e.name, from: e.from, to: e.to, at: e.at });
  }

  private onMetrics(list: ProcessSnapshot[]): void {
    if (!this.isConnected()) return;
    const samples = list
      .filter((snap) => snap.status === 'online')
      .map((snap) => ({ name: snap.name, ts: snap.lastUpdated, cpu: snap.cpu, mem: snap.memory }));
    this.send({ type: 'update:metrics', samples });
  }

  private onError(err: TrackedError): void {
    this.sendIfConnected({ type: 'update:error', error: err });
  }

  private onPm2(connected: boolean): void {
    this.sendIfConnected({ type: 'update:pm2', connected });
  }

  // --- snapshot throttle (coalesced, <=1/sec, mirrors WsHub) ---

  private queueSnapshot(snap: MonitorSnapshot): void {
    this.pendingSnapshot = snap;
    if (this.snapshotTimer) return; // already scheduled within the window
    this.flushSnapshot();
    this.snapshotTimer = this.setTimer(() => {
      this.snapshotTimer = null;
      if (this.pendingSnapshot) this.flushSnapshot();
    }, STATE_THROTTLE_MS);
  }

  private flushSnapshot(): void {
    if (!this.pendingSnapshot) return;
    const snap = this.pendingSnapshot;
    this.pendingSnapshot = null;
    this.sendSnapshot(snap);
  }

  private sendSnapshot(snap: MonitorSnapshot): void {
    this.lastNameSet = new Set(snap.processes.map((p) => p.name));
    this.sendIfConnected({
      type: 'snapshot',
      processes: snap.processes,
      pm2Connected: snap.pm2Connected,
      generatedAt: snap.generatedAt,
    });
  }

  private sendIfConnected(msg: ProtocolMessage): void {
    if (!this.isConnected()) return;
    this.send(msg);
  }
}

/** True when two sets contain the same members. */
function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) {
    if (!b.has(v)) return false;
  }
  return true;
}
