/**
 * LogForwarder: on-demand live-log bridge. It holds the set of
 * (process -> subscribed streams) the server asked for and forwards matching
 * live `log:line` MonitorEvents as `log:line` frames. This mirrors
 * `WsHub.fanOutLog` filtering exactly — it does NOT re-tail files; it filters
 * the same live event stream the standalone hub already consumes (AC-20/21).
 */

import type { MonitorEvents, LogLineEvent } from '../core/events.js';
import type { ProtocolMessage } from '../protocol/messages.js';

export interface LogForwarderOptions {
  events: MonitorEvents;
  /** sends an outbound frame (typically AgentConnection.send). */
  send: (msg: ProtocolMessage) => void;
}

export class LogForwarder {
  private readonly events: MonitorEvents;
  private readonly send: (msg: ProtocolMessage) => void;
  /** process name -> subscribed streams. */
  private readonly subs = new Map<string, Set<'out' | 'err'>>();

  private readonly onLogLine = (e: LogLineEvent): void => this.forward(e);

  constructor(opts: LogForwarderOptions) {
    this.events = opts.events;
    this.send = opts.send;
    this.events.on('log:line', this.onLogLine);
  }

  /** Adds (or replaces) the stream filter for a process. */
  subscribe(process: string, streams: Array<'out' | 'err'>): void {
    const set = new Set<'out' | 'err'>(streams.length > 0 ? streams : ['out', 'err']);
    this.subs.set(process, set);
  }

  /** Drops the filter for a process (stops forwarding its lines). */
  unsubscribe(process: string): void {
    this.subs.delete(process);
  }

  /** Clears every subscription (e.g. on disconnect). */
  clear(): void {
    this.subs.clear();
  }

  /** Detaches the event listener and clears state. */
  stop(): void {
    this.events.off('log:line', this.onLogLine);
    this.subs.clear();
  }

  private forward(e: LogLineEvent): void {
    const streams = this.subs.get(e.process);
    if (streams === undefined || !streams.has(e.stream)) return;
    this.send({
      type: 'log:line',
      process: e.process,
      stream: e.stream,
      level: e.level,
      line: e.line,
      ts: e.ts,
    });
  }
}
