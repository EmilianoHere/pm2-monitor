/**
 * fleetEvents: the glue that lets the single, reused {@link AlertEngine} run
 * across the whole fleet in server mode.
 *
 * It bridges each agent's per-agent {@link MonitorEvents} bus (owned by the
 * {@link FleetRegistry} entry) onto one fleet {@link MonitorEvents} bus the
 * engine subscribes to, re-keying every process identity to the composite
 * `${agentId}/${name}` (split on the LAST `/`). It implements the server
 * {@link AlertStateHub}/{@link AlertErrorWindows} over the registry so the
 * engine's sampled + windowed primitives dispatch to the owning agent's store.
 * It builds the {@link ResolveAgent} closure over the registry + AliasStore
 * (AGENT_NAME seeds the alias only when none is stored; an operator alias always
 * wins). It holds the single global {@link MaintenanceState} the engine reads so
 * maintenance and cooldown stay global. On an orderly disconnect it emits ONE
 * cooldown-gated agent-offline alert and suppresses per-process crash alerts (no
 * synthetic errored/stop events are fabricated).
 */

import { MonitorEvents } from '../core/events.js';
import type { AlertStateHub, AlertErrorWindows, ResolveAgent, AlertEngine } from '../alerts/engine.js';
import type { ProcessSnapshot, TrackedError } from '../core/types.js';
import type { ProcessTransitionEvent } from '../core/events.js';
import type { FleetRegistry, AgentEntry } from './registry.js';
import type { AliasStore } from './aliasStore.js';

/** A single global maintenance holder read by the fleet engine's state hub. */
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

/**
 * The global maintenance holder (server mode). Mirrors the subset of
 * MonitorState's maintenance semantics the engine + /api/maintenance route use,
 * with lazy expiry on read, so the existing routes toggle this one holder.
 */
export class GlobalMaintenanceState {
  private state: MaintenanceState = { active: false };
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  getMaintenance(): MaintenanceState {
    if (this.state.active && this.state.until !== undefined && this.now() >= this.state.until) {
      this.state = { active: false };
    }
    return { ...this.state };
  }

  setMaintenance(input: SetMaintenanceInput): MaintenanceState {
    if (input.active) {
      const until = input.durationMin !== undefined ? this.now() + input.durationMin * 60 * 1000 : undefined;
      this.state = {
        active: true,
        ...(until !== undefined ? { until } : {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      };
    } else {
      this.state = { active: false };
    }
    return { ...this.state };
  }
}

/** Splits a composite `agentId/name` key on the LAST `/`. */
function splitKey(key: string): { agentId: string; name: string } {
  const idx = key.lastIndexOf('/');
  if (idx === -1) return { agentId: '', name: key };
  return { agentId: key.slice(0, idx), name: key.slice(idx + 1) };
}

/**
 * The server AlertStateHub over the FleetRegistry. `processNames()` returns a
 * composite `agentId/name` for every process across ONLINE agents; the other
 * primitives parse the composite key and dispatch to the owning agent's store.
 */
export class FleetStateHub implements AlertStateHub {
  constructor(
    private readonly registry: FleetRegistry,
    private readonly maintenance: GlobalMaintenanceState,
  ) {}

  getMaintenance(): { active: boolean } {
    return { active: this.maintenance.getMaintenance().active };
  }

  getProcess(key: string): ProcessSnapshot | null {
    const { agentId, name } = splitKey(key);
    const entry = this.registry.get(agentId);
    if (!entry || !entry.online) return null;
    return entry.processes.get(name) ?? null;
  }

  processNames(): string[] {
    const out: string[] = [];
    for (const id of this.registry.ids()) {
      const entry = this.registry.get(id);
      if (!entry || !entry.online) continue;
      for (const name of entry.processes.keys()) out.push(`${id}/${name}`);
    }
    return out;
  }

  sustainedAbove(key: string, metric: 'cpu' | 'mem', threshold: number, durationSec: number): boolean {
    const { agentId, name } = splitKey(key);
    const entry = this.registry.get(agentId);
    if (!entry) return false;
    return entry.metrics.sustainedAbove(name, metric, threshold, durationSec);
  }
}

/** The server AlertErrorWindows over the FleetRegistry (composite keys). */
export class FleetErrorWindows implements AlertErrorWindows {
  constructor(private readonly registry: FleetRegistry) {}

  countInWindow(key: string, sinceSec: number): number {
    const { agentId, name } = splitKey(key);
    const entry = this.registry.get(agentId);
    if (!entry) return 0;
    return entry.errors.countInWindow(name, sinceSec);
  }

  restartsInWindow(key: string, sinceSec: number): number {
    const { agentId, name } = splitKey(key);
    const entry = this.registry.get(agentId);
    if (!entry) return 0;
    return entry.errors.restartsInWindow(name, sinceSec);
  }

  setMaxWindow(sec: number): void {
    for (const id of this.registry.ids()) {
      this.registry.get(id)?.errors.setMaxWindow(sec);
    }
  }
}

/**
 * Builds the resolveAgent closure over the registry + AliasStore. An operator
 * alias (AliasStore.get) always wins; otherwise the agent's AGENT_NAME
 * (meta.nameHint) seeds the display only when no alias is stored. The bare name
 * is the part after the last `/`.
 */
export function buildResolveAgent(registry: FleetRegistry, aliases: AliasStore): ResolveAgent {
  return (key: string) => {
    const { agentId, name } = splitKey(key);
    if (agentId === '') return { name: key };
    const stored = aliases.get(agentId);
    const hint = registry.get(agentId)?.meta.nameHint;
    const alias = stored ?? hint;
    return {
      agentId,
      ...(alias !== undefined ? { agentAlias: alias } : {}),
      name,
    };
  };
}

export interface FleetAlertBridgeOptions {
  registry: FleetRegistry;
  aliases: AliasStore;
  engine: AlertEngine;
  /** the fleet MonitorEvents the engine is subscribed to. */
  events: MonitorEvents;
}

/**
 * Bridges each agent entry's per-agent event bus onto the fleet events bus with
 * composite keys, and fires the single agent-offline alert on disconnect.
 *
 * The engine is constructed over `events`; this bridge attaches to each agent's
 * entry bus as it comes online and re-emits transition/error/metrics with
 * composite `agentId/name` identities.
 */
export class FleetAlertBridge {
  private readonly registry: FleetRegistry;
  private readonly aliases: AliasStore;
  private readonly engine: AlertEngine;
  private readonly events: MonitorEvents;
  /** per-agent listener handles so we can detach on offline. */
  private readonly attached = new Map<
    string,
    {
      onTransition: (e: ProcessTransitionEvent) => void;
      onError: (e: TrackedError) => void;
      onTick: (list: ProcessSnapshot[]) => void;
    }
  >();

  private readonly onAgentOnline = (id: string): void => this.attach(id);
  private readonly onAgentOffline = (id: string): void => this.detach(id);

  constructor(opts: FleetAlertBridgeOptions) {
    this.registry = opts.registry;
    this.aliases = opts.aliases;
    this.engine = opts.engine;
    this.events = opts.events;
    this.registry.on('agent:online', this.onAgentOnline);
    this.registry.on('agent:offline', this.onAgentOffline);
  }

  /** Detaches registry + per-agent listeners. */
  stop(): void {
    this.registry.off('agent:online', this.onAgentOnline);
    this.registry.off('agent:offline', this.onAgentOffline);
    for (const id of [...this.attached.keys()]) this.detachBus(id);
  }

  private attach(id: string): void {
    if (this.attached.has(id)) return;
    const entry = this.registry.get(id);
    if (!entry) return;
    const onTransition = (e: ProcessTransitionEvent): void => {
      this.events.emit('process:transition', { ...e, name: `${id}/${e.name}` });
    };
    const onError = (e: TrackedError): void => {
      this.events.emit('error:captured', { ...e, processName: `${id}/${e.processName}` });
    };
    const onTick = (list: ProcessSnapshot[]): void => {
      this.events.emit(
        'metrics:tick',
        list.map((p) => ({ ...p, name: `${id}/${p.name}` })),
      );
    };
    entry.events.on('process:transition', onTransition);
    entry.events.on('error:captured', onError);
    entry.events.on('metrics:tick', onTick);
    this.attached.set(id, { onTransition, onError, onTick });
  }

  /** Agent went offline: detach its bus and fire one agent-offline alert. */
  private detach(id: string): void {
    this.detachBus(id);
    const alias = this.aliases.get(id) ?? this.registry.get(id)?.meta.nameHint;
    void this.engine.emitAgentOffline(id, alias);
  }

  private detachBus(id: string): void {
    const handles = this.attached.get(id);
    if (!handles) return;
    const entry = this.registry.get(id);
    if (entry) {
      entry.events.off('process:transition', handles.onTransition);
      entry.events.off('error:captured', handles.onError);
      entry.events.off('metrics:tick', handles.onTick);
    }
    this.attached.delete(id);
  }
}

export type { AgentEntry };
