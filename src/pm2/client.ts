/**
 * Pm2Client: the ONLY module that imports the `pm2` package. All daemon access
 * goes through an injectable {@link Pm2Adapter} so tests substitute a fake and
 * never need a real pm2 daemon. The client owns:
 *
 *  - connection + exponential-backoff reconnection,
 *  - the four-channel bus subscription and event -> MonitorEvents translation,
 *  - the per-process intentional-action FIFO token model,
 *  - the single metrics poll loop that emits `metrics:tick`,
 *  - bounded log-tail reading.
 *
 * Everything else in the app reaches pm2 through this class and the MonitorState
 * hub + MonitorEvents emitter — never the `pm2` package directly.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { MonitorEvents } from '../core/events.js';
import { createLogger, type Logger } from '../core/logger.js';
import type { MonitorState } from '../core/state.js';
import { neutralizeInheritedIpc } from './ipc.js';
import type { LogLine, ProcessSnapshot, TrackedError } from '../core/types.js';
import {
  aggregateList,
  mapProcess,
  normalizeEventName,
  normalizeException,
  normalizeProc,
  type RawProcess,
} from './mapper.js';

// --- public control contract (mirrors the design interface) ---

export type ControlAction = 'start' | 'stop' | 'restart' | 'reload' | 'delete';

export interface StartNewOpts {
  script?: string;
  ecosystem?: string;
  name?: string;
  instances?: number;
  exec_mode?: 'fork' | 'cluster';
}

export interface LogTailOpts {
  stream?: 'out' | 'err' | 'all';
  q?: string;
  level?: 'info' | 'error';
}

export type ControlResult =
  | { ok: true; process: ProcessSnapshot }
  | { ok: false; code: string; message: string };

// --- injectable pm2 adapter (callback-style, mirrors the pm2 package) ---

export type AdapterCallback<T> = (err: Error | null, result: T) => void;

/**
 * A minimal, callback-based surface over the `pm2` package. The real adapter
 * ({@link createPm2Adapter}) is the single place that imports `pm2`; fakes
 * implement this interface directly.
 */
export interface Pm2Adapter {
  connect(cb: (err: Error | null) => void): void;
  disconnect(): void;
  list(cb: AdapterCallback<RawProcess[]>): void;
  describe(name: string, cb: AdapterCallback<RawProcess[]>): void;
  start(options: Record<string, unknown>, cb: AdapterCallback<RawProcess[]>): void;
  startScript(script: string, cb: AdapterCallback<RawProcess[]>): void;
  stop(name: string, cb: AdapterCallback<RawProcess[]>): void;
  restart(name: string, cb: AdapterCallback<RawProcess[]>): void;
  reload(name: string, cb: AdapterCallback<RawProcess[]>): void;
  del(name: string, cb: AdapterCallback<RawProcess[]>): void;
  launchBus(cb: AdapterCallback<Pm2Bus>): void;
}

/** The event bus returned by `launchBus`. */
export interface Pm2Bus {
  on(channel: string, handler: (packet: unknown) => void): void;
  off?(channel: string, handler: (packet: unknown) => void): void;
  close?(): void;
}

// --- intentional-action tokens ---

export interface IntentionToken {
  kind: 'stop' | 'restart' | 'delete';
  expiresAt: number;
}

export interface Pm2ClientOptions {
  adapter: Pm2Adapter;
  state: MonitorState;
  events: MonitorEvents;
  logger: Logger;
  /** METRICS_SAMPLE_SEC */
  sampleSec: number;
  /** INTENTIONAL_ACTION_GRACE_MS base grace window */
  graceMs: number;
  /** injectable clock returning epoch ms (tests) */
  now?: () => number;
  /** injectable setTimeout/setInterval (tests) */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

const PM2_CONNECT_TIMEOUT_MS = 10_000;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30_000;
const JANITOR_INTERVAL_MS = 30_000;
const MAX_TAIL_LINES = 2000;
const BUS_CHANNELS = ['process:event', 'process:exception', 'log:err', 'log:out'] as const;

export class Pm2Client {
  private readonly adapter: Pm2Adapter;
  private readonly state: MonitorState;
  private readonly events: MonitorEvents;
  private readonly logger: Logger;
  private readonly sampleSec: number;
  private readonly graceMs: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;

  private connected = false;
  private stopped = false;
  private firstConnectFailure = true;
  private backoffAttempt = 0;

  private bus: Pm2Bus | null = null;
  private busHandlers: Array<{ channel: string; handler: (packet: unknown) => void }> = [];
  private metricsTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private janitorTimer: ReturnType<typeof setTimeout> | null = null;

  /** per-process FIFO queue of intentional-action tokens */
  private readonly intentions = new Map<string, IntentionToken[]>();
  /** cached kill_timeout per process name (ms), learned from describe */
  private readonly killTimeouts = new Map<string, number>();

  constructor(options: Pm2ClientOptions) {
    this.adapter = options.adapter;
    this.state = options.state;
    this.events = options.events;
    this.logger = options.logger;
    this.sampleSec = Math.max(1, options.sampleSec);
    this.graceMs = Math.max(0, options.graceMs);
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h));
  }

  // --- lifecycle ---

  /** Begins the connect + reconnect loop. Non-blocking; never throws. */
  start(): void {
    this.stopped = false;
    this.attemptConnect();
  }

  /** Disconnects, closes the bus, and clears every timer. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.clearMetricsTimer();
    this.clearReconnectTimer();
    this.clearJanitorTimer();
    this.detachBus();
    if (this.connected) {
      try {
        this.adapter.disconnect();
      } catch (err) {
        this.logger.debug('pm2 disconnect threw during stop', { err: errText(err) });
      }
    }
    this.connected = false;
    this.state.setConnected(false);
  }

  isConnected(): boolean {
    return this.connected;
  }

  // --- connection + reconnection ---

  private attemptConnect(): void {
    if (this.stopped) return;
    this.adapter.connect((err) => {
      if (this.stopped) return;
      if (err) {
        this.onConnectFailure(err);
        return;
      }
      this.onConnectSuccess();
    });
  }

  private onConnectSuccess(): void {
    this.connected = true;
    this.firstConnectFailure = true;
    this.backoffAttempt = 0;
    this.state.setConnected(true);
    this.startJanitor();
    // Initial list, then attach the bus and start the metrics loop.
    void this.refreshAndApply().finally(() => {
      this.attachBus();
      this.startMetricsLoop();
    });
  }

  private onConnectFailure(err: Error): void {
    this.connected = false;
    this.state.setConnected(false);
    if (this.firstConnectFailure) {
      this.logger.warn('pm2 connect failed; starting reconnect loop', { err: errText(err) });
      this.firstConnectFailure = false;
    } else {
      this.logger.debug('pm2 reconnect attempt failed', { err: errText(err) });
    }
    this.scheduleReconnect();
  }

  /** Called when the bus drops or a connection-level error is observed. */
  private onConnectionLost(reason: string): void {
    if (this.stopped || !this.connected) {
      // Already disconnected or shutting down; nothing to tear down twice.
      if (!this.connected) return;
    }
    this.logger.warn('pm2 connection lost; reconnecting', { reason });
    this.connected = false;
    this.state.setConnected(false);
    this.clearMetricsTimer();
    this.detachBus();
    try {
      this.adapter.disconnect();
    } catch {
      /* best-effort */
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.clearReconnectTimer();
    const delay = this.backoffDelay(this.backoffAttempt);
    this.backoffAttempt += 1;
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      this.attemptConnect();
    }, delay);
  }

  /** Exponential backoff 1s,2s,4s,… capped at 30s with +/-20% jitter. */
  private backoffDelay(attempt: number): number {
    const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
    const jitter = base * 0.2 * (Math.random() * 2 - 1);
    return Math.max(0, Math.round(base + jitter));
  }

  // --- list / describe ---

  async list(): Promise<ProcessSnapshot[]> {
    const raw = await this.promisify<RawProcess[]>((cb) => this.adapter.list(cb));
    return aggregateList(raw ?? [], this.logger, this.now());
  }

  async describe(name: string): Promise<ProcessSnapshot | null> {
    const raw = await this.promisify<RawProcess[]>((cb) => this.adapter.describe(name, cb));
    const records = raw ?? [];
    if (records.length === 0) return null;
    // Learn the kill_timeout for grace-window sizing.
    const killTimeout = records
      .map((r) => r.pm2_env?.kill_timeout)
      .find((v): v is number => typeof v === 'number' && Number.isFinite(v));
    if (killTimeout !== undefined) this.killTimeouts.set(name, killTimeout);
    const [agg] = aggregateList(records, this.logger, this.now());
    return agg ?? null;
  }

  /** Re-lists and applies to the hub (shared by initial connect + metrics loop). */
  private async refreshAndApply(): Promise<ProcessSnapshot[]> {
    const list = await this.list();
    this.state.applyPm2List(list);
    return list;
  }

  // --- control ---

  async control(action: ControlAction, name: string): Promise<ControlResult> {
    if (!this.connected) {
      this.logger.debug('control called while pm2 disconnected', { action, name });
      return { ok: false, code: 'PM2_UNAVAILABLE', message: 'PM2 daemon is not connected' };
    }
    // Push intentional-action tokens BEFORE invoking pm2 so the resulting bus
    // events find them (one token per running instance).
    this.pushTokensForControl(action, name);
    try {
      await this.invokeControl(action, name);
      const snap = await this.describe(name);
      if (snap) return { ok: true, process: snap };
      // delete removes the process; synthesize a minimal aggregate.
      if (action === 'delete') {
        return { ok: true, process: deletedSnapshot(name, this.now()) };
      }
      return { ok: false, code: 'PM2_ERROR', message: `process ${name} not found after ${action}` };
    } catch (err) {
      this.logger.warn('pm2 control call failed', { action, name, err: errText(err) });
      return { ok: false, code: 'PM2_ERROR', message: errText(err) };
    }
  }

  async startNew(opts: StartNewOpts): Promise<ControlResult> {
    if (!this.connected) {
      this.logger.debug('startNew called while pm2 disconnected', { name: opts.name });
      return { ok: false, code: 'PM2_UNAVAILABLE', message: 'PM2 daemon is not connected' };
    }
    try {
      const target = opts.ecosystem ?? opts.script;
      let raw: RawProcess[];
      if (opts.ecosystem) {
        // Ecosystem files are started by path (pm2.start(file)).
        raw = (await this.promisify<RawProcess[]>((cb) => this.adapter.startScript(opts.ecosystem as string, cb))) ?? [];
      } else {
        const startOptions: Record<string, unknown> = {};
        if (opts.script !== undefined) startOptions.script = opts.script;
        if (opts.name !== undefined) startOptions.name = opts.name;
        if (opts.instances !== undefined) startOptions.instances = opts.instances;
        if (opts.exec_mode !== undefined) startOptions.exec_mode = `${opts.exec_mode}_mode`;
        raw = (await this.promisify<RawProcess[]>((cb) => this.adapter.start(startOptions, cb))) ?? [];
      }
      // startNew pushes NO intentional token (a start produces only `online`).
      const resolvedName = opts.name ?? raw[0]?.name;
      if (typeof resolvedName === 'string') {
        const snap = await this.describe(resolvedName);
        if (snap) return { ok: true, process: snap };
      }
      if (raw.length > 0) return { ok: true, process: mapProcess(raw[0], this.now()) };
      return { ok: false, code: 'PM2_ERROR', message: `started process from ${String(target)} but got no description` };
    } catch (err) {
      this.logger.warn('pm2 startNew failed', { name: opts.name, err: errText(err) });
      return { ok: false, code: 'PM2_ERROR', message: errText(err) };
    }
  }

  private invokeControl(action: ControlAction, name: string): Promise<RawProcess[]> {
    switch (action) {
      case 'start':
        return this.promisify<RawProcess[]>((cb) => this.adapter.startScript(name, cb));
      case 'stop':
        return this.promisify<RawProcess[]>((cb) => this.adapter.stop(name, cb));
      case 'restart':
        return this.promisify<RawProcess[]>((cb) => this.adapter.restart(name, cb));
      case 'reload':
        return this.promisify<RawProcess[]>((cb) => this.adapter.reload(name, cb));
      case 'delete':
        return this.promisify<RawProcess[]>((cb) => this.adapter.del(name, cb));
    }
  }

  // --- intentional-action token model ---

  private graceMsFor(name: string): number {
    return this.graceMs + (this.killTimeouts.get(name) ?? 0);
  }

  private instanceCountFor(name: string): number {
    const snap = this.state.getProcess(name);
    return snap && snap.instances > 0 ? snap.instances : 1;
  }

  private pushTokensForControl(action: ControlAction, name: string): void {
    let kind: IntentionToken['kind'] | null;
    switch (action) {
      case 'stop':
        kind = 'stop';
        break;
      case 'delete':
        kind = 'delete';
        break;
      case 'restart':
      case 'reload':
        kind = 'restart';
        break;
      default:
        kind = null; // start / startNew push none
    }
    if (kind === null) return;
    const count = this.instanceCountFor(name);
    const expiresAt = this.now() + this.graceMsFor(name);
    const queue = this.intentions.get(name) ?? [];
    for (let i = 0; i < count; i += 1) {
      queue.push({ kind, expiresAt });
    }
    this.intentions.set(name, queue);
  }

  /**
   * Drops expired tokens then consumes exactly one non-expired FIFO token for
   * `name`, if present. Returns the consumed token or null.
   */
  private consumeToken(name: string): IntentionToken | null {
    const queue = this.intentions.get(name);
    if (!queue || queue.length === 0) return null;
    const now = this.now();
    // Drop expired tokens (they sit at the front since all share FIFO order).
    while (queue.length > 0 && queue[0].expiresAt <= now) {
      queue.shift();
    }
    if (queue.length === 0) {
      this.intentions.delete(name);
      return null;
    }
    const token = queue.shift() as IntentionToken;
    if (queue.length === 0) this.intentions.delete(name);
    return token;
  }

  private sweepExpiredTokens(): void {
    const now = this.now();
    for (const [name, queue] of this.intentions) {
      const kept = queue.filter((t) => t.expiresAt > now);
      if (kept.length === 0) {
        this.intentions.delete(name);
      } else if (kept.length !== queue.length) {
        this.intentions.set(name, kept);
      }
    }
  }

  private startJanitor(): void {
    if (this.janitorTimer) return;
    this.janitorTimer = this.setTimer(() => {
      this.janitorTimer = null;
      if (this.stopped) return;
      this.sweepExpiredTokens();
      this.startJanitor();
    }, JANITOR_INTERVAL_MS);
  }

  // --- bus subscription + translation ---

  private attachBus(): void {
    this.adapter.launchBus((err, bus) => {
      if (this.stopped) return;
      if (err || !bus) {
        this.logger.warn('pm2 launchBus failed', { err: err ? errText(err) : 'no bus' });
        this.onConnectionLost('launchBus failed');
        return;
      }
      this.bus = bus;
      this.busHandlers = [];
      for (const channel of BUS_CHANNELS) {
        const handler = (packet: unknown): void => this.onBusPacket(channel, packet);
        bus.on(channel, handler);
        this.busHandlers.push({ channel, handler });
      }
    });
  }

  private detachBus(): void {
    if (!this.bus) return;
    if (this.bus.off) {
      for (const { channel, handler } of this.busHandlers) {
        this.bus.off(channel, handler);
      }
    }
    try {
      this.bus.close?.();
    } catch {
      /* best-effort */
    }
    this.bus = null;
    this.busHandlers = [];
  }

  private onBusPacket(channel: string, packet: unknown): void {
    switch (channel) {
      case 'process:event':
        this.handleProcessEvent(packet);
        return;
      case 'process:exception':
        this.handleException(packet);
        return;
      case 'log:err':
        this.handleLog(packet, 'err');
        return;
      case 'log:out':
        this.handleLog(packet, 'out');
        return;
    }
  }

  private handleProcessEvent(packet: unknown): void {
    const ev = normalizeEventName(packet);
    const proc = normalizeProc(packet);
    if (ev === null || proc === null) {
      this.logger.warnOnce('bus-malformed', 'skipped malformed process:event packet');
      return;
    }
    const name = proc.name;
    switch (ev) {
      case 'online':
      case 'start':
        this.emitTransition(name, 'online');
        return;
      case 'restart': {
        // A restart's exit half consumed (or not) a token; a restart token marks
        // the captured restart as intentional.
        const token = this.consumeToken(name);
        const intentional = token?.kind === 'restart';
        this.emitTransition(name, 'online');
        this.captureError(name, {
          level: 'restart',
          intentional,
          message: intentional ? 'process restarted (operator-initiated)' : 'process restarted (crash-loop)',
          sample: `restart event for ${name}`,
        });
        return;
      }
      case 'restart overlimit':
        // Terminal errored crash: drives `errored` ONLY, never the restart
        // counter (MEDIUM-3). Emitted at level crash with no restart tagging.
        this.emitTransition(name, 'errored');
        this.captureError(name, {
          level: 'crash',
          message: 'process reached restart overlimit (errored)',
          sample: `restart overlimit for ${name}`,
        });
        return;
      case 'exit': {
        const token = this.consumeToken(name);
        if (!token) {
          // Unexpected exit -> crash.
          this.captureError(name, {
            level: 'crash',
            message: 'process exited unexpectedly',
            sample: `exit event for ${name}`,
          });
        }
        return;
      }
      case 'stop': {
        this.consumeToken(name);
        this.emitTransition(name, 'stopped');
        return;
      }
      case 'delete':
        this.consumeToken(name);
        this.removeFromSnapshot(name);
        return;
      default:
        this.logger.debug('ignored unknown process:event', { event: ev, name });
    }
  }

  private handleException(packet: unknown): void {
    const proc = normalizeProc(packet);
    if (proc === null) {
      this.logger.warnOnce('bus-malformed', 'skipped malformed process:exception packet');
      return;
    }
    const data = (packet as { data?: unknown }).data;
    const { message, stack } = normalizeException(data);
    this.logger.debug('process:exception captured', { name: proc.name });
    this.captureError(proc.name, { level: 'crash', message, sample: stack });
  }

  private handleLog(packet: unknown, stream: 'out' | 'err'): void {
    const proc = normalizeProc(packet);
    if (proc === null) {
      this.logger.warnOnce('bus-malformed', 'skipped malformed log packet');
      return;
    }
    const data = (packet as { data?: unknown }).data;
    const text = typeof data === 'string' ? data : String(data ?? '');
    const level: 'info' | 'error' = stream === 'err' ? 'error' : 'info';
    const ts = this.now();
    for (const line of text.split('\n')) {
      if (line.length === 0) continue;
      this.events.emit('log:line', { process: proc.name, stream, level, line, ts });
      if (stream === 'err') {
        // Each err line also feeds the error tracker at level error.
        this.captureError(proc.name, { level: 'error', message: line, sample: line });
      }
    }
  }

  // --- event helpers ---

  private emitTransition(name: string, to: ProcessSnapshot['status']): void {
    const prev = this.state.getProcess(name);
    const from = prev?.status ?? 'unknown';
    if (from !== to) {
      this.events.emit('process:transition', { name, from, to, at: this.now() });
    }
  }

  private removeFromSnapshot(name: string): void {
    const current = this.state.snapshot().processes.filter((p) => p.name !== name);
    this.state.applyPm2List(current);
  }

  private captureError(
    name: string,
    partial: Pick<TrackedError, 'level' | 'message' | 'sample'> & { intentional?: boolean },
  ): void {
    const ts = this.now();
    // The ErrorTracker recomputes the signature from processName + sample; a
    // partial TrackedError with an empty signature is accepted (per FEAT-001).
    const tracked: TrackedError = {
      signature: '',
      processName: name,
      firstSeen: ts,
      lastSeen: ts,
      count: 1,
      level: partial.level,
      ...(partial.intentional !== undefined ? { intentional: partial.intentional } : {}),
      message: partial.message,
      sample: partial.sample,
    };
    this.events.emit('error:captured', tracked);
  }

  // --- metrics poll loop (MEDIUM-1) ---

  private startMetricsLoop(): void {
    if (this.metricsTimer || this.stopped) return;
    const tick = (): void => {
      this.metricsTimer = this.setTimer(() => {
        this.metricsTimer = null;
        void this.pollTick().finally(() => {
          if (!this.stopped && this.connected) tick();
        });
      }, this.sampleSec * 1000);
    };
    tick();
  }

  private async pollTick(): Promise<void> {
    if (!this.connected || this.stopped) return;
    try {
      const list = await this.list();
      this.state.applyPm2List(list);
      // Exactly one metrics:tick per successful poll.
      this.events.emit('metrics:tick', list);
    } catch (err) {
      // Transient error: skip the tick, keep last samples.
      this.logger.debug('metrics poll list() failed; skipping tick', { err: errText(err) });
    }
  }

  // --- bounded log tail reading ---

  async readLogsTail(name: string, lines: number, opts: LogTailOpts = {}): Promise<LogLine[]> {
    const clamped = Math.max(1, Math.min(MAX_TAIL_LINES, Math.floor(lines)));
    const stream = opts.stream ?? 'all';
    const desc = await this.describe(name);
    if (!desc) return [];
    const paths = await this.resolveLogPaths(name);

    const collected: LogLine[] = [];
    if (stream === 'out' || stream === 'all') {
      if (paths.out) collected.push(...(await this.readTailFile(paths.out, 'out', clamped)));
    }
    if (stream === 'err' || stream === 'all') {
      if (paths.err) collected.push(...(await this.readTailFile(paths.err, 'err', clamped)));
    }

    let result = collected;
    if (stream === 'all') {
      result = [...collected].sort((a, b) => a.ts - b.ts).slice(-clamped);
    } else {
      result = collected.slice(-clamped);
    }

    // Level filter, then q filter — both in memory over the tail slice.
    if (opts.level) {
      result = result.filter((l) => l.level === opts.level);
    }
    if (opts.q && opts.q.length > 0) {
      const matcher = buildMatcher(opts.q);
      result = result.filter((l) => matcher(l.line));
    }
    return result;
  }

  private async resolveLogPaths(name: string): Promise<{ out: string | null; err: string | null }> {
    const raw = await this.promisify<RawProcess[]>((cb) => this.adapter.describe(name, cb));
    const env = (raw ?? [])[0]?.pm2_env;
    return {
      out: typeof env?.pm_out_log_path === 'string' ? env.pm_out_log_path : null,
      err: typeof env?.pm_err_log_path === 'string' ? env.pm_err_log_path : null,
    };
  }

  /**
   * Reads the trailing `lines` physical lines of a file via a bounded
   * end-of-file read. On a missing/unreadable file returns [] (the route layer
   * turns a known-process-missing-file into a 200 with an empty list).
   */
  private async readTailFile(path: string, stream: 'out' | 'err', lines: number): Promise<LogLine[]> {
    let size: number;
    try {
      const st = await stat(path);
      size = st.size;
    } catch (err) {
      this.logger.warnOnce(`logtail-stat:${path}`, 'could not stat log file', { path, err: errText(err) });
      return [];
    }
    if (size === 0) return [];

    // Grow the read window until we have enough newlines or hit the file start.
    let chunkSize = 64 * 1024;
    let text = '';
    let start = Math.max(0, size - chunkSize);
    for (;;) {
      text = await this.readRange(path, start, size);
      if (text === null) return [];
      const newlineCount = countNewlines(text);
      if (newlineCount >= lines || start === 0) break;
      chunkSize *= 2;
      start = Math.max(0, size - chunkSize);
    }

    const level: 'info' | 'error' = stream === 'err' ? 'error' : 'info';
    const physical = text.split('\n');
    // A trailing newline yields a final empty element — drop empties.
    const nonEmpty = physical.filter((l) => l.length > 0);
    const tail = nonEmpty.slice(-lines);
    const base = this.now() - tail.length;
    return tail.map((line, i) => ({
      stream,
      level,
      line,
      ts: parseEmbeddedTs(line) ?? base + i,
    }));
  }

  private readRange(path: string, start: number, end: number): Promise<string> {
    return new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      const rs = createReadStream(path, { start, end: Math.max(start, end - 1) });
      rs.on('data', (c) => chunks.push(c as Buffer));
      rs.on('error', (err) => {
        this.logger.warnOnce(`logtail-read:${path}`, 'could not read log file', { path, err: errText(err) });
        resolve('');
      });
      rs.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
  }

  // --- callback -> promise helper ---

  private promisify<T>(invoke: (cb: AdapterCallback<T>) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      invoke((err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });
  }

  // --- timer helpers ---

  private clearMetricsTimer(): void {
    if (this.metricsTimer) {
      this.clearTimer(this.metricsTimer);
      this.metricsTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      this.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearJanitorTimer(): void {
    if (this.janitorTimer) {
      this.clearTimer(this.janitorTimer);
      this.janitorTimer = null;
    }
  }
}

// --- module-level helpers ---

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function countNewlines(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) n += 1;
  }
  return n;
}

/** Extracts a leading ISO-ish timestamp from a log line if present. */
function parseEmbeddedTs(line: string): number | null {
  // pm2 log_date_format commonly prefixes lines; try to parse a leading token.
  const match = line.match(/^\s*(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/);
  if (!match) return null;
  const ms = Date.parse(match[1].replace(' ', 'T'));
  return Number.isNaN(ms) ? null : ms;
}

/** Builds a case-insensitive substring, or /regex/, matcher for `q`. */
function buildMatcher(q: string): (line: string) => boolean {
  const regexForm = q.match(/^\/(.+)\/([a-z]*)$/);
  if (regexForm) {
    try {
      const flags = regexForm[2].includes('i') ? regexForm[2] : regexForm[2] + 'i';
      const re = new RegExp(regexForm[1], flags);
      return (line) => re.test(line);
    } catch {
      // Fall through to substring on an invalid regex.
    }
  }
  const needle = q.toLowerCase();
  return (line) => line.toLowerCase().includes(needle);
}

function deletedSnapshot(name: string, now: number): ProcessSnapshot {
  return {
    pmId: -1,
    name,
    pid: null,
    status: 'stopped',
    cpu: 0,
    memory: 0,
    uptimeMs: null,
    restarts: 0,
    unstableRestarts: 0,
    mode: 'fork',
    instances: 0,
    execPath: null,
    lastUpdated: now,
  };
}

// --- real pm2 adapter: the ONLY place the `pm2` package is imported ---

/**
 * Builds the production adapter backed by the `pm2` package. This function is
 * the single import site for `pm2`; keeping it behind the {@link Pm2Adapter}
 * interface means tests inject a fake and never touch a real daemon.
 */
export async function createPm2Adapter(logger: Logger = createLogger()): Promise<Pm2Adapter> {
  // Sever any inherited PM2 IPC channel (fork-mode child) BEFORE importing and
  // connecting the pm2 client, otherwise its RPC collides with the parent
  // channel and pingDaemon/connect hang forever. No-op when not under PM2.
  neutralizeInheritedIpc(logger);
  const pm2 = (await import('pm2')).default;
  // `pm2.connect` launches a daemon when none is running (daemon mode) — which
  // would start PM2 just by booting the monitor and defeats graceful
  // degradation. Gate connect on a ping of the existing daemon: attach only if
  // one is already alive, otherwise surface an error so the Pm2Client reconnect
  // loop keeps pm2Connected=false and retries. This never launches a daemon.
  const client = (pm2 as unknown as { Client?: { pingDaemon(cb: (alive: boolean) => void): void } }).Client;
  return {
    connect: (cb) => {
      // Guard so EXACTLY one of {not-alive, connect callback, timeout} invokes
      // the outer cb; a timeout feeds the Pm2Client reconnect/backoff loop
      // instead of hanging if pingDaemon or connect never calls back.
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cb(new Error('pm2 connect timed out'));
      }, PM2_CONNECT_TIMEOUT_MS);
      const finish = (err: Error | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cb(err);
      };
      const doConnect = (): void => pm2.connect((err: Error | null) => finish(err ?? null));
      if (client && typeof client.pingDaemon === 'function') {
        client.pingDaemon((alive: boolean) => {
          if (alive) doConnect();
          else finish(new Error('PM2 daemon is not running'));
        });
        return;
      }
      // No ping surface available: fall back to the plain connect.
      doConnect();
    },
    disconnect: () => pm2.disconnect(),
    list: (cb) => pm2.list((err: Error | null, procs: unknown) => cb(err ?? null, (procs ?? []) as RawProcess[])),
    describe: (name, cb) =>
      pm2.describe(name, (err: Error | null, procs: unknown) => cb(err ?? null, (procs ?? []) as RawProcess[])),
    start: (options, cb) =>
      pm2.start(options, (err: Error | null, procs: unknown) => cb(err ?? null, (procs ?? []) as RawProcess[])),
    startScript: (script, cb) =>
      pm2.start(script, (err: Error | null, procs: unknown) => cb(err ?? null, (procs ?? []) as RawProcess[])),
    stop: (name, cb) =>
      pm2.stop(name, (err: Error | null, procs: unknown) => cb(err ?? null, (procs ?? []) as RawProcess[])),
    restart: (name, cb) =>
      pm2.restart(name, (err: Error | null, procs: unknown) => cb(err ?? null, (procs ?? []) as RawProcess[])),
    reload: (name, cb) =>
      pm2.reload(name, (err: Error | null, procs: unknown) => cb(err ?? null, (procs ?? []) as RawProcess[])),
    del: (name, cb) =>
      pm2.delete(name, (err: Error | null, procs: unknown) => cb(err ?? null, (procs ?? []) as RawProcess[])),
    launchBus: (cb) => pm2.launchBus((err: Error | null, bus: unknown) => cb(err ?? null, bus as Pm2Bus)),
  };
}
