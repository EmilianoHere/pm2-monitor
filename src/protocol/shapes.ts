/**
 * Zod mirror schemas for the internal data-model shapes that travel on the
 * wire. These are *schemas*, not new types: each is pinned with a compile-time
 * type-equality assertion against the existing interface in
 * `src/core/types.ts` (and `ControlResult` from `src/pm2/client.ts`), so the
 * inferred types stay assignable to the existing interfaces. If an interface
 * drifts from its schema, the `AssertEqual` lines below stop compiling.
 */

import { z } from 'zod';
import type {
  ProcessSnapshot,
  MetricSample,
  LogLine,
  TrackedError,
  ProcStatus,
} from '../core/types.js';
import type { ProcessTransitionEvent } from '../core/events.js';
import type { ControlResult } from '../pm2/client.js';

// --- compile-time type-equality helper ---
// Resolves to `true` only when A and B are mutually assignable; any other
// result is `false`, which `AssertEqual` then rejects at compile time.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type AssertEqual<_T extends true> = never;

// --- reusable field schemas ---

export const procStatusSchema = z.enum([
  'online',
  'stopping',
  'stopped',
  'launching',
  'errored',
  'one-launch-status',
  'unknown',
]);
// Pin the status enum against the ProcStatus union.
type _StatusEq = AssertEqual<Equal<z.infer<typeof procStatusSchema>, ProcStatus>>;

/**
 * Agent-id charset: identical to processNameSchema (safe wire/log charset,
 * 1–100 chars). Exported for reuse by the protocol messages and the server.
 */
export const agentIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,100}$/, 'invalid agent id');

// --- mirror schemas ---

export const processSnapshotSchema = z.object({
  pmId: z.number(),
  name: z.string(),
  pid: z.number().nullable(),
  status: procStatusSchema,
  cpu: z.number(),
  memory: z.number(),
  uptimeMs: z.number().nullable(),
  restarts: z.number(),
  unstableRestarts: z.number(),
  mode: z.enum(['fork', 'cluster']),
  instances: z.number(),
  execPath: z.string().nullable(),
  lastUpdated: z.number(),
});
type _ProcessSnapshotEq = AssertEqual<
  Equal<z.infer<typeof processSnapshotSchema>, ProcessSnapshot>
>;

export const metricSampleSchema = z.object({
  ts: z.number(),
  cpu: z.number(),
  mem: z.number(),
});
type _MetricSampleEq = AssertEqual<Equal<z.infer<typeof metricSampleSchema>, MetricSample>>;

export const logLineSchema = z.object({
  stream: z.enum(['out', 'err']),
  level: z.enum(['info', 'error']),
  line: z.string(),
  ts: z.number(),
});
type _LogLineEq = AssertEqual<Equal<z.infer<typeof logLineSchema>, LogLine>>;

export const trackedErrorSchema = z.object({
  signature: z.string(),
  processName: z.string(),
  firstSeen: z.number(),
  lastSeen: z.number(),
  count: z.number(),
  level: z.enum(['error', 'crash', 'restart']),
  intentional: z.boolean().optional(),
  message: z.string(),
  sample: z.string(),
});
type _TrackedErrorEq = AssertEqual<Equal<z.infer<typeof trackedErrorSchema>, TrackedError>>;

/** The process-transition shape ({ name, from, to, at }). */
export const transitionSchema = z.object({
  name: z.string(),
  from: procStatusSchema,
  to: procStatusSchema,
  at: z.number(),
});
type _TransitionEq = AssertEqual<Equal<z.infer<typeof transitionSchema>, ProcessTransitionEvent>>;

/** ControlResult discriminated union (mirrors src/pm2/client.ts). */
export const controlResultSchema = z.union([
  z.object({ ok: z.literal(true), process: processSnapshotSchema }),
  z.object({ ok: z.literal(false), code: z.string(), message: z.string() }),
]);
type _ControlResultEq = AssertEqual<Equal<z.infer<typeof controlResultSchema>, ControlResult>>;
