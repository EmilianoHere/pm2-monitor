/**
 * System routes.
 *  - GET /api/system/health — UNAUTHENTICATED liveness probe.
 *  - GET /api/system/status — authenticated full MonitorSnapshot.
 *
 * `health` is the single unauthenticated /api/* endpoint (design Auth rule);
 * it is mounted on the router BEFORE the auth middleware is applied so an
 * unauthenticated caller can read it.
 */

import { Router } from 'express';
import type { ApiDeps } from '../server.js';

/**
 * Health is mounted separately (before auth) in server.ts. Standalone health
 * is byte-for-byte unchanged except for the additive `mode:'standalone'` field.
 */
export function createHealthRouter(deps: ApiDeps): Router {
  const router = Router();
  router.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      mode: 'standalone',
      pm2Connected: deps.state.isConnected(),
      maintenance: deps.state.getMaintenance().active,
      uptimeMs: deps.now() - deps.startedAt,
      version: deps.version,
    });
  });
  return router;
}

/** The global maintenance holder the server health router reads (server mode). */
export interface MaintenanceHolder {
  getMaintenance(): { active: boolean };
}

/** A minimal FleetRegistry summary surface the server health router reads. */
export interface FleetSummary {
  size: number;
  onlineCount(): number;
}

/** Narrow deps for the server-mode health router (no StateDeps). */
export interface ServerHealthDeps {
  maintenance: MaintenanceHolder;
  registry: FleetSummary;
  version: string;
  startedAt: number;
  now(): number;
}

/**
 * Server-mode health (unauthenticated). Reports `mode:'server'` with a fleet
 * agents summary and NO `pm2Connected` (there is no local PM2 daemon). Reads
 * the global MaintenanceState holder + a FleetRegistry summary directly, so it
 * needs no StateDeps.
 */
export function createServerHealthRouter(deps: ServerHealthDeps): Router {
  const router = Router();
  router.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      mode: 'server',
      maintenance: deps.maintenance.getMaintenance().active,
      agents: { total: deps.registry.size, online: deps.registry.onlineCount() },
      version: deps.version,
      uptimeMs: deps.now() - deps.startedAt,
    });
  });
  return router;
}

/** Authenticated system routes (status). Mounted after auth. */
export function createSystemRouter(deps: ApiDeps): Router {
  const router = Router();
  router.get('/status', (_req, res) => {
    res.json(deps.state.snapshot());
  });
  return router;
}
