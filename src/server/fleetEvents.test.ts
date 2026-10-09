import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MonitorEvents } from '../core/events.js';
import { createLogger } from '../core/logger.js';
import { AlertEngine, AGENT_OFFLINE_RULE_ID } from '../alerts/engine.js';
import type { AlertChannel, AlertPayload } from '../alerts/channels/types.js';
import type { AlertRule } from '../config/alertRules.js';
import { FleetRegistry, type AgentWebSocket } from './registry.js';
import { AliasStore } from './aliasStore.js';
import {
  GlobalMaintenanceState,
  FleetStateHub,
  FleetErrorWindows,
  FleetAlertBridge,
  buildResolveAgent,
} from './fleetEvents.js';

const silent = createLogger({ level: 'error', sink: () => {} });

class SpyChannel implements AlertChannel {
  readonly sent: AlertPayload[] = [];
  constructor(
    readonly name: 'teams' | 'email',
    readonly enabled = true,
  ) {}
  async send(p: AlertPayload): Promise<void> {
    this.sent.push(p);
  }
}

class FakeSocket implements AgentWebSocket {
  send(): void {}
}

const META = { hostname: 'h', platform: 'linux', monitorVersion: '1.0.0' };
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function rule(partial: Partial<AlertRule> & Pick<AlertRule, 'id' | 'match'>): AlertRule {
  return {
    enabled: true,
    severity: 'warning',
    channels: { teams: true, email: true },
    ...partial,
  } as AlertRule;
}

/** An in-memory AliasStore (no real disk). */
function memAliasStore(seed: Record<string, string> = {}): AliasStore {
  const store = new AliasStore({
    file: '/tmp/none.json',
    logger: silent,
    readFile: async () => JSON.stringify(seed),
    writeFile: async () => {},
    rename: async () => {},
  });
  return store;
}

interface Harness {
  registry: FleetRegistry;
  aliases: AliasStore;
  engine: AlertEngine;
  bridge: FleetAlertBridge;
  teams: SpyChannel;
  maintenance: GlobalMaintenanceState;
  now: { t: number };
}

async function makeFleet(rules: AlertRule[], seed: Record<string, string> = {}): Promise<Harness> {
  const now = { t: 1000 };
  const registry = new FleetRegistry({
    logger: silent,
    retentionMin: 180,
    sampleSec: 5,
    errorBufferSize: 500,
    now: () => now.t,
  });
  const aliases = memAliasStore(seed);
  await aliases.load();
  const maintenance = new GlobalMaintenanceState(() => now.t);
  const fleetEvents = new MonitorEvents();
  const teams = new SpyChannel('teams', true);
  const engine = new AlertEngine({
    rules,
    state: new FleetStateHub(registry, maintenance),
    events: fleetEvents,
    errors: new FleetErrorWindows(registry),
    channels: [teams],
    defaultCooldownSec: 300,
    logger: silent,
    now: () => now.t,
    resolveAgent: buildResolveAgent(registry, aliases),
  });
  const bridge = new FleetAlertBridge({ registry, aliases, engine, events: fleetEvents });
  return { registry, aliases, engine, bridge, teams, maintenance, now };
}

test('a bare rule evaluates across all agents and attributes each alert to its agent', async () => {
  const h = await makeFleet([
    rule({ id: 'crash', match: { processes: ['api'], condition: { type: 'errored' } } }),
  ]);
  h.registry.register('a1', { ...META, nameHint: 'Alpha' }, new FakeSocket());
  h.registry.register('a2', META, new FakeSocket());

  // A transition on each agent's bus fires one alert each, attributed per agent.
  h.registry.get('a1')!.events.emit('process:transition', { name: 'api', from: 'online', to: 'errored', at: 1000 });
  h.registry.get('a2')!.events.emit('process:transition', { name: 'api', from: 'online', to: 'errored', at: 1000 });
  await flush();

  assert.equal(h.teams.sent.length, 2);
  const byId = new Map(h.teams.sent.map((p) => [p.agentId, p]));
  assert.ok(byId.has('a1') && byId.has('a2'));
  // nameHint seeds the alias when none stored.
  assert.equal(byId.get('a1')!.agentAlias, 'Alpha');
  assert.equal(byId.get('a1')!.processName, 'api');
  assert.ok(byId.get('a1')!.summary.startsWith('[Alpha] '));

  h.bridge.stop();
  h.engine.stop();
});

test('an operator alias wins over the agent nameHint in the payload', async () => {
  const h = await makeFleet(
    [rule({ id: 'crash', match: { processes: ['*'], condition: { type: 'errored' } } })],
    { a1: 'MyAlias' },
  );
  h.registry.register('a1', { ...META, nameHint: 'Alpha' }, new FakeSocket());
  h.registry.get('a1')!.events.emit('process:transition', { name: 'api', from: 'online', to: 'errored', at: 1000 });
  await flush();
  assert.equal(h.teams.sent[0].agentAlias, 'MyAlias');
  h.bridge.stop();
  h.engine.stop();
});

test('global maintenance suppresses alerts across all agents', async () => {
  const h = await makeFleet([
    rule({ id: 'crash', match: { processes: ['*'], condition: { type: 'errored' } } }),
  ]);
  h.maintenance.setMaintenance({ active: true });
  h.registry.register('a1', META, new FakeSocket());
  h.registry.register('a2', META, new FakeSocket());
  h.registry.get('a1')!.events.emit('process:transition', { name: 'api', from: 'online', to: 'errored', at: 1000 });
  h.registry.get('a2')!.events.emit('process:transition', { name: 'api', from: 'online', to: 'errored', at: 1000 });
  await flush();
  assert.equal(h.teams.sent.length, 0, 'no channel delivery while maintenance is active');
  h.bridge.stop();
  h.engine.stop();
});

test('a disconnect emits exactly one agent-offline alert (cooldown-gated), no per-process crash alerts', async () => {
  const h = await makeFleet([
    rule({ id: 'crash', match: { processes: ['*'], condition: { type: 'errored' } } }),
  ]);
  h.registry.register('a1', { ...META, nameHint: 'Alpha' }, new FakeSocket());
  h.registry.markOffline('a1');
  await flush();
  const offline = h.teams.sent.filter((p) => p.ruleId === AGENT_OFFLINE_RULE_ID);
  assert.equal(offline.length, 1, 'exactly one agent-offline alert');
  assert.equal(offline[0].agentId, 'a1');
  assert.equal(offline[0].agentAlias, 'Alpha');
  // No synthetic per-process crash alerts were fabricated.
  assert.equal(h.teams.sent.filter((p) => p.ruleId === 'crash').length, 0);

  // A rapid re-disconnect inside the cooldown window does not re-alert.
  h.registry.register('a1', { ...META, nameHint: 'Alpha' }, new FakeSocket());
  h.registry.markOffline('a1');
  await flush();
  assert.equal(h.teams.sent.filter((p) => p.ruleId === AGENT_OFFLINE_RULE_ID).length, 1, 'still only one (cooldown)');

  h.bridge.stop();
  h.engine.stop();
});

test('a composite agentId/name rule fires only for the owning agent (cross-agent surface)', async () => {
  const h = await makeFleet([
    rule({ id: 'crash', match: { processes: ['a1/api'], condition: { type: 'errored' } } }),
  ]);
  h.registry.register('a1', META, new FakeSocket());
  h.registry.register('a2', META, new FakeSocket());
  h.registry.get('a2')!.events.emit('process:transition', { name: 'api', from: 'online', to: 'errored', at: 1000 });
  await flush();
  assert.equal(h.teams.sent.filter((p) => p.ruleId === 'crash').length, 0);
  h.registry.get('a1')!.events.emit('process:transition', { name: 'api', from: 'online', to: 'errored', at: 1000 });
  await flush();
  const fired = h.teams.sent.filter((p) => p.ruleId === 'crash');
  assert.equal(fired.length, 1);
  assert.equal(fired[0].agentId, 'a1');
  h.bridge.stop();
  h.engine.stop();
});
