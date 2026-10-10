/**
 * DigestScheduler: a daily email summary. On each fire it builds a report
 * (per-process status table, restart counts, top error signatures, total alerts
 * dispatched/suppressed) and sends it via `EmailChannel.sendRaw`, then schedules
 * the next day. It is independent of maintenance mode (a planned window should
 * not drop the summary) and a send failure warns without stopping the schedule.
 *
 * The "top error signatures" metric is an approximation: signatures whose
 * `lastSeen` is within the last 24h, ranked by all-time `count` descending, top
 * N — bounded by `ERROR_BUFFER_SIZE` (evicted signatures are not counted).
 */

import { createLogger, type Logger } from '../core/logger.js';
import type { ProcessSnapshot, TrackedError } from '../core/types.js';
import type { EmailChannel, RawMessage } from './channels/types.js';

/** The read surface the digest needs from the hub + error tracker. */
export interface DigestDataSource {
  processes(): ProcessSnapshot[];
  /** deduped tracked errors for a process (most-recent last). */
  trackedErrors(name: string): TrackedError[];
}

/** Running totals the engine maintains for the current digest period. */
export interface AlertCounters {
  dispatched(): number;
  suppressed(): number;
}

export interface DigestSchedulerOptions {
  email: EmailChannel;
  source: DigestDataSource;
  counters: AlertCounters;
  /** DIGEST_HOUR local hour (0-23). */
  digestHour: number;
  /** DIGEST_ENABLED. */
  enabled: boolean;
  /** ERROR_BUFFER_SIZE, surfaced in the approximation note. */
  errorBufferSize: number;
  /** top-N error signatures to list (default 10). */
  topN?: number;
  logger?: Logger;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export class DigestScheduler {
  private readonly email: EmailChannel;
  private readonly source: DigestDataSource;
  private readonly counters: AlertCounters;
  private digestHour: number;
  private enabled: boolean;
  private readonly errorBufferSize: number;
  private readonly topN: number;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(options: DigestSchedulerOptions) {
    this.email = options.email;
    this.source = options.source;
    this.counters = options.counters;
    this.digestHour = Math.min(23, Math.max(0, Math.floor(options.digestHour)));
    this.enabled = options.enabled;
    this.errorBufferSize = options.errorBufferSize;
    this.topN = Math.max(1, options.topN ?? 10);
    this.logger = options.logger ?? createLogger();
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h));
  }

  /** Starts the schedule if enabled and the email channel is configured. */
  start(): void {
    if (!this.enabled) {
      this.logger.info('daily digest disabled (DIGEST_ENABLED is false)');
      return;
    }
    if (!this.email.enabled) {
      this.logger.warnOnce('digest-no-email', 'daily digest requires a configured email channel; not scheduling');
      return;
    }
    this.stopped = false;
    this.schedule();
  }

  /**
   * Live-applies DIGEST_ENABLED: start the schedule when turning on, stop it
   * when turning off.
   */
  setEnabled(b: boolean): void {
    this.enabled = b;
    if (this.enabled) {
      this.start();
    } else {
      this.stop();
    }
  }

  /**
   * Live-applies DIGEST_HOUR (clamped 0..23): cancels the pending timer and
   * re-schedules so the next fire uses the new hour.
   */
  setDigestHour(n: number): void {
    this.digestHour = Math.min(23, Math.max(0, Math.floor(n)));
    this.stop();
    if (this.enabled && this.email.enabled) {
      this.stopped = false;
      this.schedule();
    }
  }

  /** Cancels the pending timer. */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  /** Computes the ms until the next local DIGEST_HOUR occurrence. */
  msUntilNextFire(): number {
    return this.nextFireAt(this.now()) - this.now();
  }

  /** The epoch-ms timestamp of the next local DIGEST_HOUR at/after `from`. */
  nextFireAt(from: number): number {
    const d = new Date(from);
    const next = new Date(from);
    next.setHours(this.digestHour, 0, 0, 0);
    if (next.getTime() <= d.getTime()) {
      next.setTime(next.getTime() + DAY_MS);
    }
    return next.getTime();
  }

  private schedule(): void {
    if (this.stopped) return;
    const delay = Math.max(0, this.msUntilNextFire());
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.fire().finally(() => {
        if (!this.stopped) this.schedule();
      });
    }, delay);
  }

  /** Builds and sends the digest. A send failure warns and never throws. */
  async fire(): Promise<void> {
    const message = this.build();
    try {
      await this.email.sendRaw(message);
      this.logger.info('daily digest sent');
    } catch (err) {
      this.logger.warn('daily digest send failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Builds the digest message (pure given the data source + counters). */
  build(): RawMessage {
    const now = this.now();
    const procs = [...this.source.processes()].sort((a, b) => a.name.localeCompare(b.name));
    const topErrors = this.topErrorSignatures(now);
    const dispatched = this.counters.dispatched();
    const suppressed = this.counters.suppressed();
    const dateLabel = new Date(now).toISOString();

    const text = this.buildText(procs, topErrors, dispatched, suppressed, dateLabel);
    const html = this.buildHtml(procs, topErrors, dispatched, suppressed, dateLabel);
    return { subject: `PM2 daily digest — ${dateLabel}`, text, html };
  }

  /**
   * Signatures whose `lastSeen` is within the last 24h, ranked by all-time
   * `count` descending, top N. An approximation bounded by ERROR_BUFFER_SIZE.
   */
  private topErrorSignatures(now: number): TrackedError[] {
    const cutoff = now - DAY_MS;
    const all: TrackedError[] = [];
    for (const p of this.source.processes()) {
      for (const e of this.source.trackedErrors(p.name)) {
        if (e.lastSeen >= cutoff) all.push(e);
      }
    }
    all.sort((a, b) => b.count - a.count);
    return all.slice(0, this.topN);
  }

  private buildText(
    procs: ProcessSnapshot[],
    topErrors: TrackedError[],
    dispatched: number,
    suppressed: number,
    dateLabel: string,
  ): string {
    const lines: string[] = [`PM2 daily digest — ${dateLabel}`, ''];
    lines.push('Processes:');
    for (const p of procs) {
      lines.push(`  ${p.name}: ${p.status}, restarts=${p.restarts}, instances=${p.instances}`);
    }
    if (procs.length === 0) lines.push('  (no processes)');
    lines.push('', `Alerts dispatched: ${dispatched}`, `Alerts suppressed: ${suppressed}`, '');
    lines.push(`Top error signatures (last 24h, ranked by all-time count, top ${this.topN}):`);
    lines.push(`  Note: approximation bounded by ERROR_BUFFER_SIZE=${this.errorBufferSize}.`);
    for (const e of topErrors) {
      lines.push(`  [${e.count}] ${e.processName}: ${e.message}`);
    }
    if (topErrors.length === 0) lines.push('  (none in the last 24h)');
    return lines.join('\n');
  }

  private buildHtml(
    procs: ProcessSnapshot[],
    topErrors: TrackedError[],
    dispatched: number,
    suppressed: number,
    dateLabel: string,
  ): string {
    const procRows = procs
      .map(
        (p) =>
          `<tr><td>${esc(p.name)}</td><td>${esc(p.status)}</td><td>${p.restarts}</td><td>${p.instances}</td></tr>`,
      )
      .join('');
    const errRows = topErrors
      .map((e) => `<tr><td>${e.count}</td><td>${esc(e.processName)}</td><td>${esc(e.message)}</td></tr>`)
      .join('');
    return [
      `<h2>PM2 daily digest — ${esc(dateLabel)}</h2>`,
      '<h3>Processes</h3>',
      `<table><thead><tr><th>Name</th><th>Status</th><th>Restarts</th><th>Instances</th></tr></thead><tbody>${procRows}</tbody></table>`,
      `<p>Alerts dispatched: ${dispatched} &middot; suppressed: ${suppressed}</p>`,
      `<h3>Top error signatures (last 24h, ranked by all-time count, top ${this.topN})</h3>`,
      `<p><em>Approximation bounded by ERROR_BUFFER_SIZE=${this.errorBufferSize}.</em></p>`,
      `<table><thead><tr><th>Count</th><th>Process</th><th>Message</th></tr></thead><tbody>${errRows}</tbody></table>`,
    ].join('');
  }
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
