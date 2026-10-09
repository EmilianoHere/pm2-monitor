/**
 * Entry point: wires every module in dependency order and starts the HTTP + WS
 * server, then schedules the daily digest and installs graceful shutdown.
 *
 * Boot order (design "Entry point"):
 *   loadConfig → logger → loadAlertRules → MonitorState/MetricsStore/ErrorTracker
 *   → channels → AlertEngine (wire events; MonitorState subscribes to metrics:tick
 *   BEFORE AlertEngine) → Pm2Client.start() (non-blocking; HTTP comes up even if
 *   PM2 is down) → createServer + WsHub → server.listen → digest scheduler.
 *
 * SIGINT/SIGTERM → graceful shutdown (stop accepting, close WS, pm2Client.stop,
 * exit 0). unhandledRejection/uncaughtException are logged; an uncaught
 * exception triggers the same graceful shutdown with exit 1.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createLogger } from './core/logger.js';
import { loadConfig, type AppConfig } from './config/env.js';
import { alertRulesFileSchema, loadAlertRules, type AlertRule } from './config/alertRules.js';
import { MonitorEvents } from './core/events.js';
import { MonitorState } from './core/state.js';
import { MetricsStore } from './metrics/store.js';
import { ErrorTracker } from './errors/tracker.js';
import { TeamsChannel } from './alerts/channels/teams.js';
import { EmailChannel, type SmtpConfig } from './alerts/channels/email.js';
import type { AlertChannel } from './alerts/channels/types.js';
import { AlertEngine, type AlertStateHub } from './alerts/engine.js';
import { DigestScheduler } from './alerts/digest.js';
import { Pm2Client, createPm2Adapter } from './pm2/client.js';
import type { Pm2Deps } from './api/server.js';
import { createServer, type ApiDeps, type ReloadRulesResult } from './api/server.js';
import { buildSchemas } from './api/schemas.js';
import { WsHub } from './ws/hub.js';
import type { AuthConfig } from './api/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** public/ lives at the project root, one level above dist/ (or src/). */
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

/** Builds the SMTP config only when the email channel is fully configured. */
function buildSmtpConfig(cfg: AppConfig): SmtpConfig | undefined {
  if (!cfg.SMTP_HOST || !cfg.SMTP_USER || !cfg.SMTP_PASS || !cfg.MAIL_FROM || !cfg.MAIL_TO) {
    return undefined;
  }
  return {
    host: cfg.SMTP_HOST,
    port: cfg.SMTP_PORT,
    secure: cfg.SMTP_SECURE,
    user: cfg.SMTP_USER,
    pass: cfg.SMTP_PASS,
    from: cfg.MAIL_FROM,
    to: cfg.MAIL_TO,
  };
}

/** Derives the auth config from AppConfig. */
function buildAuthConfig(cfg: AppConfig): AuthConfig {
  if (cfg.AUTH_MODE === 'basic') {
    // env.ts refinement guarantees these are present in basic mode.
    return { mode: 'basic', user: cfg.BASIC_USER as string, pass: cfg.BASIC_PASS as string };
  }
  return { mode: 'apikey', apiKey: cfg.API_KEY as string };
}

export async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.LOG_LEVEL });
  logger.info('pm2-monitor starting', { host: config.HOST, port: config.PORT, authMode: config.AUTH_MODE });

  let rules = loadAlertRules(config.ALERT_RULES_FILE, logger);

  // --- core hub ---
  const events = new MonitorEvents();
  const metrics = new MetricsStore({
    retentionMin: config.METRICS_RETENTION_MIN,
    sampleSec: config.METRICS_SAMPLE_SEC,
  });
  const errors = new ErrorTracker({
    events,
    bufferSize: config.ERROR_BUFFER_SIZE,
    logAppend: config.ERROR_LOG_APPEND,
    logger,
  });
  // MonitorState subscribes to metrics:tick in its ctor — construct it BEFORE
  // the AlertEngine so this tick's samples are pushed before the engine reads.
  const state = new MonitorState({ events, metrics, errors });

  // --- channels ---
  const teams = new TeamsChannel({
    ...(config.TEAMS_WEBHOOK_URL !== undefined ? { webhookUrl: config.TEAMS_WEBHOOK_URL } : {}),
    logger,
  });
  const smtp = buildSmtpConfig(config);
  const email = new EmailChannel({ ...(smtp !== undefined ? { smtp } : {}), logger });
  await email.verify();
  const channels: AlertChannel[] = [teams, email];

  // --- alert engine (subscribes to metrics:tick AFTER MonitorState) ---
  const engineStateHub: AlertStateHub = {
    getMaintenance: () => ({ active: state.getMaintenance().active }),
    getProcess: (name) => state.getProcess(name),
    processNames: () => state.snapshot().processes.map((p) => p.name),
    sustainedAbove: (name, metric, threshold, durationSec) =>
      metrics.sustainedAbove(name, metric, threshold, durationSec),
  };
  const engine = new AlertEngine({
    rules,
    state: engineStateHub,
    events,
    errors,
    channels,
    defaultCooldownSec: config.DEFAULT_COOLDOWN_SEC,
    logger,
  });

  // --- digest counters: tally alert events (approximation per design) ---
  let dispatchedCount = 0;
  let suppressedCount = 0;
  events.on('alert', (e) => {
    if (e.delivered) dispatchedCount += 1;
    else suppressedCount += 1;
  });

  // --- pm2 client (deferred) ---
  // The real adapter is built in a background task AFTER the HTTP server binds
  // (see below) so a hung pm2 connect can never block boot. `deps.pm2` must be
  // non-null and valid from the moment createServer is called, so it points at
  // this stable facade: before the real client is wired it short-circuits every
  // control/log call to PM2_UNAVAILABLE (same contract Pm2Client uses while
  // disconnected); once the background task assigns `pm2Client` the facade
  // delegates to it. shutdown() awaits `pm2Client?.stop()` guarded for null.
  let pm2Client: Pm2Client | null = null;
  const pm2: Pm2Deps = {
    control: (action, name) =>
      pm2Client
        ? pm2Client.control(action, name)
        : Promise.resolve({ ok: false, code: 'PM2_UNAVAILABLE', message: 'PM2 daemon is not connected' }),
    startNew: (opts) =>
      pm2Client
        ? pm2Client.startNew(opts)
        : Promise.resolve({ ok: false, code: 'PM2_UNAVAILABLE', message: 'PM2 daemon is not connected' }),
    readLogsTail: (name, lines, opts) =>
      pm2Client ? pm2Client.readLogsTail(name, lines, opts) : Promise.resolve([]),
  };

  // --- HTTP + WS ---
  const schemas = buildSchemas({ allowedScriptRoot: config.ALLOWED_SCRIPT_ROOT });
  const startedAt = Date.now();
  const reloadRules = (): ReloadRulesResult => {
    let raw: string;
    try {
      raw = readFileSync(config.ALERT_RULES_FILE, 'utf8');
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
      const message = result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      return { ok: false, message };
    }
    return { ok: true, rules: result.data.rules };
  };

  const deps: ApiDeps = {
    state,
    pm2,
    engine,
    errors,
    schemas,
    auth: buildAuthConfig(config),
    logger,
    publicDir: PUBLIC_DIR,
    version: '1.0.0',
    startedAt,
    now: () => Date.now(),
    getRules: () => rules,
    setRules: (next: AlertRule[]) => {
      rules = next;
    },
    reloadRules,
  };

  const server = createServer(deps);
  const wsHub = new WsHub({
    server,
    events,
    auth: deps.auth,
    logger,
    snapshot: () => state.snapshot(),
  });

  await new Promise<void>((resolve) => {
    server.listen(config.PORT, config.HOST, () => {
      logger.info('listening', { host: config.HOST, port: config.PORT });
      resolve();
    });
  });

  // --- pm2 wiring (background; never blocks or crashes boot) ---
  // The HTTP server is already listening. Build the real adapter and start the
  // client's non-blocking connect/backoff loop off the boot path, so a hung or
  // throwing createPm2Adapter()/connect cannot stop listen from being reached.
  void (async () => {
    try {
      const adapter = await createPm2Adapter(logger);
      const client = new Pm2Client({
        adapter,
        state,
        events,
        logger,
        sampleSec: config.METRICS_SAMPLE_SEC,
        graceMs: config.INTENTIONAL_ACTION_GRACE_MS,
      });
      pm2Client = client;
      client.start();
    } catch (err) {
      logger.error('pm2 wiring failed; continuing without PM2', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  })();

  // --- daily digest ---
  const digest = new DigestScheduler({
    email,
    source: {
      processes: () => state.snapshot().processes,
      trackedErrors: (name) => errors.list(name),
    },
    counters: {
      dispatched: () => dispatchedCount,
      suppressed: () => suppressedCount,
    },
    digestHour: config.DIGEST_HOUR,
    enabled: config.DIGEST_ENABLED,
    errorBufferSize: config.ERROR_BUFFER_SIZE,
    logger,
  });
  digest.start();

  // --- graceful shutdown ---
  let shuttingDown = false;
  const shutdown = async (signal: string, exitCode: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    try {
      wsHub.close();
      digest.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pm2Client?.stop();
      state.stop();
      errors.stop();
      engine.stop();
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

/**
 * Boot when this module is the program entry point. Two cases boot:
 *  1. Direct invocation: `node dist/index.js` — argv[1] resolves to this file.
 *  2. PM2 fork mode: PM2 does NOT exec the script directly; it runs its own
 *     `ProcessContainerFork.js` which `require()`s this module, so argv[1] is
 *     PM2's container path, never this file. PM2 sets `pm_id` in the child env,
 *     so that marks a PM2-managed launch and must boot too — otherwise the app
 *     loads silently and never starts (no logs, no port).
 * Importers (tests) hit neither case and do not boot.
 */
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const invokedDirectly = invokedPath === fileURLToPath(import.meta.url);
const underPm2 = typeof process.env.pm_id === 'string' && process.env.pm_id.length > 0;
if (invokedDirectly || underPm2) {
  bootstrap().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('fatal boot error', err);
    process.exit(1);
  });
}
