/**
 * ErrorTracker: subscribes to `error:captured`, deduplicates by signature into a
 * per-process map + bounded ring buffer, and maintains two 1-second-slot rings
 * per process (errors and crash-loop restarts) for windowed rule evaluation.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MonitorEvents } from '../core/events.js';
import type { TrackedError } from '../core/types.js';
import { createLogger, type Logger } from '../core/logger.js';
import { signature as computeSignature } from './signature.js';

export interface ErrorTrackerOptions {
  events: MonitorEvents;
  /** per-process ring buffer capacity (ERROR_BUFFER_SIZE) */
  bufferSize: number;
  /** append each raw captured error to logs/errors.log when true */
  logAppend: boolean;
  /** path for the append log; defaults to logs/errors.log */
  logFile?: string;
  logger?: Logger;
  /** injectable clock returning epoch ms */
  now?: () => number;
}

/** Minimum ring length in seconds when no windowed rule is loaded. */
const MIN_WINDOW_SEC = 60;

/**
 * A fixed-size ring of integer counts, one slot per second. Each physical slot
 * carries the second it represents, so a stale slot (whose second has rolled out
 * of the window) reads as zero without any sweep bookkeeping.
 */
class SlotRing {
  private sec: number[];
  private count: number[];
  private len: number;

  constructor(lengthSec: number) {
    this.len = Math.max(1, lengthSec);
    this.sec = new Array<number>(this.len).fill(Number.NEGATIVE_INFINITY);
    this.count = new Array<number>(this.len).fill(0);
  }

  get length(): number {
    return this.len;
  }

  private slot(nowSec: number): number {
    return ((nowSec % this.len) + this.len) % this.len;
  }

  increment(nowSec: number): void {
    const idx = this.slot(nowSec);
    if (this.sec[idx] !== nowSec) {
      this.sec[idx] = nowSec;
      this.count[idx] = 0;
    }
    this.count[idx] += 1;
  }

  /** Sums the trailing `sinceSec` one-second slots ending at `nowSec`. */
  sum(nowSec: number, sinceSec: number): number {
    const span = Math.min(sinceSec, this.len);
    let total = 0;
    for (let i = 0; i < span; i++) {
      const s = nowSec - i;
      const idx = this.slot(s);
      if (this.sec[idx] === s) total += this.count[idx];
    }
    return total;
  }

  /** Resizes the ring, preserving the trailing counts (grow=zero-fill). */
  resize(lengthSec: number, nowSec: number): void {
    const newLen = Math.max(1, lengthSec);
    const nextSec = new Array<number>(newLen).fill(Number.NEGATIVE_INFINITY);
    const nextCount = new Array<number>(newLen).fill(0);
    const keep = Math.min(newLen, this.len);
    for (let i = 0; i < keep; i++) {
      const s = nowSec - i;
      const oldIdx = this.slot(s);
      if (this.sec[oldIdx] === s) {
        const newIdx = ((s % newLen) + newLen) % newLen;
        nextSec[newIdx] = s;
        nextCount[newIdx] = this.count[oldIdx];
      }
    }
    this.sec = nextSec;
    this.count = nextCount;
    this.len = newLen;
  }
}

interface ProcessBucket {
  bySignature: Map<string, TrackedError>;
  /** signatures ordered by insertion; used for ring eviction */
  order: string[];
  errorRing: SlotRing;
  restartRing: SlotRing;
}

export class ErrorTracker {
  private readonly events: MonitorEvents;
  private readonly bufferSize: number;
  private readonly logAppend: boolean;
  private readonly logFile: string;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly buckets = new Map<string, ProcessBucket>();
  private maxWindowSec = MIN_WINDOW_SEC;
  private logDirReady = false;

  private readonly onCaptured = (err: TrackedError): void => this.handle(err);

  constructor(options: ErrorTrackerOptions) {
    this.events = options.events;
    this.bufferSize = Math.max(1, options.bufferSize);
    this.logAppend = options.logAppend;
    this.logFile = options.logFile ?? 'logs/errors.log';
    this.logger = options.logger ?? createLogger();
    this.now = options.now ?? (() => Date.now());
    this.events.on('error:captured', this.onCaptured);
  }

  /** Detaches the event listener. */
  stop(): void {
    this.events.off('error:captured', this.onCaptured);
  }

  private nowSec(): number {
    return Math.floor(this.now() / 1000);
  }

  private bucket(name: string): ProcessBucket {
    let bucket = this.buckets.get(name);
    if (!bucket) {
      bucket = {
        bySignature: new Map(),
        order: [],
        errorRing: new SlotRing(this.maxWindowSec),
        restartRing: new SlotRing(this.maxWindowSec),
      };
      this.buckets.set(name, bucket);
    }
    return bucket;
  }

  /**
   * Recomputes the ring length from the loaded rules and resizes both rings for
   * every tracked process. Used on load and on rules reload.
   */
  setMaxWindow(sec: number): void {
    const next = Math.max(MIN_WINDOW_SEC, Math.ceil(sec));
    this.maxWindowSec = next;
    const nowSec = this.nowSec();
    for (const bucket of this.buckets.values()) {
      bucket.errorRing.resize(next, nowSec);
      bucket.restartRing.resize(next, nowSec);
    }
  }

  private handle(err: TrackedError): void {
    const now = this.now();
    const nowSec = Math.floor(now / 1000);
    const bucket = this.bucket(err.processName);
    const sig = computeSignature(err.processName, err.sample || err.message || '');

    const existing = bucket.bySignature.get(sig);
    if (existing) {
      existing.count += 1;
      existing.lastSeen = now;
      existing.level = err.level;
      if (err.intentional !== undefined) existing.intentional = err.intentional;
      // Refresh recency for eviction order.
      const idx = bucket.order.indexOf(sig);
      if (idx !== -1) bucket.order.splice(idx, 1);
      bucket.order.push(sig);
    } else {
      const tracked: TrackedError = {
        signature: sig,
        processName: err.processName,
        firstSeen: err.firstSeen || now,
        lastSeen: now,
        count: 1,
        level: err.level,
        intentional: err.intentional,
        message: err.message,
        sample: err.sample,
      };
      bucket.bySignature.set(sig, tracked);
      bucket.order.push(sig);
      // Evict the oldest when over capacity.
      while (bucket.order.length > this.bufferSize) {
        const evicted = bucket.order.shift();
        if (evicted !== undefined) bucket.bySignature.delete(evicted);
      }
    }

    // Window rings.
    if (err.level === 'error') {
      bucket.errorRing.increment(nowSec);
    }
    // Restart ring: only crash-loop restarts (intentional === false).
    if (err.level === 'restart' && err.intentional === false) {
      bucket.restartRing.increment(nowSec);
    }

    this.appendRaw(err, now);
  }

  private appendRaw(err: TrackedError, now: number): void {
    if (!this.logAppend) return;
    try {
      if (!this.logDirReady) {
        mkdirSync(dirname(this.logFile), { recursive: true });
        this.logDirReady = true;
      }
      const line = JSON.stringify({ ...err, capturedAt: now }) + '\n';
      appendFileSync(this.logFile, line, 'utf8');
    } catch (writeErr) {
      this.logger.warnOnce('error-log-append', 'Failed to append to error log', {
        file: this.logFile,
        error: String(writeErr),
      });
    }
  }

  private clampWindow(name: string, sinceSec: number, ringLen: number): number {
    if (sinceSec > ringLen) {
      this.logger.warnOnce(
        `window-clamp:${name}:${sinceSec}`,
        'Requested window exceeds ring length; clamping',
        { process: name, requestedSec: sinceSec, ringLengthSec: ringLen },
      );
      return ringLen;
    }
    return sinceSec;
  }

  /** Sums error-level captures for `name` over the trailing `sinceSec`. */
  countInWindow(name: string, sinceSec: number): number {
    const bucket = this.buckets.get(name);
    if (!bucket) return 0;
    const span = this.clampWindow(name, sinceSec, bucket.errorRing.length);
    return bucket.errorRing.sum(this.nowSec(), span);
  }

  /** Sums crash-loop restarts for `name` over the trailing `sinceSec`. */
  restartsInWindow(name: string, sinceSec: number): number {
    const bucket = this.buckets.get(name);
    if (!bucket) return 0;
    const span = this.clampWindow(name, sinceSec, bucket.restartRing.length);
    return bucket.restartRing.sum(this.nowSec(), span);
  }

  /** Returns the deduped tracked errors for a process (most-recent last). */
  list(name: string): TrackedError[] {
    const bucket = this.buckets.get(name);
    if (!bucket) return [];
    return bucket.order
      .map((sig) => bucket.bySignature.get(sig))
      .filter((e): e is TrackedError => e !== undefined);
  }

  /** Drops all tracking state for a process (used when a process is deleted). */
  drop(name: string): void {
    this.buckets.delete(name);
  }
}
