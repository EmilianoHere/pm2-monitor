/**
 * Settings routes (design §5). `createSettingsRouter(deps)` is mounted in
 * server.ts AFTER the global `/api` auth middleware and BEHIND `requireMaster`,
 * so a no/invalid-credential request is 401 before the guard and a valid
 * secondary key is 403. Every failure uses the `{ error: { code, message } }`
 * envelope. No route ever emits a raw key (except once from POST /keys), a full
 * hash, or a plaintext secret value.
 *
 * Routes:
 *   GET    /                      -> readEffective (grouped, masked)
 *   PUT    /                      -> two-stage validate + applySettings (200/400)
 *   DELETE /secrets/:field        -> clearSecret (200/400)
 *   GET    /keys                  -> list (masked rows)
 *   POST   /keys                  -> generate (201 { ...rawKey once })
 *   DELETE /keys/:id              -> revoke (200/404)
 *   PATCH  /keys/:id              -> relabel (200/404)
 *   GET    /whoami                -> { isMaster: true, authMode }
 */

import { Router } from 'express';
import type { ApiDeps } from '../server.js';
import { validate } from '../validate.js';
import { keyGenerate, keyIdParam, keyRelabel, secretFieldParam, settingsPut } from '../schemas.js';
import type { SecretsOverlayKey } from '../../config/env.js';

export function createSettingsRouter(deps: ApiDeps): Router {
  const router = Router();
  // These are guaranteed present by the mount guard in server.ts.
  const settings = deps.settings!;
  const apiKeys = deps.apiKeys!;

  // --- configuration overlay ---

  router.get('/', (_req, res) => {
    res.json(settings.readEffective());
  });

  router.put('/', validate(settingsPut), (_req, res, next) => {
    const body = (res.locals.validated as { body: Record<string, unknown> }).body;
    void settings
      .applySettings(body)
      .then((result) => {
        res.json({ ...settings.readEffective(), warnings: result.warnings });
      })
      .catch(next);
  });

  router.delete('/secrets/:field', validate(secretFieldParam), (_req, res, next) => {
    const field = (res.locals.validated as { params: { field: SecretsOverlayKey } }).params.field;
    void settings
      .clearSecret(field)
      .then((result) => {
        res.json({ ...settings.readEffective(), warnings: result.warnings });
      })
      .catch(next);
  });

  // --- api keys ---

  router.get('/keys', (_req, res) => {
    res.json(apiKeys.list());
  });

  router.post('/keys', validate(keyGenerate), (_req, res, next) => {
    const label = (res.locals.validated as { body: { label: string } }).body.label;
    void apiKeys
      .generate(label)
      .then((key) => {
        // rawKey is returned here exactly ONCE; it is never persisted or listed.
        res.status(201).json(key);
      })
      .catch(next);
  });

  router.delete('/keys/:id', validate(keyIdParam), (_req, res, next) => {
    const id = (res.locals.validated as { params: { id: string } }).params.id;
    void apiKeys
      .revoke(id)
      .then((ok) => {
        if (!ok) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'unknown key id' } });
          return;
        }
        res.json({ ok: true });
      })
      .catch(next);
  });

  router.patch('/keys/:id', validate(keyRelabel), (_req, res, next) => {
    const { params, body } = res.locals.validated as { params: { id: string }; body: { label: string } };
    void apiKeys
      .relabel(params.id, body.label)
      .then((ok) => {
        if (!ok) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'unknown key id' } });
          return;
        }
        res.json({ ok: true });
      })
      .catch(next);
  });

  // --- identity (reaching this already proves master) ---

  router.get('/whoami', (_req, res) => {
    res.json({ isMaster: true, authMode: deps.auth.mode });
  });

  return router;
}
