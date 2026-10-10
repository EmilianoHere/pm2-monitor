/**
 * HTTP server factory. `createServer(deps)` builds an Express app with a
 * size-limited JSON body parser, a redacting request logger, the auth middleware
 * (every /api/* route except GET /api/system/health), the route modules mounted
 * under /api, a static mount of public/ at /, and a terminal error handler that
 * maps thrown/next-ed errors to the `{ error: { code, message } }` envelope.
 *
 * It returns the shared `http.Server` (NOT `app.listen`) so the WS hub can
 * attach to the same server and WS upgrades ride the same port.
 */

import { createServer as createHttpServer, type Server } from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Logger } from '../core/logger.js';
import { redactUrl } from '../core/logger.js';
import type { MonitorSnapshot, MetricSample, ProcessSnapshot, TrackedError } from '../core/types.js';
import type { MaintenanceState, SetMaintenanceInput } from '../core/state.js';
import type { ControlAction, ControlResult, LogTailOpts, StartNewOpts } from '../pm2/client.js';
import type { LogLine } from '../core/types.js';
import type { AlertRule } from '../config/alertRules.js';
import type { RecentAlert } from '../alerts/engine.js';
import type { RequestSchemas } from './schemas.js';
import { createAuthMiddleware, requireMaster, type AuthConfig, type KeyVerifier } from './auth.js';
import { createHealthRouter, createSystemRouter } from './routes/system.js';
import { createProcessesRouter } from './routes/processes.js';
import { createErrorsRouter } from './routes/errors.js';
import { createAlertsRouter, createMaintenanceRouter } from './routes/alerts.js';
import { createSettingsRouter } from './routes/settings.js';
import type { ApiKeyService } from '../server/apiKeyStore.js';
import type { SettingsService } from '../config/settingsService.js';

// --- narrow dependency surfaces (so integration tests inject fakes) ---

/** The MonitorState reads/writes the API layer uses. */
export interface StateDeps {
  snapshot(): MonitorSnapshot;
  getProcess(name: string): ProcessSnapshot | null;
  getMetrics(name: string, sinceMs: number): MetricSample[];
  isConnected(): boolean;
  getMaintenance(): MaintenanceState;
  setMaintenance(input: SetMaintenanceInput): MaintenanceState;
}

/** The Pm2Client surface the control/log routes need. */
export interface Pm2Deps {
  control(action: ControlAction, name: string): Promise<ControlResult>;
  startNew(opts: StartNewOpts): Promise<ControlResult>;
  readLogsTail(name: string, lines: number, opts?: LogTailOpts): Promise<LogLine[]>;
}

/** The AlertEngine surface the alert routes need. */
export interface EngineDeps {
  reload(rules: AlertRule[]): void;
  recentAlerts(limit?: number): RecentAlert[];
  test(channel: 'teams' | 'email'): Promise<void>;
}

/** The ErrorTracker surface the error routes need. */
export interface ErrorsDeps {
  list(name: string): TrackedError[];
}

/** Result of a runtime rules reload (never exits the process). */
export type ReloadRulesResult =
  | { ok: true; rules: AlertRule[] }
  | { ok: false; message: string };

export interface ApiDeps {
  state: StateDeps;
  pm2: Pm2Deps;
  engine: EngineDeps;
  errors: ErrorsDeps;
  schemas: RequestSchemas;
  auth: AuthConfig;
  /**
   * Optional secondary-key verifier threaded into the auth middleware (apikey
   * mode). Omitted (existing tests) → auth is byte-identical to today.
   */
  keys?: KeyVerifier;
  /** Optional api-key management service; required to mount /api/settings. */
  apiKeys?: ApiKeyService;
  /** Optional settings orchestration service; required to mount /api/settings. */
  settings?: SettingsService;
  logger: Logger;
  /** static asset root; defaults to the on-disk public/ dir. */
  publicDir: string;
  /** reported in GET /api/system/health. */
  version: string;
  /** boot timestamp (epoch ms) for uptime reporting. */
  startedAt: number;
  /** injectable clock. */
  now: () => number;
  /** current loaded rules (for GET /api/alerts/rules). */
  getRules(): AlertRule[];
  /** swaps the stored rules after a successful reload. */
  setRules(rules: AlertRule[]): void;
  /** re-reads + re-validates the rules file without exiting. */
  reloadRules(): ReloadRulesResult;
}

interface ApiErrorLike {
  statusCode?: number;
  status?: number;
  code?: string;
  message?: string;
  stack?: string;
}

export function createServer(deps: ApiDeps): Server {
  const app = express();
  app.disable('x-powered-by');

  app.use(express.json({ limit: '64kb' }));

  // Request logger — URL is redacted so a ?token= never reaches the logs.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    deps.logger.debug('http request', { method: req.method, url: redactUrl(req.originalUrl) });
    next();
  });

  // UNAUTHENTICATED: health probe (the single open /api/* endpoint).
  app.use('/api/system', createHealthRouter(deps));

  // Everything else under /api requires auth.
  const auth = createAuthMiddleware(deps.auth, deps.keys);
  app.use('/api', auth);

  app.use('/api/system', createSystemRouter(deps));
  app.use('/api/processes', createProcessesRouter(deps));
  app.use('/api/errors', createErrorsRouter(deps));
  app.use('/api/alerts', createAlertsRouter(deps));
  app.use('/api/maintenance', createMaintenanceRouter(deps));

  // Settings (master-only). Guarded so existing deps-less tests are unchanged:
  // the global /api auth already 401s a bad credential before requireMaster.
  if (deps.settings && deps.apiKeys) {
    app.use('/api/settings', requireMaster, createSettingsRouter(deps));
  }

  // Static dashboard shell (unauthenticated); the browser then supplies creds.
  app.use('/', express.static(deps.publicDir));

  // 404 for unmatched /api routes (static handles the rest).
  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'unknown endpoint' } });
  });

  // Terminal error handler — maps thrown/next-ed errors to the envelope.
  app.use((err: ApiErrorLike, req: Request, res: Response, _next: NextFunction) => {
    const status = err.statusCode ?? err.status ?? 500;
    const code = err.code ?? (status === 400 ? 'VALIDATION' : status === 404 ? 'NOT_FOUND' : 'INTERNAL');
    const message = err.message ?? 'internal error';
    if (status >= 500) {
      deps.logger.error('request failed', {
        method: req.method,
        url: redactUrl(req.originalUrl),
        status,
        err: message,
        stack: err.stack,
      });
    } else {
      deps.logger.debug('request error', {
        method: req.method,
        url: redactUrl(req.originalUrl),
        status,
        code,
      });
    }
    if (res.headersSent) return;
    res.status(status).json({ error: { code, message } });
  });

  return createHttpServer(app);
}
