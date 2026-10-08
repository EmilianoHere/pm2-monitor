/**
 * Environment configuration loader.
 *
 * `loadConfig()` runs dotenv then parses `process.env` through a zod schema into
 * a typed, frozen {@link AppConfig}. On a validation error it logs the
 * aggregated zod issues and exits with code 1 — a misconfigured server must not
 * start. The pure {@link parseConfig} is exported separately so tests can
 * exercise the schema without triggering process.exit.
 */

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
    ALLOWED_SCRIPT_ROOT: z.string().min(1).optional(),

    DIGEST_ENABLED: booleanish.default(false),
    DIGEST_HOUR: numeric.int().min(0).max(23).default(8),

    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
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
  dotenv.config();
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
