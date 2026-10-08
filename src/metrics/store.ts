/**
 * MetricsStore: per-process ring of MetricSample plus the single `sustainedAbove`
 * primitive used by the CPU/memory alert rules.
 *
 * `getSeries` is internal to the hub boundary — the only public per-process
 * series read is `MonitorState.getMetrics`, which delegates here.
 */

import type { MetricSample } from '../core/types.js';

export interface MetricsStoreOptions {
  /** METRICS_RETENTION_MIN */
  retentionMin: number;
  /** METRICS_SAMPLE_SEC */
  sampleSec: number;
  /** injectable clock returning epoch ms */
  now?: () => number;
}

export class MetricsStore {
  private readonly capacity: number;
  private readonly sampleSec: number;
  private readonly now: () => number;
  private readonly series = new Map<string, MetricSample[]>();

  constructor(options: MetricsStoreOptions) {
    this.sampleSec = Math.max(1, options.sampleSec);
    this.capacity = Math.max(1, Math.ceil((options.retentionMin * 60) / this.sampleSec));
    this.now = options.now ?? (() => Date.now());
  }

  /** Appends a sample for `name`, evicting expired and overflow samples. */
  push(name: string, sample: MetricSample): void {
    let ring = this.series.get(name);
    if (!ring) {
      ring = [];
      this.series.set(name, ring);
    }
    ring.push(sample);
    this.evict(ring);
  }

  private evict(ring: MetricSample[]): void {
    const retentionMs = this.capacity * this.sampleSec * 1000;
    const cutoff = this.now() - retentionMs;
    // Drop expired-by-age samples from the front.
    while (ring.length > 0 && ring[0].ts < cutoff) {
      ring.shift();
    }
    // Drop overflow beyond capacity from the front.
    while (ring.length > this.capacity) {
      ring.shift();
    }
  }

  /** Returns samples with `ts >= sinceMs`. Internal: reached only via the hub. */
  getSeries(name: string, sinceMs: number): MetricSample[] {
    const ring = this.series.get(name);
    if (!ring) return [];
    return ring.filter((s) => s.ts >= sinceMs);
  }

  /** Removes a process's series entirely (used on process delete). */
  drop(name: string): void {
    this.series.delete(name);
  }

  /** Names currently holding a series. */
  names(): string[] {
    return [...this.series.keys()];
  }

  /**
   * True iff `metric` exceeded `threshold` for the trailing `durationSec`, with
   * coverage tolerance. Fail-safe: returns false under insufficient coverage
   * (fewer than required samples, or any adjacent gap > 2*sampleSec).
   */
  sustainedAbove(
    name: string,
    metric: 'cpu' | 'mem',
    threshold: number,
    durationSec: number,
  ): boolean {
    const sampleSec = this.sampleSec;
    const expected = Math.ceil(durationSec / sampleSec);
    const required = Math.max(1, expected - 1);

    const sinceMs = this.now() - durationSec * 1000;
    const window = this.getSeries(name, sinceMs);

    if (window.length < required) return false;

    // Reject real holes in the window (not just boundary rounding).
    for (let i = 1; i < window.length; i++) {
      const gapMs = window[i].ts - window[i - 1].ts;
      if (gapMs > 2 * sampleSec * 1000) return false;
    }

    return window.every((s) => s[metric] > threshold);
  }
}
