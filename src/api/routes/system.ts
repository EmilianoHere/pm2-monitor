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

/** Health is mounted separately (before auth) in server.ts. */
export function createHealthRouter(deps: ApiDeps): Router {
  const router = Router();
  router.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      pm2Connected: deps.state.isConnected(),
      maintenance: deps.state.getMaintenance().active,
      uptimeMs: deps.now() - deps.startedAt,
      version: deps.version,
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
