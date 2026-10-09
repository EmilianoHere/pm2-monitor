/**
 * Entry point: loads config, creates the logger, then dispatches on
 * `config.MODE` to the matching boot path. The standalone wiring lives in
 * `src/boot/standalone.ts` (a pure extraction of the former bootstrap body);
 * the agent and server boot paths are implemented in later features.
 *
 * SIGINT/SIGTERM graceful shutdown and the uncaught-exception handlers are
 * installed by each boot path.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createLogger } from './core/logger.js';
import { loadConfig } from './config/env.js';
import { bootstrapStandalone } from './boot/standalone.js';

export async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.LOG_LEVEL });
  logger.info('pm2-monitor starting', {
    mode: config.MODE,
    host: config.HOST,
    port: config.PORT,
    authMode: config.AUTH_MODE,
  });

  switch (config.MODE) {
    case 'standalone':
      await bootstrapStandalone(config, logger);
      return;
    case 'agent':
      throw new Error('agent mode is not yet implemented');
    case 'server':
      throw new Error('server mode is not yet implemented');
  }
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
