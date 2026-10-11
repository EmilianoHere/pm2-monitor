/**
 * Agent-token routes. Mounted in server.ts under `/api/settings/agent-tokens`
 * AFTER the global `/api` auth middleware and BEHIND `requireMaster`, so a
 * no/invalid-credential request is 401 before the guard and a valid secondary
 * key is 403. Mirrors the human api-key handlers in settings.ts. Every failure
 * uses the `{ error: { code, message } }` envelope. No route ever emits a hash;
 * the raw token is emitted ONCE from POST.
 *
 * Routes:
 *   GET    /         -> list (masked rows)
 *   POST   /         -> generate (201 { ...rawToken once })
 *   DELETE /:id      -> revoke (200/404)
 *   PATCH  /:id      -> relabel (200/404)
 */

import { Router } from 'express';
import { validate } from '../validate.js';
import { agentTokenGenerate, agentTokenIdParam, agentTokenRelabel } from '../schemas.js';
import type { AgentTokenService } from '../../server/agentTokenStore.js';

export function createAgentTokensRouter(agentTokens: AgentTokenService): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(agentTokens.list());
  });

  router.post('/', validate(agentTokenGenerate), (_req, res, next) => {
    const label = (res.locals.validated as { body: { label: string } }).body.label;
    void agentTokens
      .generate(label)
      .then((token) => {
        // rawToken is returned here exactly ONCE; it is never persisted or listed.
        res.status(201).json(token);
      })
      .catch(next);
  });

  router.delete('/:id', validate(agentTokenIdParam), (_req, res, next) => {
    const id = (res.locals.validated as { params: { id: string } }).params.id;
    void agentTokens
      .revoke(id)
      .then((ok) => {
        if (!ok) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'unknown agent-token id' } });
          return;
        }
        res.json({ ok: true });
      })
      .catch(next);
  });

  router.patch('/:id', validate(agentTokenRelabel), (_req, res, next) => {
    const { params, body } = res.locals.validated as { params: { id: string }; body: { label: string } };
    void agentTokens
      .relabel(params.id, body.label)
      .then((ok) => {
        if (!ok) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'unknown agent-token id' } });
          return;
        }
        res.json({ ok: true });
      })
      .catch(next);
  });

  return router;
}
