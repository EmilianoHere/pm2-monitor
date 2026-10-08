/**
 * Typed event emitter shared across modules. No module calls another module's
 * internals directly — they communicate through the MonitorState hub plus this
 * typed emitter.
 */

import { EventEmitter } from 'node:events';
import type { ProcessSnapshot, ProcStatus, MonitorSnapshot, TrackedError } from './types.js';

export interface ProcessTransitionEvent {
  name: string;
  from: ProcStatus;
  to: ProcStatus;
  at: number;
}

export interface LogLineEvent {
  process: string;
  stream: 'out' | 'err';
  level: 'info' | 'error';
  line: string;
  ts: number;
}

export interface AlertEvent {
  payload: unknown;
  delivered: boolean;
}

/** The payload type carried by each event name. */
export interface MonitorEventMap {
  'state:update': [MonitorSnapshot];
  'process:transition': [ProcessTransitionEvent];
  'pm2:connected': [];
  'pm2:disconnected': [];
  'metrics:tick': [ProcessSnapshot[]];
  'error:captured': [TrackedError];
  'log:line': [LogLineEvent];
  alert: [AlertEvent];
}

type EventName = keyof MonitorEventMap;

/**
 * A strongly-typed EventEmitter. Listeners and emits are checked against
 * {@link MonitorEventMap}.
 */
export class MonitorEvents {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Alert storms during restart loops can attach many short-lived listeners;
    // raise the ceiling so Node does not warn about a leak.
    this.emitter.setMaxListeners(100);
  }

  on<E extends EventName>(event: E, listener: (...args: MonitorEventMap[E]) => void): this {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  off<E extends EventName>(event: E, listener: (...args: MonitorEventMap[E]) => void): this {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
    return this;
  }

  once<E extends EventName>(event: E, listener: (...args: MonitorEventMap[E]) => void): this {
    this.emitter.once(event, listener as (...args: unknown[]) => void);
    return this;
  }

  emit<E extends EventName>(event: E, ...args: MonitorEventMap[E]): boolean {
    return this.emitter.emit(event, ...args);
  }

  removeAllListeners(event?: EventName): this {
    this.emitter.removeAllListeners(event);
    return this;
  }
}
