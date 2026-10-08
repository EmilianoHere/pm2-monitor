/**
 * Alert + maintenance routes.
 *  - GET  /api/alerts/rules          — the loaded rules (no secrets live in a rule).
 *  - POST /api/alerts/rules/reload   — re-read + re-validate the rules file and
 *    hand them to the engine; 400 with issues on an invalid file.
 *  - POST /api/alerts/test           — probe one or all channels.
 *  - GET  /api/alerts/recent         — recent dispatched/suppressed alerts.
 *  - GET  /api/maintenance           — current maintenance state.
 *  - POST /api/maintenance           — set maintenance (optional duration/reason).
 */

import { Router } from 'express';
import type { ApiDeps } from '../server.js';
import { validate, validated } from '../validate.js';
import type { AlertsRecentQuery, AlertsTestBody, MaintenanceBody } from '../schemas.js';

export function createAlertsRouter(deps: ApiDeps): Router {
  const router = Router();
  const { schemas, engine } = deps;

  router.get('/rules', (_req, res) => {
    // AlertRule carries no secrets, so the rule set is safe to return verbatim.
    res.json(deps.getRules());
  });

  router.post('/rules/reload', (_req, res) => {
    const result = deps.reloadRules();
    if (!result.ok) {
      res.status(400).json({ error: { code: 'VALIDATION', message: result.message } });
      return;
    }
    engine.reload(result.rules);
    deps.setRules(result.rules);
    res.json({ reloaded: true, count: result.rules.length });
  });

  router.post('/test', validate(schemas.alertsTest), (_req, res, next) => {
    const { body } = validated<AlertsTestBody>(res);
    const channels: Array<'teams' | 'email'> = body.channel === 'all' ? ['teams', 'email'] : [body.channel];
    Promise.all(
      channels.map(async (channel) => {
        try {
          await engine.test(channel);
          return { channel, ok: true as const };
        } catch (err) {
          return { channel, ok: false as const, error: err instanceof Error ? err.message : String(err) };
        }
      }),
    )
      .then((results) => res.json({ results }))
      .catch(next);
  });

  router.get('/recent', validate(schemas.alertsRecent), (_req, res) => {
    const { query } = validated<AlertsRecentQuery>(res);
    res.json(engine.recentAlerts(query.limit));
  });

  return router;
}

export function createMaintenanceRouter(deps: ApiDeps): Router {
  const router = Router();
  const { schemas, state } = deps;

  router.get('/', (_req, res) => {
    const m = state.getMaintenance();
    res.json({
      active: m.active,
      until: m.until ?? null,
      reason: m.reason ?? null,
    });
  });

  router.post('/', validate(schemas.maintenance), (_req, res) => {
    const { body } = validated<MaintenanceBody>(res);
    const updated = state.setMaintenance({
      active: body.active,
      ...(body.durationMin !== undefined ? { durationMin: body.durationMin } : {}),
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
    });
    res.json({
      active: updated.active,
      until: updated.until ?? null,
      reason: updated.reason ?? null,
    });
  });

  return router;
}
