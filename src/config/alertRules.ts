/**
 * Alert-rule config loader and schema.
 *
 * The authoritative TS type is derived from the zod schema
 * (`type AlertRule = z.infer<typeof alertRuleSchema>`), and `condition` is a zod
 * discriminated union over the five variants so the engine's `switch` narrows
 * correctly.
 */

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { createLogger, type Logger } from '../core/logger.js';

const processNameRule = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/, 'invalid process name');
const processSelector = z.union([z.literal('*'), processNameRule]);
const positiveInt = z.number().int().positive();

export const conditionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('errored') }).strict(),
  z.object({ type: z.literal('unexpected-stop') }).strict(),
  z
    .object({
      type: z.literal('restart-threshold'),
      count: positiveInt,
      withinMin: positiveInt,
    })
    .strict(),
  z
    .object({
      type: z.literal('cpu-threshold'),
      percent: positiveInt,
      forSec: positiveInt,
    })
    .strict(),
  z
    .object({
      type: z.literal('mem-threshold'),
      bytes: positiveInt,
      forSec: positiveInt,
    })
    .strict(),
  z
    .object({
      type: z.literal('error-spike'),
      count: positiveInt,
      withinSec: positiveInt,
    })
    .strict(),
]);

const channelsSchema = z
  .object({
    teams: z.boolean().optional(),
    email: z.boolean().optional(),
  })
  .strict()
  .refine((c) => c.teams === true || c.email === true, {
    message: 'at least one channel must be enabled',
  });

export const alertRuleSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'invalid rule id'),
    enabled: z.boolean().default(true),
    description: z.string().optional(),
    match: z
      .object({
        processes: z.array(processSelector).default(['*']),
        condition: conditionSchema,
      })
      .strict(),
    severity: z.enum(['info', 'warning', 'critical']).default('warning'),
    channels: channelsSchema,
    cooldownSec: positiveInt.optional(),
  })
  .strict();

export type AlertRule = z.infer<typeof alertRuleSchema>;

export const alertRulesFileSchema = z
  .object({
    rules: z.array(alertRuleSchema).default([]),
  })
  .strict();

/**
 * Loads the optional alert-rules JSON file.
 * - Missing file  => `[]` and a one-time warn (monitoring continues).
 * - Invalid file  => logs the zod issues and exits (an operator who wrote a
 *   rules file must know it is broken).
 */
export function loadAlertRules(path: string, logger: Logger = createLogger()): AlertRule[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      logger.warnOnce(`alert-rules-missing:${path}`, 'Alert rules file not found; continuing with no rules', {
        path,
      });
      return [];
    }
    logger.error('Failed to read alert rules file', { path, error: String(err) });
    process.exit(1);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    logger.error('Alert rules file is not valid JSON', { path, error: String(err) });
    process.exit(1);
  }

  const result = alertRulesFileSchema.safeParse(json);
  if (!result.success) {
    logger.error('Invalid alert rules file', {
      path,
      issues: result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
    process.exit(1);
  }
  return result.data.rules;
}
