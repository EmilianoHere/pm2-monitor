/**
 * Agent boot: wires the full standalone core (MonitorEvents/MetricsStore/
 * ErrorTracker/MonitorState + Pm2Client) EXACTLY as standalone for local
 * monitoring/control, but instead of an HTTP server it runs an AgentRuntime +
 * AgentConnection that dial the server. No inbound port is opened (AC-7).
 *
 * Boot ordering (design §3): the AgentConnection dial loop starts FIRST; the
 * real PM2 adapter/client is wired in a BACKGROUND task (same deferred-facade
 * pattern as src/index.ts standalone), so the server connection is never
 * blocked by a hung/absent local PM2 daemon and a control:request arriving
 * before PM2 attaches returns a correlated PM2_UNAVAILABLE (AC-14).
 */

import os from 'node:os';
import type { Logger } from '../core/logger.js';
import type { AppConfig } from '../config/env.js';
import { MonitorEvents } from '../core/events.js';
import { MonitorState } from '../core/state.js';
import { MetricsStore } from '../metrics/store.js';
import { ErrorTracker } from '../errors/tracker.js';
import { Pm2Client, createPm2Adapter } from '../pm2/client.js';
import type { Pm2Deps } from '../api/server.js';
import { buildSchemas } from '../api/schemas.js';
import { resolveAgentId } from '../agent/identity.js';
import { AgentConnection } from '../agent/connection.js';
import { createWsSocketFactory } from '../agent/wsSocket.js';
import { AgentRuntime } from '../agent/runtime.js';

const MONITOR_VERSION = '1.0.0';

export interface AgentDialConfig {
  url: string;
  wsPath: string;
  token: string;
  nameHint?: string;
  idFile: string;
  insecure: boolean;
}

/**
 * Derives the agent dial config from AppConfig. SERVER_URL/AGENT_TOKEN presence
 * is guaranteed by the env.ts superRefine in agent mode.
 */
export function buildAgentDialConfig(cfg: AppConfig): AgentDialConfig {
  return {
    url: cfg.SERVER_URL as string,
    wsPath: cfg.AGENT_WS_PATH,
    token: cfg.AGENT_TOKEN as string,
    ...(cfg.AGENT_NAME !== undefined ? { nameHint: cfg.AGENT_NAME } : {}),
    idFile: cfg.AGENT_ID_FILE,
    insecure: cfg.TLS_INSECURE,
  };
}

/** Boots the agent runtime: dials the server, wires local PM2 in the background. */
export async function bootstrapAgent(config: Readonly<AppConfig>, logger: Logger): Promise<void> {
  const dial = buildAgentDialConfig(config);
  const agentId = resolveAgentId({ idFile: dial.idFile, hostname: os.hostname(), logger });
  logger.info('agent identity resolved', { agentId });

  // --- core hub (identical to standalone) ---
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
  const state = new MonitorState({ events, metrics, errors });

  // --- pm2 facade (deferred; short-circuits until the real client is wired) ---
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

  // --- agent runtime + outbound connection ---
  const schemas = buildSchemas({ allowedScriptRoot: config.ALLOWED_SCRIPT_ROOT });
  const connection = new AgentConnection({
    serverUrl: dial.url,
    wsPath: dial.wsPath,
    agentId,
    token: dial.token,
    meta: {
      hostname: os.hostname(),
      platform: process.platform,
      monitorVersion: MONITOR_VERSION,
      ...(dial.nameHint !== undefined ? { nameHint: dial.nameHint } : {}),
    },
    logger,
    insecure: dial.insecure,
    socketFactory: createWsSocketFactory(),
  });

  const runtime = new AgentRuntime({
    events,
    state,
    pm2,
    schemas,
    logger,
    send: (msg) => connection.send(msg),
    isConnected: () => connection.isRegistered(),
  });

  connection.setHandlers({
    onRegistered: () => runtime.onRegistered(),
    onDisconnected: () => runtime.onDisconnected(),
    onMessage: (msg) => runtime.handleMessage(msg),
  });

  // Start dialing FIRST — never blocked by local PM2 state.
  connection.start();

  // --- pm2 wiring (background; never blocks or crashes the dial) ---
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

  // --- graceful shutdown ---
  let shuttingDown = false;
  const shutdown = async (signal: string, exitCode: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    try {
      connection.stop();
      runtime.stop();
      await pm2Client?.stop();
      state.stop();
      errors.stop();
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
