/**
 * Unified fleet REST surface, mounted under /api/agents BEHIND the existing
 * human auth (AC-53 — human auth unchanged). It reads/controls agents through a
 * narrow, injectable {@link FleetDeps} surface (like StateDeps) so tests inject
 * a fake registry/alias store.
 *
 * The agent LIST is keyed by the LIVE registry: a pre-seeded alias for a
 * never-connected id is NOT listed (there is no registry entry to attach it to).
 * Routed-control failures arrive as not-ok ControlResult values and are mapped
 * to HTTP by {@link statusForControlCode} with the `{ error: { code, message } }`
 * envelope — a failed create is never 201. An ok non-create returns 200; the
 * create route returns 201 ONLY when `result.ok === true`.
 *
 * `:id` is validated by agentIdSchema and `:name` by processNameSchema; the
 * create body is validated server-side with `createProcess.safeParse({ body })`
 * BEFORE routing (both-ends validation, NFR-3). Aliases go through aliasSchema;
 * an invalid alias returns 400 VALIDATION and is never persisted.
 */

import { Router, type Request, type Response } from 'express';
import { aliasSchema, processNameSchema, type RequestSchemas } from '../schemas.js';
import { agentIdSchema } from '../../protocol/shapes.js';
import { statusForControlCode } from './controlStatus.js';
import { AliasValidationError } from '../../server/aliasStore.js';
import type { ControlAction, ControlResult, StartNewOpts } from '../../pm2/client.js';
import type { ProcessSnapshot, MetricSample, TrackedError } from '../../core/types.js';

/** One relayed log line as returned by the server-mode agent logs read. */
export interface AgentLogLine {
  agentId: string;
  process: string;
  stream: 'out' | 'err';
  level: 'info' | 'error';
  line: string;
  ts: number;
}

/** A row in the GET /api/agents list (keyed by the live registry). */
export interface AgentListRow {
  id: string;
  alias: string | undefined;
  online: boolean;
  meta: unknown;
  pm2Connected: boolean;
  processCount: number;
  lastSeen: number;
}

/** The full agent detail (GET /api/agents/:id). */
export interface AgentDetail extends AgentListRow {
  processes: ProcessSnapshot[];
}

/**
 * The narrow fleet surface the agents routes depend on. A thin adapter over
 * FleetRegistry + AliasStore satisfies it in server boot; a fake satisfies it in
 * tests.
 */
export interface FleetDeps {
  /** rows for the live registry (never-connected pre-seeded aliases excluded). */
  listAgents(): AgentListRow[];
  /** full detail for one agent, or null if unknown. */
  getAgent(id: string): AgentDetail | null;
  /** per-agent process list, or null if the agent is unknown. */
  agentProcesses(id: string): ProcessSnapshot[] | null;
  /** per-agent metric series for a process (empty if unknown). */
  agentMetrics(id: string, name: string, sinceMs: number): MetricSample[];
  /** recent relayed log lines for a process ([] if nothing is streaming). */
  agentLogs(id: string, name: string): AgentLogLine[];
  /** per-agent tracked errors for a process. */
  agentErrors(id: string, name: string): TrackedError[];
  /** routes a name-only control action to the agent (correlated). */
  routeControl(id: string, action: ControlAction, name: string): Promise<ControlResult>;
  /** routes a create (start-new) to the agent (correlated). */
  routeCreate(id: string, opts: StartNewOpts): Promise<ControlResult>;
  /** persists a cosmetic alias; rejects AliasValidationError on invalid input. */
  setAlias(id: string, alias: string): Promise<void>;
}

export interface AgentsRouterDeps {
  fleet: FleetDeps;
  schemas: RequestSchemas;
  now(): number;
}

function badRequest(res: Response, message: string): void {
  res.status(400).json({ error: { code: 'VALIDATION', message } });
}

function notFound(res: Response, message: string): void {
  res.status(404).json({ error: { code: 'AGENT_NOT_FOUND', message } });
}

/** Writes a routed ControlResult with the fleet HTTP mapping. */
function sendControlResult(res: Response, result: ControlResult, okStatus = 200): void {
  if (result.ok) {
    res.status(okStatus).json(result);
    return;
  }
  res.status(statusForControlCode(result.code)).json({ error: { code: result.code, message: result.message } });
}

/** Validates and returns `:id`, or writes 400 and returns null. */
function validId(req: Request, res: Response): string | null {
  const parsed = agentIdSchema.safeParse(req.params.id);
  if (!parsed.success) {
    badRequest(res, 'invalid agent id');
    return null;
  }
  return parsed.data;
}

/** Validates and returns `:name`, or writes 400 and returns null. */
function validName(req: Request, res: Response): string | null {
  const parsed = processNameSchema.safeParse(req.params.name);
  if (!parsed.success) {
    badRequest(res, 'invalid process name');
    return null;
  }
  return parsed.data;
}

export function createAgentsRouter(deps: AgentsRouterDeps): Router {
  const router = Router();
  const { fleet } = deps;

  router.get('/', (_req, res) => {
    res.json(fleet.listAgents());
  });

  router.get('/:id', (req, res) => {
    const id = validId(req, res);
    if (id === null) return;
    const detail = fleet.getAgent(id);
    if (!detail) {
      notFound(res, `unknown agent ${id}`);
      return;
    }
    res.json(detail);
  });

  router.get('/:id/processes', (req, res) => {
    const id = validId(req, res);
    if (id === null) return;
    const procs = fleet.agentProcesses(id);
    if (procs === null) {
      notFound(res, `unknown agent ${id}`);
      return;
    }
    res.json(procs);
  });

  router.get('/:id/processes/:name/metrics', (req, res) => {
    const id = validId(req, res);
    if (id === null) return;
    const name = validName(req, res);
    if (name === null) return;
    if (fleet.getAgent(id) === null) {
      notFound(res, `unknown agent ${id}`);
      return;
    }
    const sinceMsRaw = Number(req.query.sinceMs);
    const sinceMs = Number.isFinite(sinceMsRaw) && sinceMsRaw >= 0 ? sinceMsRaw : 60 * 60 * 1000;
    const samples = fleet.agentMetrics(id, name, deps.now() - sinceMs);
    res.json({ name, samples });
  });

  router.get('/:id/processes/:name/logs', (req, res) => {
    const id = validId(req, res);
    if (id === null) return;
    const name = validName(req, res);
    if (name === null) return;
    if (fleet.getAgent(id) === null) {
      notFound(res, `unknown agent ${id}`);
      return;
    }
    res.json({ name, lines: fleet.agentLogs(id, name) });
  });

  router.get('/:id/errors', (req, res) => {
    const id = validId(req, res);
    if (id === null) return;
    if (fleet.getAgent(id) === null) {
      notFound(res, `unknown agent ${id}`);
      return;
    }
    const nameQ = typeof req.query.name === 'string' ? req.query.name : undefined;
    if (nameQ !== undefined && !processNameSchema.safeParse(nameQ).success) {
      badRequest(res, 'invalid process name');
      return;
    }
    res.json(fleet.agentErrors(id, nameQ ?? ''));
  });

  // --- control (routed) ---

  function control(action: ControlAction) {
    return (req: Request, res: Response, next: (err: unknown) => void): void => {
      const id = validId(req, res);
      if (id === null) return;
      const name = validName(req, res);
      if (name === null) return;
      fleet
        .routeControl(id, action, name)
        .then((result) => sendControlResult(res, result))
        .catch(next);
    };
  }

  router.post('/:id/processes/:name/start', control('start'));
  router.post('/:id/processes/:name/stop', control('stop'));
  router.post('/:id/processes/:name/restart', control('restart'));
  router.post('/:id/processes/:name/reload', control('reload'));
  router.delete('/:id/processes/:name', control('delete'));

  // create a brand-new process on the agent (201 only on ok)
  router.post('/:id/processes', (req, res, next) => {
    const id = validId(req, res);
    if (id === null) return;
    // Server-side { body }-wrapped createProcess validation BEFORE routing.
    const parsed = deps.schemas.createProcess.safeParse({ body: req.body });
    if (!parsed.success) {
      sendControlResult(res, { ok: false, code: 'VALIDATION', message: 'invalid create body' });
      return;
    }
    const body = (parsed.data as { body: StartNewOpts }).body;
    const opts: StartNewOpts = {
      ...(body.script !== undefined ? { script: body.script } : {}),
      ...(body.ecosystem !== undefined ? { ecosystem: body.ecosystem } : {}),
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.instances !== undefined ? { instances: body.instances } : {}),
      ...(body.exec_mode !== undefined ? { exec_mode: body.exec_mode } : {}),
    };
    fleet
      .routeCreate(id, opts)
      .then((result) => sendControlResult(res, result, 201))
      .catch(next);
  });

  // --- alias ---

  router.put('/:id/alias', (req, res, next) => {
    const id = validId(req, res);
    if (id === null) return;
    const body = (req.body ?? {}) as { alias?: unknown };
    const parsed = aliasSchema.safeParse(body.alias);
    if (!parsed.success) {
      badRequest(res, parsed.error.issues.map((i) => i.message).join('; ') || 'invalid alias');
      return;
    }
    fleet
      .setAlias(id, parsed.data)
      .then(() => res.json({ id, alias: parsed.data }))
      .catch((err: unknown) => {
        if (err instanceof AliasValidationError) {
          badRequest(res, err.message);
          return;
        }
        next(err);
      });
  });

  return router;
}
