/**
 * zod request schemas plus the path/name sanitizers. Nothing reaches a route
 * handler unvalidated: the {@link validate} middleware parses
 * `{ body, query, params }` against these and stores the result in
 * `res.locals.validated`.
 *
 * Sanitization rules (design "Input validation and sanitization"):
 *  - process-name: /^[A-Za-z0-9._-]{1,100}$/ (rejects shell metacharacters,
 *    path separators, whitespace).
 *  - script-path: absolute, normalized, no `..`, allowed extension, exists;
 *    optionally under ALLOWED_SCRIPT_ROOT.
 *  - ecosystem-path: absolute, normalized, no `..`, exists, ecosystem extension.
 *  - create-process body: XOR script/ecosystem, instances 1..128, exec_mode
 *    enum, instances>1 ⇒ cluster (reject fork+instances>1; default cluster).
 *  - numeric query clamps for lines/limit/sinceMs/durationMin; negatives → 400.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/** Allowed script extensions (sane default; see design). */
const DEFAULT_SCRIPT_EXTS = ['.js', '.cjs', '.mjs', '.ts', '.py', '.sh'];
const ECOSYSTEM_EXTS = ['.js', '.cjs', '.config.js', '.json'];

const MAX_LINES = 2000;
const DEFAULT_LINES = 200;
const MAX_ERRORS_LIMIT = 1000;
const MAX_RECENT_LIMIT = 200;
const ONE_HOUR_MS = 60 * 60 * 1000;

export interface SchemaOptions {
  /** optional ALLOWED_SCRIPT_ROOT prefix (defense in depth). */
  allowedScriptRoot?: string | undefined;
  /** overridable extension allowlist (defaults to DEFAULT_SCRIPT_EXTS). */
  scriptExts?: string[];
  /** injectable existence check (tests). */
  fileExists?: (p: string) => boolean;
}

/** The process-name rule, reused for path params, startNew.name, rule targets. */
export const processNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,100}$/, 'invalid process name');

function hasAllowedExtension(normalized: string, exts: string[]): boolean {
  const lower = normalized.toLowerCase();
  return exts.some((e) => lower.endsWith(e));
}

/** Builds a zod string schema enforcing the script-path sanitization rule. */
function scriptPathSchema(opts: SchemaOptions): z.ZodType<string> {
  const exts = opts.scriptExts ?? DEFAULT_SCRIPT_EXTS;
  const exists = opts.fileExists ?? existsSync;
  return z.string().superRefine((value, ctx) => {
    if (!path.isAbsolute(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'script must be an absolute path' });
      return;
    }
    const normalized = path.normalize(value);
    if (normalized.split(path.sep).includes('..')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'script path must not contain ".." segments' });
      return;
    }
    if (!hasAllowedExtension(normalized, exts)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `script extension must be one of ${exts.join(', ')}`,
      });
      return;
    }
    if (opts.allowedScriptRoot) {
      const root = path.normalize(opts.allowedScriptRoot);
      const rel = path.relative(root, normalized);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'script path is outside ALLOWED_SCRIPT_ROOT' });
        return;
      }
    }
    if (!exists(normalized)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'script path does not exist' });
    }
  });
}

/** Builds a zod string schema enforcing the ecosystem-path sanitization rule. */
function ecosystemPathSchema(opts: SchemaOptions): z.ZodType<string> {
  const exists = opts.fileExists ?? existsSync;
  return z.string().superRefine((value, ctx) => {
    if (!path.isAbsolute(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ecosystem must be an absolute path' });
      return;
    }
    const normalized = path.normalize(value);
    if (normalized.split(path.sep).includes('..')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ecosystem path must not contain ".." segments' });
      return;
    }
    if (!hasAllowedExtension(normalized, ECOSYSTEM_EXTS)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `ecosystem extension must be one of ${ECOSYSTEM_EXTS.join(', ')}`,
      });
      return;
    }
    if (!exists(normalized)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ecosystem path does not exist' });
    }
  });
}

/** Non-negative integer coercion from a query string; negatives are rejected. */
const nonNegativeInt = z.coerce
  .number({ invalid_type_error: 'must be a number' })
  .int('must be an integer')
  .nonnegative('must not be negative');

/** Clamp helper for numeric query params. */
function clamp(value: number, max: number): number {
  return Math.min(max, Math.max(0, value));
}

/** The bag of schemas the route layer validates against. */
export interface RequestSchemas {
  nameParam: z.ZodTypeAny;
  createProcess: z.ZodTypeAny;
  logsRequest: z.ZodTypeAny;
  metricsRequest: z.ZodTypeAny;
  errorsQuery: z.ZodTypeAny;
  errorsExportQuery: z.ZodTypeAny;
  alertsTest: z.ZodTypeAny;
  alertsRecent: z.ZodTypeAny;
  maintenance: z.ZodTypeAny;
}

// --- parsed-shape types the handlers consume (via res.locals.validated) ---

export interface NameParams {
  params: { name: string };
}
export interface CreateProcessBody {
  body: {
    script?: string;
    ecosystem?: string;
    name?: string;
    instances?: number;
    exec_mode?: 'fork' | 'cluster';
  };
}
export interface LogsRequest {
  params: { name: string };
  query: { lines: number; stream: 'out' | 'err' | 'all'; q?: string; level?: 'info' | 'error' };
}
export interface MetricsRequest {
  params: { name: string };
  query: { sinceMs: number };
}
export interface ErrorsQuery {
  query: { name?: string; sinceMs?: number; limit: number };
}
export interface ErrorsExportQuery {
  query: { name?: string; format: 'json' | 'csv' };
}
export interface AlertsTestBody {
  body: { channel: 'teams' | 'email' | 'all' };
}
export interface AlertsRecentQuery {
  query: { limit: number };
}
export interface MaintenanceBody {
  body: { active: boolean; durationMin?: number; reason?: string };
}

/**
 * Builds the request schemas. Takes {@link SchemaOptions} so the script-path
 * rules honor ALLOWED_SCRIPT_ROOT and tests can inject a fake fileExists.
 */
export function buildSchemas(opts: SchemaOptions = {}): RequestSchemas {
  const nameParam = z.object({
    params: z.object({ name: processNameSchema }),
  });

  const createProcess = z.object({
    body: z
      .object({
        script: scriptPathSchema(opts).optional(),
        ecosystem: ecosystemPathSchema(opts).optional(),
        name: processNameSchema.optional(),
        instances: z.number().int().min(1).max(128).optional(),
        exec_mode: z.enum(['fork', 'cluster']).optional(),
      })
      .strict()
      .superRefine((body, ctx) => {
        const hasScript = body.script !== undefined;
        const hasEco = body.ecosystem !== undefined;
        if (hasScript === hasEco) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'exactly one of script or ecosystem must be provided',
          });
        }
        if ((body.instances ?? 1) > 1 && body.exec_mode === 'fork') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['exec_mode'],
            message: 'fork mode cannot run multiple instances; use cluster',
          });
        }
      })
      .transform((body) => {
        // Default cluster when instances>1 and no exec_mode given.
        if ((body.instances ?? 1) > 1 && body.exec_mode === undefined) {
          return { ...body, exec_mode: 'cluster' as const };
        }
        return body;
      }),
  });

  const logsRequest = z.object({
    params: z.object({ name: processNameSchema }),
    query: z.object({
      lines: nonNegativeInt
        .optional()
        .transform((v) => (v === undefined ? DEFAULT_LINES : clamp(v, MAX_LINES))),
      stream: z.enum(['out', 'err', 'all']).default('all'),
      q: z.string().min(1).optional(),
      level: z.enum(['info', 'error']).optional(),
    }),
  });

  const metricsRequest = z.object({
    params: z.object({ name: processNameSchema }),
    query: z.object({
      sinceMs: nonNegativeInt.optional().transform((v) => (v === undefined ? ONE_HOUR_MS : v)),
    }),
  });

  const errorsQuery = z.object({
    query: z.object({
      name: processNameSchema.optional(),
      sinceMs: nonNegativeInt.optional(),
      limit: nonNegativeInt
        .optional()
        .transform((v) => (v === undefined ? MAX_ERRORS_LIMIT : clamp(v, MAX_ERRORS_LIMIT))),
    }),
  });

  const errorsExportQuery = z.object({
    query: z.object({
      name: processNameSchema.optional(),
      format: z.enum(['json', 'csv']).default('json'),
    }),
  });

  const alertsTest = z.object({
    body: z.object({ channel: z.enum(['teams', 'email', 'all']) }).strict(),
  });

  const alertsRecent = z.object({
    query: z.object({
      limit: nonNegativeInt
        .optional()
        .transform((v) => (v === undefined ? MAX_RECENT_LIMIT : clamp(v, MAX_RECENT_LIMIT))),
    }),
  });

  const maintenance = z.object({
    body: z
      .object({
        active: z.boolean(),
        durationMin: z.number().int().positive().optional(),
        reason: z.string().min(1).max(500).optional(),
      })
      .strict(),
  });

  return {
    nameParam,
    createProcess,
    logsRequest,
    metricsRequest,
    errorsQuery,
    errorsExportQuery,
    alertsTest,
    alertsRecent,
    maintenance,
  };
}

export { MAX_LINES, DEFAULT_LINES, ONE_HOUR_MS, MAX_ERRORS_LIMIT, MAX_RECENT_LIMIT };
