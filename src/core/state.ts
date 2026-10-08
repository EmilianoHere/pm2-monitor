/**
 * MonitorState: the central in-memory hub. Owns the name-keyed process map, the
 * MetricsStore and ErrorTracker, the pm2 connectivity flag, and maintenance
 * state. All cross-module reads/writes go through here plus the typed
 * MonitorEvents emitter — no module reaches into another's internals.
 */

import type { MonitorEvents } from './events.js';
import type { MetricSample, MonitorSnapshot, ProcessSnapshot, ProcStatus } from './types.js';
import type { MetricsStore } from '../metrics/store.js';
import type { ErrorTracker } from '../errors/tracker.js';

export interface MaintenanceState {
  active: boolean;
  until?: number;
  reason?: string;
}

export interface SetMaintenanceInput {
  active: boolean;
  durationMin?: number;
  reason?: string;
}

export interface MonitorStateOptions {
  events: MonitorEvents;
  metrics: MetricsStore;
  errors: ErrorTracker;
  /** injectable clock returning epoch ms */
  now?: () => number;
}

export class MonitorState {
  private readonly events: MonitorEvents;
  private readonly metrics: MetricsStore;
  private readonly errors: ErrorTracker;
  private readonly now: () => number;
  private readonly processes = new Map<string, ProcessSnapshot>();
  private pm2Connected = false;
  private maintenanceState: MaintenanceState = { active: false };

  private readonly onTick = (list: ProcessSnapshot[]): void => this.onMetricsTick(list);

  constructor(options: MonitorStateOptions) {
    this.events = options.events;
    this.metrics = options.metrics;
    this.errors = options.errors;
    this.now = options.now ?? (() => Date.now());
    this.events.on('metrics:tick', this.onTick);
  }

  /** Detaches event listeners. */
  stop(): void {
    this.events.off('metrics:tick', this.onTick);
  }

  // --- reads ---

  snapshot(): MonitorSnapshot {
    return {
      processes: [...this.processes.values()],
      pm2Connected: this.pm2Connected,
      maintenance: this.isMaintenanceActive(),
      generatedAt: this.now(),
    };
  }

  getProcess(name: string): ProcessSnapshot | null {
    return this.processes.get(name) ?? null;
  }

  /** The only public per-process series read; delegates to the owned store. */
  getMetrics(name: string, sinceMs: number): MetricSample[] {
    return this.metrics.getSeries(name, sinceMs);
  }

  isConnected(): boolean {
    return this.pm2Connected;
  }

  getMaintenance(): MaintenanceState {
    // Lazy expiry on read.
    if (this.maintenanceState.active && this.maintenanceState.until !== undefined) {
      if (this.now() >= this.maintenanceState.until) {
        this.maintenanceState = { active: false };
      }
    }
    return { ...this.maintenanceState };
  }

  private isMaintenanceActive(): boolean {
    return this.getMaintenance().active;
  }

  // --- mutations ---

  /** Replaces the process map from a fresh pm2 list, emitting transitions. */
  applyPm2List(list: ProcessSnapshot[]): void {
    const seen = new Set<string>();
    for (const next of list) {
      seen.add(next.name);
      const prev = this.processes.get(next.name);
      this.processes.set(next.name, next);
      if (prev && prev.status !== next.status) {
        this.events.emit('process:transition', {
          name: next.name,
          from: prev.status,
          to: next.status,
          at: this.now(),
        });
      }
    }
    // Processes no longer present are treated as deleted.
    for (const name of [...this.processes.keys()]) {
      if (!seen.has(name)) {
        this.processes.delete(name);
      }
    }
    this.events.emit('state:update', this.snapshot());
  }

  setConnected(connected: boolean): void {
    if (this.pm2Connected === connected) return;
    this.pm2Connected = connected;
    if (connected) {
      this.events.emit('pm2:connected');
    } else {
      this.events.emit('pm2:disconnected');
    }
    this.events.emit('state:update', this.snapshot());
  }

  setMaintenance(input: SetMaintenanceInput): MaintenanceState {
    if (input.active) {
      const until =
        input.durationMin !== undefined ? this.now() + input.durationMin * 60 * 1000 : undefined;
      this.maintenanceState = {
        active: true,
        ...(until !== undefined ? { until } : {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      };
    } else {
      this.maintenanceState = { active: false };
    }
    this.events.emit('state:update', this.snapshot());
    return { ...this.maintenanceState };
  }

  // --- metrics:tick consumer ---

  private onMetricsTick(list: ProcessSnapshot[]): void {
    const liveNames = new Set<string>();
    for (const snap of list) {
      liveNames.add(snap.name);
      // Only online processes contribute a sample; a dead process must not have
      // its absence read as sustained-zero.
      if (snap.status === 'online') {
        const metricSample: MetricSample = {
          ts: snap.lastUpdated,
          cpu: snap.cpu,
          mem: snap.memory,
        };
        this.metrics.push(snap.name, metricSample);
      }
    }
    // Prune series for names no longer present so deleted processes do not leak.
    for (const name of this.metrics.names()) {
      if (!liveNames.has(name)) {
        this.metrics.drop(name);
      }
    }
  }

  /** Exposed for callers that need the transition status enum. */
  static readonly STATUSES: readonly ProcStatus[] = [
    'online',
    'stopping',
    'stopped',
    'launching',
    'errored',
    'one-launch-status',
    'unknown',
  ];
}
