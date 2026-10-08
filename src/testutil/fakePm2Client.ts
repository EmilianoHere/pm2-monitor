/**
 * A fake Pm2Client for API/WS integration tests. It implements the public
 * Pm2Client surface (connection flag, list/describe, control/startNew,
 * readLogsTail) with configurable canned results, so the server/hub can be
 * exercised against a real app without a pm2 daemon.
 */

import type { ControlAction, ControlResult, LogTailOpts, StartNewOpts } from '../pm2/client.js';
import type { LogLine, ProcessSnapshot } from '../core/types.js';

export interface FakePm2Options {
  connected?: boolean;
  processes?: ProcessSnapshot[];
  /** canned control result (defaults to ok with the matching snapshot). */
  controlResult?: ControlResult;
  /** canned startNew result. */
  startNewResult?: ControlResult;
  /** canned log lines for readLogsTail. */
  logs?: LogLine[];
}

export function makeSnapshot(partial: Partial<ProcessSnapshot> & { name: string }): ProcessSnapshot {
  return {
    pmId: 0,
    pid: 1234,
    status: 'online',
    cpu: 0,
    memory: 0,
    uptimeMs: 1000,
    restarts: 0,
    unstableRestarts: 0,
    mode: 'fork',
    instances: 1,
    execPath: '/tmp/app.js',
    lastUpdated: 0,
    ...partial,
  };
}

export class FakePm2Client {
  connected: boolean;
  processes: ProcessSnapshot[];
  controlResult: ControlResult | undefined;
  startNewResult: ControlResult | undefined;
  logs: LogLine[];

  /** records each control call for assertions. */
  readonly controlCalls: Array<{ action: ControlAction; name: string }> = [];
  readonly startNewCalls: StartNewOpts[] = [];

  constructor(options: FakePm2Options = {}) {
    this.connected = options.connected ?? true;
    this.processes = options.processes ?? [];
    this.controlResult = options.controlResult;
    this.startNewResult = options.startNewResult;
    this.logs = options.logs ?? [];
  }

  isConnected(): boolean {
    return this.connected;
  }

  start(): void {
    /* no-op; connection flag is set directly in tests */
  }

  async stop(): Promise<void> {
    this.connected = false;
  }

  async list(): Promise<ProcessSnapshot[]> {
    return this.processes;
  }

  async describe(name: string): Promise<ProcessSnapshot | null> {
    return this.processes.find((p) => p.name === name) ?? null;
  }

  async control(action: ControlAction, name: string): Promise<ControlResult> {
    this.controlCalls.push({ action, name });
    if (!this.connected) {
      return { ok: false, code: 'PM2_UNAVAILABLE', message: 'PM2 daemon is not connected' };
    }
    if (this.controlResult) return this.controlResult;
    const proc = this.processes.find((p) => p.name === name);
    if (proc) return { ok: true, process: proc };
    return { ok: false, code: 'PM2_ERROR', message: `unknown process: ${name}` };
  }

  async startNew(opts: StartNewOpts): Promise<ControlResult> {
    this.startNewCalls.push(opts);
    if (!this.connected) {
      return { ok: false, code: 'PM2_UNAVAILABLE', message: 'PM2 daemon is not connected' };
    }
    if (this.startNewResult) return this.startNewResult;
    return { ok: true, process: makeSnapshot({ name: opts.name ?? 'new-process' }) };
  }

  async readLogsTail(_name: string, _lines: number, _opts?: LogTailOpts): Promise<LogLine[]> {
    return this.logs;
  }
}
