/**
 * Environment configuration loader.
 *
 * `loadConfig()` runs dotenv then parses `process.env` through a zod schema into
 * a typed, frozen {@link AppConfig}. On a validation error it logs the
 * aggregated zod issues and exits with code 1 — a misconfigured server must not
 * start. The pure {@link parseConfig} is exported separately so tests can
 * exercise the schema without triggering process.exit.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';
import { createLogger, type Logger } from '../core/logger.js';

/** Coerces common truthy/falsy string spellings to a boolean. */
const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) => {
    if (typeof v === 'boolean') return v;
    return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
  });

/** Coerces a string env var to a finite number. */
const numeric = z.coerce.number();

export const configSchema = z
  .object({
    PORT: numeric.int().min(1).max(65535).default(3000),
    HOST: z.string().min(1).default('127.0.0.1'),

    AUTH_MODE: z.enum(['apikey', 'basic']).default('apikey'),
    API_KEY: z.string().min(1).optional(),
    BASIC_USER: z.string().min(1).optional(),
    BASIC_PASS: z.string().min(1).optional(),

    SMTP_HOST: z.string().min(1).optional(),
    SMTP_PORT: numeric.int().min(1).max(65535).default(587),
    SMTP_SECURE: booleanish.default(false),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASS: z.string().min(1).optional(),
    MAIL_FROM: z.string().min(1).optional(),
    MAIL_TO: z.string().min(1).optional(),

    TEAMS_WEBHOOK_URL: z.string().url().optional(),

    ALERT_RULES_FILE: z.string().min(1).default('config/alert-rules.json'),

    METRICS_RETENTION_MIN: numeric.int().positive().default(180),
    METRICS_SAMPLE_SEC: numeric.int().positive().default(5),

    ERROR_BUFFER_SIZE: numeric.int().positive().default(500),
    ERROR_LOG_APPEND: booleanish.default(false),

    DEFAULT_COOLDOWN_SEC: numeric.int().positive().default(300),
    INTENTIONAL_ACTION_GRACE_MS: numeric.int().positive().default(10000),
    ALLOWED_SCRIPT_ROOT: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z.string().min(1).optional(),
    ),

    DIGEST_ENABLED: booleanish.default(false),
    DIGEST_HOUR: numeric.int().min(0).max(23).default(8),

    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

    // --- multi-instance (hub-and-spoke) mode ---
    MODE: z.enum(['standalone', 'agent', 'server']).default('standalone'),

    // agent-only
    SERVER_URL: z.string().url().optional(),
    AGENT_TOKEN: z.string().min(1).optional(),
    AGENT_NAME: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z.string().min(1).optional(),
    ),
    AGENT_ID_FILE: z.string().min(1).default('config/agent-id'),
    AGENT_WS_PATH: z.string().startsWith('/').default('/agent'),
    TLS_INSECURE: booleanish.default(false),

    // server-only
    AGENT_TOKENS: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z.string().min(1).optional(),
    ),
    ALIAS_STORE_FILE: z.string().min(1).default('config/agent-aliases.json'),
    TLS_CERT_FILE: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z.string().min(1).optional(),
    ),
    TLS_KEY_FILE: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z.string().min(1).optional(),
    ),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.AUTH_MODE === 'apikey' && !cfg.API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['API_KEY'],
        message: 'API_KEY is required when AUTH_MODE=apikey',
      });
    }
    if (cfg.AUTH_MODE === 'basic') {
      if (!cfg.BASIC_USER) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['BASIC_USER'],
          message: 'BASIC_USER is required when AUTH_MODE=basic',
        });
      }
      if (!cfg.BASIC_PASS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['BASIC_PASS'],
          message: 'BASIC_PASS is required when AUTH_MODE=basic',
        });
      }
    }

    // Email channel group: if any SMTP/mail field is set, require the full set.
    const emailFields = [
      cfg.SMTP_HOST,
      cfg.SMTP_USER,
      cfg.SMTP_PASS,
      cfg.MAIL_FROM,
      cfg.MAIL_TO,
    ];
    const emailTouched = emailFields.some((v) => v !== undefined);
    if (emailTouched) {
      const required: Array<[keyof typeof cfg, unknown]> = [
        ['SMTP_HOST', cfg.SMTP_HOST],
        ['SMTP_USER', cfg.SMTP_USER],
        ['SMTP_PASS', cfg.SMTP_PASS],
        ['MAIL_FROM', cfg.MAIL_FROM],
        ['MAIL_TO', cfg.MAIL_TO],
      ];
      for (const [key, value] of required) {
        if (value === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key as string],
            message: `${String(key)} is required when the email channel is configured`,
          });
        }
      }
    }

    // --- multi-instance mode cross-field guards ---
    // Agent mode needs a server to dial and a credential to present.
    if (cfg.MODE === 'agent') {
      if (!cfg.SERVER_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SERVER_URL'],
          message: 'SERVER_URL is required when MODE=agent',
        });
      }
      if (!cfg.AGENT_TOKEN) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['AGENT_TOKEN'],
          message: 'AGENT_TOKEN is required when MODE=agent',
        });
      }
    }

    // When present, SERVER_URL must be a WebSocket URL (ws:// or wss://).
    if (cfg.SERVER_URL && !/^wss?:\/\//i.test(cfg.SERVER_URL)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SERVER_URL'],
        message: 'SERVER_URL must start with ws:// or wss://',
      });
    }

    // Server mode needs at least one accepted agent token.
    if (cfg.MODE === 'server' && !cfg.AGENT_TOKENS && !cfg.AGENT_TOKEN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AGENT_TOKENS'],
        message: 'MODE=server requires AGENT_TOKENS or AGENT_TOKEN',
      });
    }

    // Native TLS needs the full cert+key pair; exactly one set is a misconfig.
    // Neither set is valid (reverse-proxy TLS termination).
    const hasCert = cfg.TLS_CERT_FILE !== undefined;
    const hasKey = cfg.TLS_KEY_FILE !== undefined;
    if (hasCert !== hasKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TLS_CERT_FILE'],
        message: 'TLS_CERT_FILE and TLS_KEY_FILE must be set together',
      });
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TLS_KEY_FILE'],
        message: 'TLS_CERT_FILE and TLS_KEY_FILE must be set together',
      });
    }

    // The agent-facing WS path must not collide with the human /ws path.
    if (cfg.MODE === 'server' && cfg.AGENT_WS_PATH === '/ws') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AGENT_WS_PATH'],
        message: 'AGENT_WS_PATH must not collide with the human /ws path',
      });
    }
  });

export type AppConfig = z.infer<typeof configSchema>;

/**
 * Pure parse of an env-like record. Returns a zod SafeParseReturn so callers
 * decide how to react to failure (tests inspect issues; loadConfig exits).
 */
export function parseConfig(env: NodeJS.ProcessEnv): z.SafeParseReturnType<unknown, AppConfig> {
  return configSchema.safeParse(env);
}

/**
 * Loads, validates, and freezes the application config. Exits the process with
 * code 1 on invalid env after logging the aggregated zod issues.
 */
export function loadConfig(logger: Logger = createLogger()): Readonly<AppConfig> {
  // Resolve the project-root .env from this module so hand-run, PM2, and
  // systemd all read the same file regardless of process.cwd(). From both
  // dist/config/env.js and src/config/env.ts, '../..' is the project root.
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const envPath = path.resolve(moduleDir, '..', '..', '.env');
  if (existsSync(envPath)) {
    dotenv.config({ path: envPath });
  } else {
    dotenv.config();
  }
  const result = parseConfig(process.env);
  if (!result.success) {
    logger.error('Invalid environment configuration', {
      issues: result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
    process.exit(1);
  }
  return Object.freeze(result.data);
}
