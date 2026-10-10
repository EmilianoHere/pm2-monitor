/**
 * Server boot: the hub runtime behind MODE=server. It wires the human-facing
 * Express app + WsHub (reused) for operators, MINUS the local Pm2Client/
 * MonitorState, PLUS the agent-facing AgentGateway, the FleetRegistry, the
 * AliasStore, a single global MaintenanceState holder, the agent-aware
 * AlertEngine fed from fleetEvents with the injected resolveAgent, and the
 * unified /api/agents router (FleetDeps over the registry/alias store).
 *
 * The server health router (mode:'server', no pm2Connected) is mounted instead
 * of the standalone health router, and /api/system/status is NOT mounted (there
 * is no single local snapshot). The existing /api/maintenance routes toggle the
 * global maintenance holder. Native TLS is used when BOTH TLS_CERT_FILE/
 * TLS_KEY_FILE are set (https.createServer); otherwise plain http behind a
 * reverse proxy. WsHub + AgentGateway attach identically in noServer mode.
 */

import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Logger } from '../core/logger.js';
import { redactUrl } from '../core/logger.js';
import type { AppConfig } from '../config/env.js';
import { MonitorEvents } from '../core/events.js';
import { loadAlertRules, alertRulesFileSchema, type AlertRule } from '../config/alertRules.js';
import { TeamsChannel } from '../alerts/channels/teams.js';
import { EmailChannel } from '../alerts/channels/email.js';
import type { AlertChannel } from '../alerts/channels/types.js';
import { AlertEngine } from '../alerts/engine.js';
import { buildSchemas, type RequestSchemas } from '../api/schemas.js';
import { createAuthMiddleware } from '../api/auth.js';
import { createServerHealthRouter } from '../api/routes/system.js';
import { createAgentsRouter, type FleetDeps, type AgentListRow, type AgentDetail, type AgentLogLine } from '../api/routes/agents.js';
import { WsHub, type FleetLogRelay } from '../ws/hub.js';
import { FleetRegistry } from '../server/registry.js';
import { AgentGateway } from '../server/gateway.js';
import { AliasStore } from '../server/aliasStore.js';
import { buildAgentAuthConfig } from '../server/agentAuth.js';
import {
  GlobalMaintenanceState,
  FleetStateHub,
  FleetErrorWindows,
  FleetAlertBridge,
  buildResolveAgent,
} from '../server/fleetEvents.js';
import { buildSmtpConfig, buildAuthConfig } from './standalone.js';
import { Router } from 'express';
import { validate, validated } from '../api/validate.js';
import type { MaintenanceBody, AlertsRecentQuery, AlertsTestBody } from '../api/schemas.js';
import type { ControlAction, ControlResult, StartNewOpts } from '../pm2/client.js';
import type { MonitorSnapshot } from '../core/types.js';

const MONITOR_VERSION = '1.0.0';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// public/ lives at the project root. From dist/boot/server.js (or
// src/boot/server.ts), '../..' is the project root — same as standalone.
const PUBLIC_DIR = path.resolve(__dirname, '..', '..', 'public');

interface ApiErrorLike {
  statusCode?: number;
  status?: number;
  code?: string;
  message?: string;
  stack?: string;
}

/** Builds the FleetDeps adapter over the registry + alias store. */
export function buildFleetDeps(registry: FleetRegistry, aliases: AliasStore): FleetDeps {
  const row = (id: string): AgentListRow | null => {
    const entry = registry.get(id);
    if (!entry) return null;
    return {
      id: entry.id,
      alias: aliases.get(id),
      online: entry.online,
      meta: entry.meta,
      pm2Connected: entry.pm2Connected,
      processCount: entry.processes.size,
      lastSeen: entry.lastSeen,
    };
  };
  return {
    listAgents(): AgentListRow[] {
      // Keyed by the LIVE registry — pre-seeded aliases for never-connected ids
      // are NOT listed (no registry entry to attach them to).
      return registry.ids().map((id) => row(id)).filter((r): r is AgentListRow => r !== null);
    },
    getAgent(id: string): AgentDetail | null {
      const base = row(id);
      const entry = registry.get(id);
      if (!base || !entry) return null;
      return { ...base, processes: [...entry.processes.values()] };
    },
    agentProcesses(id: string) {
      const entry = registry.get(id);
      return entry ? [...entry.processes.values()] : null;
    },
    agentMetrics(id: string, name: string, sinceMs: number) {
      const entry = registry.get(id);
      return entry ? entry.metrics.getSeries(name, sinceMs) : [];
    },
    agentLogs(id: string, name: string): AgentLogLine[] {
      return registry.recentLogs(id, name);
    },
    agentErrors(id: string, name: string) {
      const entry = registry.get(id);
      return entry ? entry.errors.list(name) : [];
    },
    routeControl(id: string, action: ControlAction, name: string): Promise<ControlResult> {
      return registry.routeControl(id, action, name);
    },
    routeCreate(id: string, opts: StartNewOpts): Promise<ControlResult> {
      return registry.routeCreate(id, opts);
    },
    setAlias(id: string, alias: string): Promise<void> {
      return aliases.set(id, alias);
    },
  };
}

/** Boots the server (hub) runtime. */
export async function bootstrapServer(config: Readonly<AppConfig>, logger: Logger): Promise<void> {
  let rules: AlertRule[] = loadAlertRules(config.ALERT_RULES_FILE, logger);

  // --- global maintenance + fleet registry + alias store ---
  const maintenance = new GlobalMaintenanceState();
  const registry = new FleetRegistry({
    logger,
    retentionMin: config.METRICS_RETENTION_MIN,
    sampleSec: config.METRICS_SAMPLE_SEC,
    errorBufferSize: config.ERROR_BUFFER_SIZE,
  });
  const aliases = new AliasStore({ file: config.ALIAS_STORE_FILE, logger });
  await aliases.load();

  // --- channels ---
  const teams = new TeamsChannel({
    ...(config.TEAMS_WEBHOOK_URL !== undefined ? { webhookUrl: config.TEAMS_WEBHOOK_URL } : {}),
    logger,
  });
  const smtp = buildSmtpConfig(config);
  const email = new EmailChannel({ ...(smtp !== undefined ? { smtp } : {}), logger });
  await email.verify();
  const channels: AlertChannel[] = [teams, email];

  // --- agent-aware alert engine fed from fleet events ---
  const fleetEvents = new MonitorEvents();
  const engine = new AlertEngine({
    rules,
    state: new FleetStateHub(registry, maintenance),
    events: fleetEvents,
    errors: new FleetErrorWindows(registry),
    channels,
    defaultCooldownSec: config.DEFAULT_COOLDOWN_SEC,
    logger,
    resolveAgent: buildResolveAgent(registry, aliases),
  });
  const bridge = new FleetAlertBridge({ registry, aliases, engine, events: fleetEvents });

  // --- HTTP(S) server (native TLS when the cert+key pair is set) ---
  const schemas = buildSchemas({ allowedScriptRoot: config.ALLOWED_SCRIPT_ROOT });
  const startedAt = Date.now();
  const app = buildServerApp({ config, logger, maintenance, registry, aliases, engine, schemas, startedAt, getRules: () => rules, setRules: (r) => { rules = r; } });

  let server: Server;
  if (config.TLS_CERT_FILE && config.TLS_KEY_FILE) {
    server = createHttpsServer(
      { cert: readFileSync(config.TLS_CERT_FILE), key: readFileSync(config.TLS_KEY_FILE) },
      app,
    ) as unknown as Server;
    logger.info('native TLS enabled', { cert: config.TLS_CERT_FILE });
  } else {
    server = createHttpServer(app);
  }

  // --- human WS hub with the fleet log relay hook ---
  // RelayLogClient and HumanLogClient are the same structural shape (deliver a
  // line); the SAME client object is passed to subscribe + unsubscribe so the
  // registry's ref-count keys on a stable identity.
  const relay: FleetLogRelay = {
    subscribeLogs: (agentId, process, streams, client) =>
      registry.subscribeLogs(agentId, process, streams, client),
    unsubscribeLogs: (agentId, process, client) =>
      registry.unsubscribeLogs(agentId, process, client),
  };
  const wsHub = new WsHub({
    server,
    events: fleetEvents,
    auth: buildAuthConfig(config),
    logger,
    snapshot: emptySnapshot,
    relay,
  });

  // --- agent gateway on the shared server ---
  const { tokens } = buildAgentAuthConfig(config);
  const gateway = new AgentGateway({ server, registry, tokens, wsPath: config.AGENT_WS_PATH, logger });

  await new Promise<void>((resolve) => {
    server.listen(config.PORT, config.HOST, () => {
      logger.info('listening', { host: config.HOST, port: config.PORT, mode: 'server' });
      resolve();
    });
  });

  // --- graceful shutdown ---
  let shuttingDown = false;
  const shutdown = async (signal: string, exitCode: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    try {
      wsHub.close();
      gateway.close();
      bridge.stop();
      engine.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    } catch (err) {
      logger.error('error during shutdown', { err: err instanceof Error ? err.message : String(err) });
    }
    process.exit(exitCode);
  };

  process.on('SIGINT', () => void shutdown('SIGINT', 0));
  process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandledRejection', { reason: reason instanceof Error ? reason.message : String(reason) });
  });
  process.on('uncaughtException', (err) => {
    logger.error('uncaughtException', { err: err.message, stack: err.stack });
    void shutdown('uncaughtException', 1);
  });
}

/** The server has no single local snapshot; the hub hello carries an empty one. */
function emptySnapshot(): MonitorSnapshot {
  return { processes: [], pm2Connected: false, maintenance: false, generatedAt: Date.now() };
}

interface ServerAppDeps {
  config: Readonly<AppConfig>;
  logger: Logger;
  maintenance: GlobalMaintenanceState;
  registry: FleetRegistry;
  aliases: AliasStore;
  engine: AlertEngine;
  schemas: RequestSchemas;
  startedAt: number;
  getRules(): AlertRule[];
  setRules(rules: AlertRule[]): void;
}

/**
 * Builds the server-mode Express app: the same middleware stack as the human
 * `createServer` (json parser, redacting request logger, auth), the server
 * health router (unauthenticated), then the maintenance + alerts + agents
 * routers behind auth. `/api/system/status` is NOT mounted.
 */
export function buildServerApp(deps: ServerAppDeps): express.Express {
  const { config, logger } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.use((req: Request, _res: Response, next: NextFunction) => {
    logger.debug('http request', { method: req.method, url: redactUrl(req.originalUrl) });
    next();
  });

  // UNAUTHENTICATED: server-mode health (mode:'server', no pm2Connected).
  app.use(
    '/api/system',
    createServerHealthRouter({
      maintenance: deps.maintenance,
      registry: deps.registry,
      version: MONITOR_VERSION,
      startedAt: deps.startedAt,
      now: () => Date.now(),
    }),
  );

  // Everything else under /api requires the human auth (unchanged credential space).
  app.use('/api', createAuthMiddleware(buildAuthConfig(config)));

  // Global maintenance toggle (reuses the human route shape against the holder).
  app.use('/api/maintenance', createMaintenanceRouter(deps.maintenance, deps.schemas));

  // Alert rules + recent + reload (fleet engine).
  app.use('/api/alerts', createAlertsRouter(deps));

  // Unified fleet surface.
  app.use('/api/agents', createAgentsRouter({ fleet: buildFleetDeps(deps.registry, deps.aliases), schemas: deps.schemas, now: () => Date.now() }));

  // Static dashboard shell (unauthenticated), identical to standalone — the same
  // public/ assets serve the fleet UI, which discovers server mode from health.
  app.use('/', express.static(PUBLIC_DIR));

  // 404 for unmatched /api routes (static handles the rest).
  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'unknown endpoint' } });
  });

  app.use((err: ApiErrorLike, req: Request, res: Response, _next: NextFunction) => {
    const status = err.statusCode ?? err.status ?? 500;
    const code = err.code ?? (status === 400 ? 'VALIDATION' : status === 404 ? 'NOT_FOUND' : 'INTERNAL');
    const message = err.message ?? 'internal error';
    if (status >= 500) {
      logger.error('request failed', { method: req.method, url: redactUrl(req.originalUrl), status, err: message });
    }
    if (res.headersSent) return;
    res.status(status).json({ error: { code, message } });
  });

  return app;
}

// --- small inline routers reused from the human surface shapes ---

/** Global maintenance router over the holder (same JSON shape as standalone). */
function createMaintenanceRouter(holder: GlobalMaintenanceState, schemas: RequestSchemas): Router {
  const router = Router();
  router.get('/', (_req, res) => {
    const m = holder.getMaintenance();
    res.json({ active: m.active, until: m.until ?? null, reason: m.reason ?? null });
  });
  router.post('/', validate(schemas.maintenance), (_req, res) => {
    const { body } = validated<MaintenanceBody>(res);
    const updated = holder.setMaintenance({
      active: body.active,
      ...(body.durationMin !== undefined ? { durationMin: body.durationMin } : {}),
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
    });
    res.json({ active: updated.active, until: updated.until ?? null, reason: updated.reason ?? null });
  });
  return router;
}

/** Alerts router over the fleet engine (rules/reload/test/recent). */
function createAlertsRouter(deps: ServerAppDeps): Router {
  const router = Router();
  const { engine, schemas } = deps;
  router.get('/rules', (_req, res) => res.json(deps.getRules()));
  router.post('/rules/reload', (_req, res) => {
    const result = reloadRules(deps.config.ALERT_RULES_FILE);
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
    const list: Array<'teams' | 'email'> = body.channel === 'all' ? ['teams', 'email'] : [body.channel];
    Promise.all(
      list.map(async (channel) => {
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

type ReloadResult = { ok: true; rules: AlertRule[] } | { ok: false; message: string };

/** Re-reads + re-validates the rules file without exiting (mirrors standalone). */
function reloadRules(path: string): ReloadResult {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: true, rules: [] };
    return { ok: false, message: `could not read rules file: ${String(err)}` };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { ok: false, message: `rules file is not valid JSON: ${String(err)}` };
  }
  const result = alertRulesFileSchema.safeParse(json);
  if (!result.success) {
    return { ok: false, message: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  }
  return { ok: true, rules: result.data.rules };
}
