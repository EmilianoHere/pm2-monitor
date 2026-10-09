/**
 * Wire codec. `encode` serializes a typed frame; `decode` parses and validates
 * raw text and NEVER throws — a JSON parse failure or a schema validation
 * failure returns a `BAD_MESSAGE` result the caller answers with an
 * `error:frame`. This mirrors the throw-safe handleMessage pattern in
 * `src/ws/hub.ts`.
 */

import { protocolMessageSchema, type ProtocolMessage } from './messages.js';

export type DecodeResult =
  | { ok: true; msg: ProtocolMessage }
  | { ok: false; code: 'BAD_MESSAGE'; message: string };

/** Serializes a typed frame to its wire string. */
export function encode(msg: ProtocolMessage): string {
  return JSON.stringify(msg);
}

/** Parses + validates a wire string. Never throws. */
export function decode(raw: string): DecodeResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { ok: false, code: 'BAD_MESSAGE', message: `invalid JSON: ${String(err)}` };
  }
  const result = protocolMessageSchema.safeParse(json);
  if (!result.success) {
    const message = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    return { ok: false, code: 'BAD_MESSAGE', message: message || 'invalid message' };
  }
  return { ok: true, msg: result.data };
}
