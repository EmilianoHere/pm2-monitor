/**
 * Standalone boot: the single-process monitor wiring. This is a pure extraction
 * of the former `bootstrap()` body from `src/index.ts` — behavior is unchanged.
 * `src/index.ts` now branches on `config.MODE` and delegates here for
 * `standalone` (the default).
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
import type { Logger } from '../core/logger.js';
import type { AppConfig } from '../config/env.js';
import { alertRulesFileSchema, loadAlertRules, type AlertRule } from '../config/alertRules.js';
import { MonitorEvents } from '../core/events.js';
import { MonitorState } from '../core/state.js';
import { MetricsStore } from '../metrics/store.js';
import { ErrorTracker } from '../errors/tracker.js';
import { TeamsChannel } from '../alerts/channels/teams.js';
import { EmailChannel, type SmtpConfig } from '../alerts/channels/email.js';
import type { AlertChannel } from '../alerts/channels/types.js';
import { AlertEngine, type AlertStateHub } from '../alerts/engine.js';
import { DigestScheduler } from '../alerts/digest.js';
import { Pm2Client, createPm2Adapter } from '../pm2/client.js';
import type { Pm2Deps } from '../api/server.js';
import { createServer, type ApiDeps, type ReloadRulesResult } from '../api/server.js';
import { buildSchemas } from '../api/schemas.js';
import { WsHub } from '../ws/hub.js';
import type { AuthConfig } from '../api/auth.js';
import { ApiKeyStore, ApiKeyService } from '../server/apiKeyStore.js';
import { SettingsStore } from '../config/settingsStore.js';
import { SecretsStore } from '../config/secretsStore.js';
import { SettingsService } from '../config/settingsService.js';
import { mergeEffectiveConfig } from '../config/env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/**
 * public/ lives at the project root. From dist/boot/standalone.js or
 * src/boot/standalone.ts, '../..' is the project root.
 */
const PUBLIC_DIR = path.resolve(__dirname, '..', '..', 'public');

/** Builds the SMTP config only when the email channel is fully configured. */
export function buildSmtpConfig(cfg: AppConfig): SmtpConfig | undefined {
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
export function buildAuthConfig(cfg: AppConfig): AuthConfig {
  if (cfg.AUTH_MODE === 'basic') {
    // env.ts refinement guarantees these are present in basic mode.
    return { mode: 'basic', user: cfg.BASIC_USER as string, pass: cfg.BASIC_PASS as string };
  }
  return { mode: 'apikey', apiKey: cfg.API_KEY as string };
}

/** Boots the standalone single-process monitor. */
export async function bootstrapStandalone(config: Readonly<AppConfig>, logger: Logger): Promise<void> {
  // --- settings overlay stores (design §4.1 boot wiring) ---
  // With no config/*.json files these start empty and `merged` equals `config`
  // byte-for-byte (mergeEffectiveConfig is idempotent on empty overlays), so a
  // standalone boot creates no new file and behaves identically to today.
  const apiKeyStore = new ApiKeyStore({ file: 'config/api-keys.json', logger });
  const settingsStore = new SettingsStore({ file: 'config/settings.json', logger });
  const secretsStore = new SecretsStore({ file: 'config/secrets.json', logger });
  await apiKeyStore.load();
  await settingsStore.load();
  await secretsStore.load();
  const apiKeys = new ApiKeyService(apiKeyStore);
  const merged = mergeEffectiveConfig(config, settingsStore.get(), secretsStore.get());

  let rules = loadAlertRules(merged.ALERT_RULES_FILE, logger);

  // --- core hub ---
  const events = new MonitorEvents();
  const metrics = new MetricsStore({
    retentionMin: merged.METRICS_RETENTION_MIN,
    sampleSec: merged.METRICS_SAMPLE_SEC,
  });
  const errors = new ErrorTracker({
    events,
    bufferSize: merged.ERROR_BUFFER_SIZE,
    logAppend: merged.ERROR_LOG_APPEND,
    logger,
  });
  // MonitorState subscribes to metrics:tick in its ctor — construct it BEFORE
  // the AlertEngine so this tick's samples are pushed before the engine reads.
  const state = new MonitorState({ events, metrics, errors });

  // --- channels ---
  const teams = new TeamsChannel({
    ...(merged.TEAMS_WEBHOOK_URL !== undefined ? { webhookUrl: merged.TEAMS_WEBHOOK_URL } : {}),
    logger,
  });
  const smtp = buildSmtpConfig(merged);
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
    defaultCooldownSec: merged.DEFAULT_COOLDOWN_SEC,
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
  const schemas = buildSchemas({ allowedScriptRoot: merged.ALLOWED_SCRIPT_ROOT });
  const startedAt = Date.now();
  const reloadRules = (): ReloadRulesResult => {
    let raw: string;
    try {
      raw = readFileSync(merged.ALERT_RULES_FILE, 'utf8');
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

  // --- daily digest (constructed before the server so the SettingsService can
  // hold its live handle; started after listen below). ---
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
    digestHour: merged.DIGEST_HOUR,
    enabled: merged.DIGEST_ENABLED,
    errorBufferSize: merged.ERROR_BUFFER_SIZE,
    logger,
  });

  // --- settings service (hot-apply orchestration over the live handles) ---
  const settingsService = new SettingsService({
    settingsStore,
    secretsStore,
    base: config,
    handles: { teams, email, engine, digest, errors, logger },
  });

  const deps: ApiDeps = {
    state,
    pm2,
    engine,
    errors,
    schemas,
    auth: buildAuthConfig(config),
    keys: apiKeyStore,
    apiKeys,
    settings: settingsService,
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
    keys: apiKeyStore,
    logger,
    snapshot: () => state.snapshot(),
  });

  await new Promise<void>((resolve) => {
    server.listen(merged.PORT, merged.HOST, () => {
      logger.info('listening', { host: merged.HOST, port: merged.PORT });
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
        sampleSec: merged.METRICS_SAMPLE_SEC,
        graceMs: merged.INTENTIONAL_ACTION_GRACE_MS,
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
