/**
 * Pure PM2 mapping helpers. No I/O, no import of the `pm2` package — fully
 * unit-testable with recorded `pm2.list` fixtures.
 *
 * - `mapProcess(raw)` turns one raw pm2 `ProcessDescription` into a
 *   `ProcessSnapshot`. For a name shared by several instances the caller feeds
 *   each raw record through `aggregateList`, which collapses them into the
 *   per-NAME aggregate the design mandates (instances = instance count,
 *   cpu/memory summed, pmId/pid = primary instance).
 * - Bus-packet normalizers resolve the lifecycle event / process / exception
 *   payload across the two historically observed layouts (flat vs nested under
 *   `data`) — the "field-path defense" from the design.
 */

import type { Logger } from '../core/logger.js';
import type { ProcessSnapshot, ProcStatus } from '../core/types.js';

/**
 * The raw record shape returned by `pm2.list` / `pm2.describe`. We model it
 * locally (rather than leaning on the `pm2` package's `ProcessDescription`)
 * because the installed typings omit several runtime fields (`exec_mode`,
 * `kill_timeout`, …) that live on `pm2_env`, and the mapper must read them
 * defensively regardless of the typing version.
 */
export interface RawPm2Env {
  status?: string;
  pm_uptime?: number;
  restart_time?: number;
  unstable_restarts?: number;
  instances?: number | 'max';
  exec_mode?: string;
  pm_exec_path?: string;
  pm_out_log_path?: string;
  pm_err_log_path?: string;
  kill_timeout?: number;
  [key: string]: unknown;
}

export interface RawPm2Monit {
  memory?: number;
  cpu?: number;
}

export interface RawProcess {
  name?: string;
  pid?: number;
  pm_id?: number;
  monit?: RawPm2Monit;
  pm2_env?: RawPm2Env;
  [key: string]: unknown;
}

const KNOWN_STATUSES: ReadonlySet<ProcStatus> = new Set<ProcStatus>([
  'online',
  'stopping',
  'stopped',
  'launching',
  'errored',
  'one-launch-status',
  'unknown',
]);

/** Coerces a raw pm2 status string into the typed `ProcStatus`. */
export function toProcStatus(raw: unknown): ProcStatus {
  if (typeof raw === 'string' && KNOWN_STATUSES.has(raw as ProcStatus)) {
    return raw as ProcStatus;
  }
  return 'unknown';
}

function toMode(raw: unknown): 'fork' | 'cluster' {
  // pm2 reports 'cluster_mode' / 'fork_mode' (or occasionally 'cluster'/'fork').
  return typeof raw === 'string' && raw.startsWith('cluster') ? 'cluster' : 'fork';
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Maps a single raw pm2 record to a `ProcessSnapshot`. The `instances` field is
 * taken from `pm2_env.instances` when present (clamped to >= 1); callers that
 * fold multiple records for one name should use {@link aggregateList} instead,
 * which overrides `instances` with the real per-name record count.
 */
export function mapProcess(raw: RawProcess, now: number = Date.now()): ProcessSnapshot {
  const env = raw.pm2_env ?? {};
  const monit = raw.monit ?? {};
  const status = toProcStatus(env.status);
  const uptime = env.pm_uptime;
  const uptimeMs =
    status === 'online' && typeof uptime === 'number' && Number.isFinite(uptime)
      ? Math.max(0, now - uptime)
      : null;
  const rawInstances = env.instances;
  const instances =
    typeof rawInstances === 'number' && Number.isFinite(rawInstances)
      ? Math.max(1, rawInstances)
      : 1;

  return {
    pmId: num(raw.pm_id, -1),
    name: typeof raw.name === 'string' ? raw.name : 'unknown',
    pid: typeof raw.pid === 'number' && raw.pid > 0 ? raw.pid : null,
    status,
    cpu: num(monit.cpu),
    memory: num(monit.memory),
    uptimeMs,
    restarts: num(env.restart_time),
    unstableRestarts: num(env.unstable_restarts),
    mode: toMode(env.exec_mode),
    instances,
    execPath: typeof env.pm_exec_path === 'string' ? env.pm_exec_path : null,
    lastUpdated: now,
  };
}

/**
 * Collapses a raw `pm2.list` into the per-NAME aggregate list. All records with
 * the same `name` fold into one `ProcessSnapshot`: `instances` is the record
 * count, `cpu`/`memory` are summed across instances, `pmId`/`pid`/other fields
 * come from the primary (first-seen, i.e. lowest `pm_id`) instance, and
 * `status` is the primary's. A name shared by instances with differing `pm_id`
 * sets triggers a one-time `warn` (operators are expected to use unique names).
 */
export function aggregateList(list: RawProcess[], logger?: Logger, now: number = Date.now()): ProcessSnapshot[] {
  const groups = new Map<string, RawProcess[]>();
  for (const raw of list) {
    const name = typeof raw.name === 'string' ? raw.name : 'unknown';
    const group = groups.get(name);
    if (group) {
      group.push(raw);
    } else {
      groups.set(name, [raw]);
    }
  }

  const out: ProcessSnapshot[] = [];
  for (const [name, records] of groups) {
    // Primary instance = lowest pm_id (stable, deterministic ordering).
    const ordered = [...records].sort(
      (a, b) => num(a.pm_id, Number.MAX_SAFE_INTEGER) - num(b.pm_id, Number.MAX_SAFE_INTEGER),
    );
    const primary = mapProcess(ordered[0], now);
    let cpu = 0;
    let memory = 0;
    for (const rec of ordered) {
      cpu += num(rec.monit?.cpu);
      memory += num(rec.monit?.memory);
    }
    const snapshot: ProcessSnapshot = {
      ...primary,
      instances: records.length,
      cpu,
      memory,
    };
    if (records.length > 1 && logger) {
      const pmIds = ordered.map((r) => num(r.pm_id, -1));
      logger.warnOnce(`name-collision:${name}`, 'duplicate pm2 process name collapsed to one aggregate', {
        name,
        pmIds,
      });
    }
    out.push(snapshot);
  }
  return out;
}

// --- Bus-packet normalizers (field-path defense) ---

/** A lifecycle event name as emitted on the `process:event` channel. */
export type Pm2LifecycleEvent =
  | 'online'
  | 'start'
  | 'stop'
  | 'restart'
  | 'exit'
  | 'delete'
  | 'restart overlimit';

export interface NormalizedProc {
  name: string;
  pmId: number;
}

/**
 * Resolves the lifecycle event name from a `process:event` packet, tolerating
 * both the flat (`packet.event`) and nested (`packet.data.event`) layouts.
 */
export function normalizeEventName(packet: unknown): string | null {
  if (!packet || typeof packet !== 'object') return null;
  const p = packet as { event?: unknown; data?: { event?: unknown } };
  const ev = p.event ?? p.data?.event;
  return typeof ev === 'string' ? ev : null;
}

/**
 * Resolves the process block from a bus packet, tolerating the flat
 * (`packet.process`) and nested (`packet.data.process`) layouts. Returns `null`
 * when neither a name nor a usable identity is present.
 */
export function normalizeProc(packet: unknown): NormalizedProc | null {
  if (!packet || typeof packet !== 'object') return null;
  const p = packet as { process?: unknown; data?: { process?: unknown } };
  const procRaw = (p.process ?? p.data?.process) as
    | { name?: unknown; pm_id?: unknown }
    | undefined;
  if (!procRaw || typeof procRaw !== 'object') return null;
  const name = typeof procRaw.name === 'string' ? procRaw.name : null;
  if (name === null) return null;
  return {
    name,
    pmId: typeof procRaw.pm_id === 'number' ? procRaw.pm_id : -1,
  };
}

/**
 * Normalizes a `process:exception` packet's `data` to a `{ message, stack }`
 * pair, reading `data.stack ?? data.message ?? String(data)` per the design.
 */
export function normalizeException(data: unknown): { message: string; stack: string } {
  if (data && typeof data === 'object') {
    const d = data as { message?: unknown; stack?: unknown };
    const stack = typeof d.stack === 'string' ? d.stack : undefined;
    const message = typeof d.message === 'string' ? d.message : undefined;
    const text = stack ?? message ?? JSON.stringify(data);
    return { message: message ?? (stack ? stack.split('\n')[0] : text), stack: text };
  }
  const text = String(data);
  return { message: text, stack: text };
}
