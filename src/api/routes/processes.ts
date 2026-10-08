/**
 * Process routes: list/detail/metrics, the control endpoints (start/stop/
 * restart/reload/delete, startNew), and the log-tail read.
 *
 * A ControlResult maps to HTTP as: ok → 200 (201 for create); not-ok with code
 * PM2_UNAVAILABLE → 409; any other not-ok (PM2_ERROR etc.) → 502. The log route
 * resolves `:name` against the snapshot FIRST (404 unknown), so readLogsTail is
 * only ever called for a known process (200 { lines: [] } when its file is
 * missing).
 */

import { Router, type Response } from 'express';
import type { ApiDeps } from '../server.js';
import { validate, validated } from '../validate.js';
import type {
  CreateProcessBody,
  LogsRequest,
  MetricsRequest,
  NameParams,
} from '../schemas.js';
import type { ControlAction, ControlResult, StartNewOpts } from '../../pm2/client.js';

/** Writes a ControlResult to the response with the design's status mapping. */
function sendControlResult(res: Response, result: ControlResult, okStatus = 200): void {
  if (result.ok) {
    res.status(okStatus).json(result);
    return;
  }
  const status = result.code === 'PM2_UNAVAILABLE' ? 409 : 502;
  res.status(status).json({ error: { code: result.code, message: result.message } });
}

export function createProcessesRouter(deps: ApiDeps): Router {
  const router = Router();
  const { schemas, state, pm2 } = deps;

  router.get('/', (_req, res) => {
    res.json(state.snapshot().processes);
  });

  router.get('/:name', validate(schemas.nameParam), (_req, res) => {
    const { params } = validated<NameParams>(res);
    const proc = state.getProcess(params.name);
    if (!proc) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: `unknown process: ${params.name}` } });
      return;
    }
    res.json(proc);
  });

  router.get('/:name/metrics', validate(schemas.metricsRequest), (_req, res) => {
    const { params, query } = validated<MetricsRequest>(res);
    if (!state.getProcess(params.name)) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: `unknown process: ${params.name}` } });
      return;
    }
    const sinceTs = deps.now() - query.sinceMs;
    const samples = state.getMetrics(params.name, sinceTs);
    res.json({ name: params.name, samples });
  });

  // --- control endpoints (destructive; all require auth, applied upstream) ---

  function runControl(action: ControlAction, res: Response, next: (err: unknown) => void): void {
    const { params } = validated<NameParams>(res);
    pm2
      .control(action, params.name)
      .then((result) => sendControlResult(res, result))
      .catch(next);
  }

  router.post('/:name/start', validate(schemas.nameParam), (_req, res, next) => {
    runControl('start', res, next);
  });
  router.post('/:name/stop', validate(schemas.nameParam), (_req, res, next) => {
    runControl('stop', res, next);
  });
  router.post('/:name/restart', validate(schemas.nameParam), (_req, res, next) => {
    runControl('restart', res, next);
  });
  router.post('/:name/reload', validate(schemas.nameParam), (_req, res, next) => {
    runControl('reload', res, next);
  });
  router.delete('/:name', validate(schemas.nameParam), (_req, res, next) => {
    runControl('delete', res, next);
  });

  // create a brand-new process (201 on success)
  router.post('/', validate(schemas.createProcess), (_req, res, next) => {
    const { body } = validated<CreateProcessBody>(res);
    const opts: StartNewOpts = {
      ...(body.script !== undefined ? { script: body.script } : {}),
      ...(body.ecosystem !== undefined ? { ecosystem: body.ecosystem } : {}),
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.instances !== undefined ? { instances: body.instances } : {}),
      ...(body.exec_mode !== undefined ? { exec_mode: body.exec_mode } : {}),
    };
    pm2
      .startNew(opts)
      .then((result) => sendControlResult(res, result, 201))
      .catch(next);
  });

  // --- logs ---

  router.get('/:name/logs', validate(schemas.logsRequest), (_req, res, next) => {
    const { params, query } = validated<LogsRequest>(res);
    // Resolve the name against the snapshot FIRST: 404 for unknown.
    if (!state.getProcess(params.name)) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: `unknown process: ${params.name}` } });
      return;
    }
    pm2
      .readLogsTail(params.name, query.lines, {
        stream: query.stream,
        ...(query.q !== undefined ? { q: query.q } : {}),
        ...(query.level !== undefined ? { level: query.level } : {}),
      })
      .then((lines) => res.json({ name: params.name, lines }))
      .catch(next);
  });

  return router;
}
