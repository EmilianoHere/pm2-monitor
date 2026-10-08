/**
 * Error routes.
 *  - GET /api/errors — list tracked errors, optionally filtered by name/sinceMs,
 *    capped by limit.
 *  - GET /api/errors/export — download the list as json or csv with a
 *    Content-Disposition attachment header.
 *
 * The tracked-error list is read through the ErrorTracker's `list(name)`; with
 * no `?name` filter every known process's errors are merged.
 */

import { Router } from 'express';
import type { ApiDeps } from '../server.js';
import { validate, validated } from '../validate.js';
import type { ErrorsExportQuery, ErrorsQuery } from '../schemas.js';
import type { TrackedError } from '../../core/types.js';

/** Collects tracked errors for one name or all known processes, filtered. */
function collectErrors(deps: ApiDeps, name: string | undefined, sinceMs: number | undefined): TrackedError[] {
  const names = name !== undefined ? [name] : deps.state.snapshot().processes.map((p) => p.name);
  const out: TrackedError[] = [];
  for (const n of names) {
    for (const e of deps.errors.list(n)) {
      if (sinceMs === undefined || e.lastSeen >= sinceMs) out.push(e);
    }
  }
  // Most-recent first for the list view.
  out.sort((a, b) => b.lastSeen - a.lastSeen);
  return out;
}

const CSV_COLUMNS: Array<keyof TrackedError> = [
  'signature',
  'processName',
  'firstSeen',
  'lastSeen',
  'count',
  'level',
  'intentional',
  'message',
  'sample',
];

/** Escapes a value for CSV (wraps in quotes, doubles embedded quotes). */
function csvCell(value: unknown): string {
  const s = value === undefined || value === null ? '' : String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function toCsv(errors: TrackedError[]): string {
  const header = CSV_COLUMNS.join(',');
  const rows = errors.map((e) => CSV_COLUMNS.map((c) => csvCell(e[c])).join(','));
  return [header, ...rows].join('\n');
}

export function createErrorsRouter(deps: ApiDeps): Router {
  const router = Router();
  const { schemas } = deps;

  router.get('/', validate(schemas.errorsQuery), (_req, res) => {
    const { query } = validated<ErrorsQuery>(res);
    const errors = collectErrors(deps, query.name, query.sinceMs).slice(0, query.limit);
    res.json(errors);
  });

  router.get('/export', validate(schemas.errorsExportQuery), (_req, res) => {
    const { query } = validated<ErrorsExportQuery>(res);
    const errors = collectErrors(deps, query.name, undefined);
    const stamp = new Date(deps.now()).toISOString().replace(/[:.]/g, '-');
    if (query.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="errors-${stamp}.csv"`);
      res.send(toCsv(errors));
      return;
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="errors-${stamp}.json"`);
    res.send(JSON.stringify(errors, null, 2));
  });

  return router;
}
