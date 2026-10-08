/**
 * Shared data-model types for the monitor. These mirror the design "Core data
 * model" section exactly and are imported by every subsystem.
 */

export type ProcStatus =
  | 'online'
  | 'stopping'
  | 'stopped'
  | 'launching'
  | 'errored'
  | 'one-launch-status'
  | 'unknown';

export interface ProcessSnapshot {
  /** pm_id */
  pmId: number;
  name: string;
  pid: number | null;
  status: ProcStatus;
  /** percent */
  cpu: number;
  /** bytes */
  memory: number;
  /** now - pm_uptime */
  uptimeMs: number | null;
  /** restart_time */
  restarts: number;
  /** unstable_restarts */
  unstableRestarts: number;
  mode: 'fork' | 'cluster';
  instances: number;
  execPath: string | null;
  /** epoch ms of last refresh */
  lastUpdated: number;
}

export interface MetricSample {
  ts: number;
  cpu: number;
  mem: number;
}

/**
 * A single physical log line. Levels mirror the live-tail model exactly:
 * out => info, err => error (no other level).
 */
export interface LogLine {
  stream: 'out' | 'err';
  /** derived from stream: out => info, err => error */
  level: 'info' | 'error';
  /** the raw log text, one physical line */
  line: string;
  /** embedded/estimated timestamp; falls back to read order */
  ts: number;
}

export interface TrackedError {
  /** dedup key */
  signature: string;
  processName: string;
  firstSeen: number;
  lastSeen: number;
  /** total occurrences for this signature */
  count: number;
  level: 'error' | 'crash' | 'restart';
  /**
   * Only meaningful for level 'restart': true = operator-initiated (token
   * consumed); false/undefined = crash-loop restart. The restart-window counter
   * counts only intentional === false.
   */
  intentional?: boolean;
  /** first line / summary */
  message: string;
  /** trimmed representative stack/text */
  sample: string;
}

export interface MonitorSnapshot {
  processes: ProcessSnapshot[];
  pm2Connected: boolean;
  maintenance: boolean;
  generatedAt: number;
}
