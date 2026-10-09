/**
 * The wire message contract: a single zod discriminated union over `type`
 * covering every frame exchanged between an agent and the server. Payloads
 * reuse the mirror schemas in `./shapes.js` so the on-wire shapes stay pinned
 * to the internal data model. The inferred {@link ProtocolMessage} is the one
 * type both runtimes import.
 *
 * Direction legend (documented per frame): A->S agent->server, S->A server->agent.
 */

import { z } from 'zod';
import {
  agentIdSchema,
  processSnapshotSchema,
  metricSampleSchema,
  logLineSchema,
  trackedErrorSchema,
  transitionSchema,
  controlResultSchema,
} from './shapes.js';

/** StartNewOpts mirror (src/pm2/client.ts) for control:createRequest. */
const startNewOptsSchema = z.object({
  script: z.string().optional(),
  ecosystem: z.string().optional(),
  name: z.string().optional(),
  instances: z.number().optional(),
  exec_mode: z.enum(['fork', 'cluster']).optional(),
});

const controlActionSchema = z.enum(['start', 'stop', 'restart', 'reload', 'delete']);

// --- handshake ---

export const registerSchema = z.object({
  type: z.literal('register'),
  protocolVersion: z.number(),
  agentId: agentIdSchema,
  token: z.string().min(1),
  meta: z.object({
    hostname: z.string(),
    platform: z.string(),
    pm2Version: z.string().optional(),
    monitorVersion: z.string(),
    nameHint: z.string().optional(),
  }),
});

export const registerAckSchema = z.object({
  type: z.literal('register:ack'),
  ok: z.literal(true),
  serverTime: z.number(),
  heartbeatSec: z.number(),
});

export const registerNackSchema = z.object({
  type: z.literal('register:nack'),
  ok: z.literal(false),
  code: z.enum(['AUTH_FAILED', 'VERSION_MISMATCH']),
  message: z.string(),
});

// --- liveness ---

export const heartbeatSchema = z.object({
  type: z.literal('heartbeat'),
  ts: z.number(),
});

export const heartbeatAckSchema = z.object({
  type: z.literal('heartbeat:ack'),
  ts: z.number(),
});

// --- state (A->S) ---

export const snapshotSchema = z.object({
  type: z.literal('snapshot'),
  processes: z.array(processSnapshotSchema),
  pm2Connected: z.boolean(),
  generatedAt: z.number(),
});

export const updateTransitionSchema = transitionSchema.extend({
  type: z.literal('update:transition'),
});

export const updateMetricsSchema = z.object({
  type: z.literal('update:metrics'),
  samples: z.array(metricSampleSchema.extend({ name: z.string() })),
});

export const updateErrorSchema = z.object({
  type: z.literal('update:error'),
  error: trackedErrorSchema,
});

export const updatePm2Schema = z.object({
  type: z.literal('update:pm2'),
  connected: z.boolean(),
});

// --- control (S->A requests, A->S responses) ---

export const controlRequestSchema = z.object({
  type: z.literal('control:request'),
  cid: z.string(),
  action: controlActionSchema,
  name: z.string(),
});

export const controlCreateRequestSchema = z.object({
  type: z.literal('control:createRequest'),
  cid: z.string(),
  opts: startNewOptsSchema,
});

export const controlResponseSchema = z.object({
  type: z.literal('control:response'),
  cid: z.string(),
  result: controlResultSchema,
});

// --- logs ---

export const logSubscribeSchema = z.object({
  type: z.literal('log:subscribe'),
  process: z.string(),
  streams: z.array(z.enum(['out', 'err'])),
});

export const logUnsubscribeSchema = z.object({
  type: z.literal('log:unsubscribe'),
  process: z.string(),
});

export const logLineFrameSchema = logLineSchema.extend({
  type: z.literal('log:line'),
  process: z.string(),
});

// --- error frame (both directions) ---

export const errorFrameSchema = z.object({
  type: z.literal('error:frame'),
  code: z.literal('BAD_MESSAGE'),
  message: z.string(),
});

/** The discriminated union over every frame `type`. */
export const protocolMessageSchema = z.discriminatedUnion('type', [
  registerSchema,
  registerAckSchema,
  registerNackSchema,
  heartbeatSchema,
  heartbeatAckSchema,
  snapshotSchema,
  updateTransitionSchema,
  updateMetricsSchema,
  updateErrorSchema,
  updatePm2Schema,
  controlRequestSchema,
  controlCreateRequestSchema,
  controlResponseSchema,
  logSubscribeSchema,
  logUnsubscribeSchema,
  logLineFrameSchema,
  errorFrameSchema,
]);

export type ProtocolMessage = z.infer<typeof protocolMessageSchema>;
