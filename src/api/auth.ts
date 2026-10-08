/**
 * Authentication: a single length-guarded constant-time comparator used by BOTH
 * the REST auth middleware and the WS upgrade handler.
 *
 * `crypto.timingSafeEqual(a, b)` throws a synchronous RangeError when the two
 * buffers differ in length. Comparing a client-supplied credential of arbitrary
 * length directly against the secret would therefore throw on any length
 * mismatch — a 500 on the REST path and, far worse, an uncaught throw inside
 * `server.on('upgrade')` on the WS path (no Express error handler there), which
 * the entry point treats as an uncaughtException. `safeEqual` sha256-hashes each
 * side to a fixed 32-byte digest so the two buffers are always equal length,
 * then calls `timingSafeEqual` — it can never throw and always returns a
 * boolean. It is the ONLY credential comparison in the codebase.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Fixed-length-digest comparison: never throws on unequal/empty/malformed input.
 * Returns false (→ 401) for any mismatch; constant-time w.r.t. the real secret.
 * The sha256 pre-hash is not a secrecy measure — it is purely the
 * length-normalization that makes `timingSafeEqual` safe to call.
 */
export function safeEqual(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided ?? '').digest(); // 32 bytes
  const b = createHash('sha256').update(expected ?? '').digest(); // 32 bytes
  return timingSafeEqual(a, b);
}

export type AuthConfig =
  | { mode: 'apikey'; apiKey: string }
  | { mode: 'basic'; user: string; pass: string };

interface ApiError extends Error {
  statusCode?: number;
  code?: string;
}

function unauthorized(res: Response, mode: AuthConfig['mode']): void {
  if (mode === 'basic') {
    res.setHeader('WWW-Authenticate', 'Basic realm="pm2-monitor"');
  }
  res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid credentials' } });
}

/** Extracts the api-key credential from X-API-Key or Authorization: Bearer. */
function extractApiKey(req: Request): string {
  const header = req.header('x-api-key');
  if (typeof header === 'string' && header.length > 0) return header;
  const auth = req.header('authorization');
  if (typeof auth === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match) return match[1];
  }
  return '';
}

/** Decodes Authorization: Basic into {user, pass}; empty strings on failure. */
function extractBasic(req: Request): { user: string; pass: string } {
  const auth = req.header('authorization');
  if (typeof auth !== 'string') return { user: '', pass: '' };
  const match = /^Basic\s+(.+)$/i.exec(auth.trim());
  if (!match) return { user: '', pass: '' };
  let decoded = '';
  try {
    decoded = Buffer.from(match[1], 'base64').toString('utf8');
  } catch {
    return { user: '', pass: '' };
  }
  const idx = decoded.indexOf(':');
  if (idx === -1) return { user: decoded, pass: '' };
  return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
}

/**
 * Builds the Express auth middleware for the configured mode. Every comparison
 * goes through `safeEqual`, so no length mismatch can throw.
 */
export function createAuthMiddleware(config: AuthConfig) {
  return function auth(req: Request, res: Response, next: NextFunction): void {
    if (config.mode === 'apikey') {
      const provided = extractApiKey(req);
      if (provided.length > 0 && safeEqual(provided, config.apiKey)) {
        next();
        return;
      }
      unauthorized(res, 'apikey');
      return;
    }
    // basic mode — both user AND pass must pass, each a safeEqual call.
    const { user, pass } = extractBasic(req);
    const userOk = safeEqual(user, config.user);
    const passOk = safeEqual(pass, config.pass);
    if (userOk && passOk) {
      next();
      return;
    }
    unauthorized(res, 'basic');
  };
}

/**
 * Validates a raw WS-upgrade credential against the configured auth, reusing the
 * same `safeEqual`. For apikey mode the credential is the key; for basic mode it
 * is a base64 of `user:pass` (so the browser's single subprotocol code path
 * serves both modes). Never throws.
 */
export function validateWsCredential(config: AuthConfig, credential: string): boolean {
  if (typeof credential !== 'string' || credential.length === 0) return false;
  if (config.mode === 'apikey') {
    return safeEqual(credential, config.apiKey);
  }
  let decoded = '';
  try {
    decoded = Buffer.from(credential, 'base64').toString('utf8');
  } catch {
    return false;
  }
  const idx = decoded.indexOf(':');
  const user = idx === -1 ? decoded : decoded.slice(0, idx);
  const pass = idx === -1 ? '' : decoded.slice(idx + 1);
  return safeEqual(user, config.user) && safeEqual(pass, config.pass);
}

/** Helper to construct a typed API error carrying an HTTP status + envelope code. */
export function apiError(statusCode: number, code: string, message: string): ApiError {
  const err: ApiError = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}
