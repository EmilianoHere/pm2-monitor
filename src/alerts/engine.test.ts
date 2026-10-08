import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MonitorEvents } from '../core/events.js';
import { createLogger } from '../core/logger.js';
import { CooldownTracker } from './cooldown.js';
import { AlertEngine, type AlertErrorWindows, type AlertStateHub } from './engine.js';
import type { AlertChannel, AlertPayload } from './channels/types.js';
import type { AlertRule } from '../config/alertRules.js';
import type { ProcessSnapshot, TrackedError } from '../core/types.js';

const silent = createLogger({ level: 'error', sink: () => {} });

// --- fakes ---

class FakeStateHub implements AlertStateHub {
  maintenanceActive = false;
  private procs = new Map<string, ProcessSnapshot>();
  sustained = new Map<string, boolean>();

  setProcess(name: string): void {
    this.procs.set(name, proc(name));
  }

  getMaintenance(): { active: boolean } {
    return { active: this.maintenanceActive };
  }

  getProcess(name: string): ProcessSnapshot | null {
    return this.procs.get(name) ?? null;
  }

  processNames(): string[] {
    return [...this.procs.keys()];
  }

  sustainedAbove(name: string, metric: 'cpu' | 'mem', _t: number, _d: number): boolean {
    return this.sustained.get(`${name}:${metric}`) ?? false;
  }
}

class FakeErrorWindows implements AlertErrorWindows {
  counts = new Map<string, number>();
  restarts = new Map<string, number>();
  maxWindowSec = 0;

  countInWindow(name: string): number {
    return this.counts.get(name) ?? 0;
  }

  restartsInWindow(name: string): number {
    return this.restarts.get(name) ?? 0;
  }

  setMaxWindow(sec: number): void {
    this.maxWindowSec = sec;
  }
}

class SpyChannel implements AlertChannel {
  readonly sent: AlertPayload[] = [];
  constructor(
    readonly name: 'teams' | 'email',
    readonly enabled = true,
    private readonly fail = false,
  ) {}

  async send(payload: AlertPayload): Promise<void> {
    if (this.fail) throw new Error(`${this.name} boom`);
    this.sent.push(payload);
  }
}

function proc(name: string, partial: Partial<ProcessSnapshot> = {}): ProcessSnapshot {
  return {
    pmId: 0,
    name,
    pid: 1,
    status: 'online',
    cpu: 1,
    memory: 1,
    uptimeMs: 1,
    restarts: 0,
    unstableRestarts: 0,
    mode: 'fork',
    instances: 1,
    execPath: '/x.js',
    lastUpdated: 0,
    ...partial,
  };
}

function rule(partial: Partial<AlertRule> & Pick<AlertRule, 'id' | 'match'>): AlertRule {
  return {
    enabled: true,
    severity: 'warning',
    channels: { teams: true, email: true },
    ...partial,
  } as AlertRule;
}

function tracked(partial: Partial<TrackedError> & Pick<TrackedError, 'processName' | 'level'>): TrackedError {
  return {
    signature: '',
    firstSeen: 0,
    lastSeen: 0,
    count: 1,
    message: '',
    sample: '',
    ...partial,
  };
}

interface Harness {
  events: MonitorEvents;
  state: FakeStateHub;
  errors: FakeErrorWindows;
  teams: SpyChannel;
  email: SpyChannel;
  engine: AlertEngine;
  now: { t: number };
}

function makeEngine(rules: AlertRule[], opts: { teamsFail?: boolean } = {}): Harness {
  const events = new MonitorEvents();
  const state = new FakeStateHub();
  const errors = new FakeErrorWindows();
  const teams = new SpyChannel('teams', true, opts.teamsFail ?? false);
  const email = new SpyChannel('email', true, false);
  const now = { t: 1000 };
  const engine = new AlertEngine({
    rules,
    state,
    events,
    errors,
    channels: [teams, email],
    defaultCooldownSec: 300,
    logger: silent,
    cooldown: new CooldownTracker({ now: () => now.t }),
    now: () => now.t,
  });
  return { events, state, errors, teams, email, engine, now };
}

/** Settle the engine's async allSettled dispatch. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// --- wiring tests ---

test('errored fires on a transition to errored and dispatches to both channels', async () => {
  const h = makeEngine([rule({ id: 'crash', match: { processes: ['*'], condition: { type: 'errored' } } })]);
  h.state.setProcess('api');
  h.events.emit('process:transition', { name: 'api', from: 'online', to: 'errored', at: 1000 });
  await flush();
  assert.equal(h.teams.sent.length, 1);
  assert.equal(h.email.sent.length, 1);
  assert.equal(h.teams.sent[0].ruleId, 'crash');
  assert.equal(h.teams.sent[0].processName, 'api');
});

test('restart-threshold fires only when restartsInWindow reaches the count', async () => {
  const h = makeEngine([
    rule({
      id: 'rt',
      match: { processes: ['*'], condition: { type: 'restart-threshold', count: 3, withinMin: 10 } },
    }),
  ]);
  // Below threshold -> no fire.
  h.errors.restarts.set('api', 2);
  h.events.emit('error:captured', tracked({ processName: 'api', level: 'restart', intentional: false }));
  await flush();
  assert.equal(h.teams.sent.length, 0);

  // At threshold -> fire.
  h.errors.restarts.set('api', 3);
  h.events.emit('error:captured', tracked({ processName: 'api', level: 'restart', intentional: false }));
  await flush();
  assert.equal(h.teams.sent.length, 1);
});

test('restart-threshold ignores operator (intentional) restarts', async () => {
  const h = makeEngine([
    rule({
      id: 'rt',
      match: { processes: ['*'], condition: { type: 'restart-threshold', count: 1, withinMin: 10 } },
    }),
  ]);
  h.errors.restarts.set('api', 5);
  h.events.emit('error:captured', tracked({ processName: 'api', level: 'restart', intentional: true }));
  await flush();
  assert.equal(h.teams.sent.length, 0);
});

test('error-spike fires when countInWindow reaches the count', async () => {
  const h = makeEngine([
    rule({
      id: 'spike',
      match: { processes: ['*'], condition: { type: 'error-spike', count: 10, withinSec: 60 } },
    }),
  ]);
  h.errors.counts.set('api', 10);
  h.events.emit('error:captured', tracked({ processName: 'api', level: 'error' }));
  await flush();
  assert.equal(h.email.sent.length, 1);
});

test('unexpected-stop fires on the exit crash marker but not on a generic crash', async () => {
  const h = makeEngine([
    rule({ id: 'stop', match: { processes: ['*'], condition: { type: 'unexpected-stop' } } }),
  ]);
  // A process:exception-style crash with a different message must NOT fire it.
  h.events.emit('error:captured', tracked({ processName: 'api', level: 'crash', message: 'kaboom' }));
  await flush();
  assert.equal(h.teams.sent.length, 0);

  // The unexpected-exit marker fires it.
  h.events.emit(
    'error:captured',
    tracked({ processName: 'api', level: 'crash', message: 'process exited unexpectedly' }),
  );
  await flush();
  assert.equal(h.teams.sent.length, 1);
});

test('cpu-threshold fires on a tick when sustainedAbove is true (and only for present processes)', async () => {
  const h = makeEngine([
    rule({
      id: 'cpu',
      match: { processes: ['*'], condition: { type: 'cpu-threshold', percent: 85, forSec: 120 } },
    }),
  ]);
  h.state.sustained.set('api:cpu', true);
  // A process absent from the tick must not be evaluated even if sustained says true.
  h.state.sustained.set('ghost:cpu', true);
  h.events.emit('metrics:tick', [proc('api', { cpu: 90 })]);
  await flush();
  assert.equal(h.teams.sent.length, 1);
  assert.equal(h.teams.sent[0].processName, 'api');
});

// --- cooldown + maintenance + isolation ---

test('cooldown suppresses repeats and the rollup rides the next allowed alert', async () => {
  const h = makeEngine([
    rule({
      id: 'crash',
      match: { processes: ['*'], condition: { type: 'errored' } },
      cooldownSec: 300,
    }),
  ]);
  const trip = (): void => {
    h.events.emit('process:transition', { name: 'api', from: 'online', to: 'errored', at: h.now.t });
  };
  trip();
  await flush();
  assert.equal(h.teams.sent.length, 1);
  assert.equal(h.teams.sent[0].suppressedCount, 0);

  // Within the cooldown -> suppressed.
  h.now.t += 60_000;
  trip();
  h.now.t += 60_000;
  trip();
  await flush();
  assert.equal(h.teams.sent.length, 1);

  // After the cooldown -> fires with the suppressed rollup.
  h.now.t = 1000 + 300_000;
  trip();
  await flush();
  assert.equal(h.teams.sent.length, 2);
  assert.equal(h.teams.sent[1].suppressedCount, 2);
});

test('maintenance mode records the alert with delivered:false and dispatches to no channel', async () => {
  const h = makeEngine([rule({ id: 'crash', match: { processes: ['*'], condition: { type: 'errored' } } })]);
  h.state.maintenanceActive = true;
  const broadcasts: Array<{ delivered: boolean }> = [];
  h.events.on('alert', (e) => broadcasts.push({ delivered: e.delivered }));

  h.events.emit('process:transition', { name: 'api', from: 'online', to: 'errored', at: h.now.t });
  await flush();

  assert.equal(h.teams.sent.length, 0);
  assert.equal(h.email.sent.length, 0);
  const recent = h.engine.recentAlerts();
  assert.equal(recent.length, 1);
  assert.equal(recent[0].delivered, false);
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].delivered, false);
});

test('allSettled isolation: a throwing channel does not block the other and does not throw', async () => {
  const h = makeEngine(
    [rule({ id: 'crash', match: { processes: ['*'], condition: { type: 'errored' } } })],
    { teamsFail: true },
  );
  h.events.emit('process:transition', { name: 'api', from: 'online', to: 'errored', at: h.now.t });
  await flush();
  // Teams threw; email still received the alert.
  assert.equal(h.teams.sent.length, 0);
  assert.equal(h.email.sent.length, 1);
  // The alert is still recorded as delivered.
  assert.equal(h.engine.recentAlerts()[0].delivered, true);
});

test('reload recomputes the error-tracker max window from the loaded rules', () => {
  const h = makeEngine([]);
  assert.equal(h.errors.maxWindowSec, 60); // floor from the empty initial set
  h.engine.reload([
    rule({
      id: 'rt',
      match: { processes: ['*'], condition: { type: 'restart-threshold', count: 2, withinMin: 10 } },
    }),
    rule({
      id: 'spike',
      match: { processes: ['*'], condition: { type: 'error-spike', count: 5, withinSec: 90 } },
    }),
  ]);
  // max(10*60, 90, 60) = 600
  assert.equal(h.errors.maxWindowSec, 600);
});

test('test(channel) sends a probe to the named channel and rejects for an unconfigured one', async () => {
  // Only the teams channel is configured here.
  const events = new MonitorEvents();
  const state = new FakeStateHub();
  const errors = new FakeErrorWindows();
  const teams = new SpyChannel('teams', true);
  const now = { t: 1000 };
  const engine = new AlertEngine({
    rules: [],
    state,
    events,
    errors,
    channels: [teams],
    defaultCooldownSec: 300,
    logger: silent,
    now: () => now.t,
  });
  await engine.test('teams');
  assert.equal(teams.sent.length, 1);
  assert.equal(teams.sent[0].ruleId, '(test)');
  // 'email' is not among the configured channels -> rejects.
  await assert.rejects(() => engine.test('email'));
  engine.stop();
});

test('a rule targeting a disabled channel is skipped for that channel only', async () => {
  const events = new MonitorEvents();
  const state = new FakeStateHub();
  const errors = new FakeErrorWindows();
  const teams = new SpyChannel('teams', false); // disabled
  const email = new SpyChannel('email', true);
  const now = { t: 1000 };
  const engine = new AlertEngine({
    rules: [rule({ id: 'crash', match: { processes: ['*'], condition: { type: 'errored' } } })],
    state,
    events,
    errors,
    channels: [teams, email],
    defaultCooldownSec: 300,
    logger: silent,
    now: () => now.t,
  });
  events.emit('process:transition', { name: 'api', from: 'online', to: 'errored', at: now.t });
  await flush();
  assert.equal(teams.sent.length, 0);
  assert.equal(email.sent.length, 1);
  engine.stop();
});
