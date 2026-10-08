/**
 * AlertEngine: evaluates the loaded alert rules against live events and sampled
 * metrics, gates each match through the cooldown tracker and maintenance mode,
 * and dispatches to the targeted channels with `Promise.allSettled` so one
 * channel failure never throws or blocks the other.
 *
 * Evaluation is split exactly as the design specifies:
 *  - event-driven: `errored`, `unexpected-stop`, `restart-threshold`, `error-spike`
 *  - sampled (on `metrics:tick`): `cpu-threshold`, `mem-threshold`
 *
 * The engine subscribes to `metrics:tick` AFTER `MonitorState`, so by the time
 * it evaluates a tick the samples for that tick are already pushed.
 */

import type { MonitorEvents, ProcessTransitionEvent } from '../core/events.js';
import type { ProcessSnapshot, ProcStatus, TrackedError } from '../core/types.js';
import { createLogger, type Logger } from '../core/logger.js';
import type { AlertRule } from '../config/alertRules.js';
import { CooldownTracker } from './cooldown.js';
import type { AlertChannel, AlertPayload, AlertSeverity } from './channels/types.js';

/**
 * The marker message the Pm2Client emits for an exit with no intentional-action
 * token consumed. `unexpected-stop` keys off this so it stays disjoint from
 * `errored` (a `restart overlimit` crash) and from a `process:exception` crash.
 */
const UNEXPECTED_EXIT_MESSAGE = 'process exited unexpectedly';

/** The narrow state-hub surface the engine reads. A fake satisfies this in tests. */
export interface AlertStateHub {
  getMaintenance(): { active: boolean };
  getProcess(name: string): ProcessSnapshot | null;
  /** names currently present in the hub (sampled-rule evaluation targets). */
  processNames(): string[];
  /** sustained-threshold primitive; delegates to the hub-owned MetricsStore. */
  sustainedAbove(
    name: string,
    metric: 'cpu' | 'mem',
    threshold: number,
    durationSec: number,
  ): boolean;
}

/** The error-tracker windows the engine consults for threshold conditions. */
export interface AlertErrorWindows {
  countInWindow(name: string, sinceSec: number): number;
  restartsInWindow(name: string, sinceSec: number): number;
  setMaxWindow(sec: number): void;
}

export interface RecentAlert {
  payload: AlertPayload;
  delivered: boolean;
}

export interface AlertEngineOptions {
  rules: AlertRule[];
  state: AlertStateHub;
  events: MonitorEvents;
  errors: AlertErrorWindows;
  channels: AlertChannel[];
  /** DEFAULT_COOLDOWN_SEC fallback for rules without their own cooldownSec. */
  defaultCooldownSec: number;
  logger?: Logger;
  cooldown?: CooldownTracker;
  now?: () => number;
  /** cap on the recent-alerts list (default 200). */
  recentLimit?: number;
}

const MIN_WINDOW_SEC = 60;

const SEVERITY_TO_PAYLOAD: Record<AlertRule['severity'], AlertSeverity> = {
  info: 'info',
  warning: 'warning',
  critical: 'critical',
};

export class AlertEngine {
  private rules: AlertRule[];
  private readonly state: AlertStateHub;
  private readonly events: MonitorEvents;
  private readonly errors: AlertErrorWindows;
  private readonly channels: AlertChannel[];
  private readonly defaultCooldownSec: number;
  private readonly logger: Logger;
  private readonly cooldown: CooldownTracker;
  private readonly now: () => number;
  private readonly recentLimit: number;
  private readonly recent: RecentAlert[] = [];

  private readonly onTransition = (e: ProcessTransitionEvent): void => this.handleTransition(e);
  private readonly onError = (e: TrackedError): void => this.handleError(e);
  private readonly onTick = (list: ProcessSnapshot[]): void => this.handleTick(list);

  constructor(options: AlertEngineOptions) {
    this.rules = options.rules;
    this.state = options.state;
    this.events = options.events;
    this.errors = options.errors;
    this.channels = options.channels;
    this.defaultCooldownSec = Math.max(0, options.defaultCooldownSec);
    this.logger = options.logger ?? createLogger();
    this.now = options.now ?? (() => Date.now());
    this.cooldown = options.cooldown ?? new CooldownTracker({ now: this.now });
    this.recentLimit = Math.max(1, options.recentLimit ?? 200);

    this.events.on('process:transition', this.onTransition);
    this.events.on('error:captured', this.onError);
    // Subscribed AFTER MonitorState so this tick's samples are already pushed.
    this.events.on('metrics:tick', this.onTick);

    this.applyMaxWindow();
  }

  /** Detaches every event listener. */
  stop(): void {
    this.events.off('process:transition', this.onTransition);
    this.events.off('error:captured', this.onError);
    this.events.off('metrics:tick', this.onTick);
  }

  /** Replaces the rule set and recomputes the error-tracker max window. */
  reload(rules: AlertRule[]): void {
    this.rules = rules;
    this.applyMaxWindow();
  }

  /** Recent dispatched/suppressed alerts, most-recent last. */
  recentAlerts(limit = this.recentLimit): RecentAlert[] {
    if (limit >= this.recent.length) return [...this.recent];
    return this.recent.slice(this.recent.length - limit);
  }

  /** Sends a probe alert to one channel (POST /api/alerts/test). Rejects on failure. */
  async test(channel: 'teams' | 'email'): Promise<void> {
    const target = this.channels.find((c) => c.name === channel);
    if (!target) throw new Error(`channel ${channel} is not configured`);
    const now = this.now();
    await target.send({
      title: 'PM2 monitor test alert',
      severity: 'info',
      processName: '(test)',
      ruleId: '(test)',
      summary: `Test alert for the ${channel} channel.`,
      facts: [{ k: 'Channel', v: channel }],
      timestamp: now,
      suppressedCount: 0,
    });
  }

  // --- window recomputation ---

  private applyMaxWindow(): void {
    let maxSec = MIN_WINDOW_SEC;
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      const c = rule.match.condition;
      if (c.type === 'error-spike') maxSec = Math.max(maxSec, c.withinSec);
      if (c.type === 'restart-threshold') maxSec = Math.max(maxSec, c.withinMin * 60);
    }
    this.errors.setMaxWindow(maxSec);
  }

  // --- event-driven evaluation ---

  private handleTransition(e: ProcessTransitionEvent): void {
    if (e.to === 'errored') {
      this.evaluateFor('errored', e.name, (c) => c.type === 'errored', (rule) =>
        this.buildPayload(rule, e.name, `${e.name} entered the errored state`, [
          { k: 'From', v: e.from },
          { k: 'To', v: e.to },
        ]),
      );
    }
  }

  private handleError(e: TrackedError): void {
    const name = e.processName;
    // unexpected-stop: an exit with no intentional-action token consumed.
    if (e.level === 'crash' && e.message === UNEXPECTED_EXIT_MESSAGE) {
      this.evaluateFor('unexpected-stop', name, (c) => c.type === 'unexpected-stop', (rule) =>
        this.buildPayload(rule, name, `${name} stopped unexpectedly`, [{ k: 'Event', v: 'exit' }]),
      );
    }

    // restart-threshold: crash-loop restarts only (intentional === false).
    if (e.level === 'restart' && e.intentional === false) {
      this.evaluateFor(
        'restart-threshold',
        name,
        (c) => c.type === 'restart-threshold',
        (rule) => {
          const c = rule.match.condition;
          if (c.type !== 'restart-threshold') return null;
          const count = this.errors.restartsInWindow(name, c.withinMin * 60);
          if (count < c.count) return null;
          return this.buildPayload(
            rule,
            name,
            `${name} restarted ${count} time(s) within ${c.withinMin} min`,
            [
              { k: 'Restarts', v: String(count) },
              { k: 'Threshold', v: String(c.count) },
              { k: 'WithinMin', v: String(c.withinMin) },
            ],
          );
        },
      );
    }

    // error-spike: N error-level captures within the window.
    if (e.level === 'error') {
      this.evaluateFor(
        'error-spike',
        name,
        (c) => c.type === 'error-spike',
        (rule) => {
          const c = rule.match.condition;
          if (c.type !== 'error-spike') return null;
          const count = this.errors.countInWindow(name, c.withinSec);
          if (count < c.count) return null;
          return this.buildPayload(
            rule,
            name,
            `${name} logged ${count} error(s) within ${c.withinSec}s`,
            [
              { k: 'Errors', v: String(count) },
              { k: 'Threshold', v: String(c.count) },
              { k: 'WithinSec', v: String(c.withinSec) },
            ],
          );
        },
      );
    }
  }

  // --- sampled evaluation (one pass per metrics:tick) ---

  private handleTick(list: ProcessSnapshot[]): void {
    const present = new Set(list.map((p) => p.name));
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      const c = rule.match.condition;
      if (c.type !== 'cpu-threshold' && c.type !== 'mem-threshold') continue;

      for (const name of this.targetNames(rule, [...present])) {
        if (!present.has(name)) continue;
        let matched = false;
        let payload: AlertPayload | null = null;
        if (c.type === 'cpu-threshold') {
          matched = this.state.sustainedAbove(name, 'cpu', c.percent, c.forSec);
          if (matched) {
            payload = this.buildPayload(
              rule,
              name,
              `${name} CPU above ${c.percent}% for ${c.forSec}s`,
              [
                { k: 'Metric', v: 'cpu' },
                { k: 'Threshold', v: `${c.percent}%` },
                { k: 'ForSec', v: String(c.forSec) },
              ],
            );
          }
        } else {
          matched = this.state.sustainedAbove(name, 'mem', c.bytes, c.forSec);
          if (matched) {
            payload = this.buildPayload(
              rule,
              name,
              `${name} memory above ${c.bytes} bytes for ${c.forSec}s`,
              [
                { k: 'Metric', v: 'mem' },
                { k: 'Threshold', v: `${c.bytes}` },
                { k: 'ForSec', v: String(c.forSec) },
              ],
            );
          }
        }
        if (matched && payload) {
          void this.fire(rule, name, payload);
        }
      }
    }
  }

  // --- shared evaluation path ---

  private evaluateFor(
    conditionType: AlertRule['match']['condition']['type'],
    name: string,
    predicate: (c: AlertRule['match']['condition']) => boolean,
    build: (rule: AlertRule) => AlertPayload | null,
  ): void {
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      if (rule.match.condition.type !== conditionType) continue;
      if (!predicate(rule.match.condition)) continue;
      if (!this.ruleTargets(rule, name)) continue;
      const payload = build(rule);
      if (payload) void this.fire(rule, name, payload);
    }
  }

  private targetNames(rule: AlertRule, present: string[]): string[] {
    if (rule.match.processes.includes('*')) return present;
    return rule.match.processes;
  }

  private ruleTargets(rule: AlertRule, name: string): boolean {
    return rule.match.processes.includes('*') || rule.match.processes.includes(name);
  }

  private buildPayload(
    rule: AlertRule,
    name: string,
    summary: string,
    facts: Array<{ k: string; v: string }>,
  ): AlertPayload {
    return {
      title: rule.description ?? `${rule.id}: ${name}`,
      severity: SEVERITY_TO_PAYLOAD[rule.severity],
      processName: name,
      ruleId: rule.id,
      summary,
      facts,
      timestamp: this.now(),
      suppressedCount: 0,
    };
  }

  // --- cooldown + maintenance gate + dispatch ---

  private async fire(rule: AlertRule, name: string, payload: AlertPayload): Promise<void> {
    const cooldownSec = rule.cooldownSec ?? this.defaultCooldownSec;
    const decision = this.cooldown.allow(rule.id, name, cooldownSec);
    if (!decision.allowed) {
      return; // suppressed; the rollup rides the next allowed alert
    }
    payload.suppressedCount = decision.suppressedCount;

    // Maintenance gate: record + WS broadcast with delivered:false, no channel.
    if (this.state.getMaintenance().active) {
      this.record(payload, false);
      this.events.emit('alert', { payload, delivered: false });
      this.logger.info('alert suppressed by maintenance mode', {
        ruleId: rule.id,
        process: name,
      });
      return;
    }

    this.record(payload, true);
    this.events.emit('alert', { payload, delivered: true });
    await this.dispatch(rule, payload);
  }

  /** Dispatches to the rule's targeted channels; one failure never blocks the other. */
  private async dispatch(rule: AlertRule, payload: AlertPayload): Promise<void> {
    const targets = this.channels.filter((c) => this.channelEnabledForRule(rule, c));
    if (targets.length === 0) return;
    const results = await Promise.allSettled(targets.map((c) => c.send(payload)));
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        this.logger.warn('alert channel delivery failed', {
          channel: targets[i].name,
          ruleId: rule.id,
          process: payload.processName,
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        });
      }
    });
  }

  private channelEnabledForRule(rule: AlertRule, channel: AlertChannel): boolean {
    const toggled = channel.name === 'teams' ? rule.channels.teams : rule.channels.email;
    if (toggled !== true) return false;
    if (!channel.enabled) {
      this.logger.warnOnce(
        `channel-unconfigured:${rule.id}:${channel.name}`,
        'rule targets a channel that is not configured; skipping it for this rule',
        { ruleId: rule.id, channel: channel.name },
      );
      return false;
    }
    return true;
  }

  private record(payload: AlertPayload, delivered: boolean): void {
    this.recent.push({ payload, delivered });
    while (this.recent.length > this.recentLimit) this.recent.shift();
  }
}

/** Narrows a ProcStatus to the engine's errored check (exported for reuse/tests). */
export function isErroredStatus(status: ProcStatus): boolean {
  return status === 'errored';
}
