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

/** The outcome of an auth check: whether it passed and whether it was master. */
export interface AuthResult {
  ok: boolean;
  isMaster: boolean;
}

/**
 * The pure, synchronous key-set reader auth consults for secondary keys. Backed
 * by the ApiKeyStore's in-memory active-hash set, so auth never awaits fs.
 */
export interface KeyVerifier {
  /** sha-256 hex digests of every ACTIVE key currently in the store. */
  activeHashes(): readonly string[];
}

/** sha-256 hex digest helper (matches the ApiKeyStore at-rest representation). */
function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * The constant-time, throw-safe apikey verification algorithm (design §1.3).
 * Master is checked against `config.apiKey` (`.env`), independent of the key
 * store, so a corrupt/missing store never removes it (anti-lockout). Secondary
 * keys are compared with a NON-short-circuiting OR over every active hash (no
 * `break`), so timing never reveals which candidate matched and the loop can
 * never throw (every comparison is `safeEqual`).
 */
function verifyApiKey(provided: string, apiKey: string, keys?: KeyVerifier): AuthResult {
  const master = provided.length > 0 && safeEqual(provided, apiKey);
  const providedHash = sha256hex(provided);
  let secondary = false;
  for (const h of keys?.activeHashes() ?? []) {
    secondary = safeEqual(providedHash, h) || secondary;
  }
  const ok = master || secondary;
  return { ok, isMaster: master };
}

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
export function createAuthMiddleware(config: AuthConfig, keys?: KeyVerifier) {
  return function auth(req: Request, res: Response, next: NextFunction): void {
    if (config.mode === 'apikey') {
      const provided = extractApiKey(req);
      const result = verifyApiKey(provided, config.apiKey, keys);
      if (result.ok) {
        res.locals.auth = { isMaster: result.isMaster };
        next();
        return;
      }
      unauthorized(res, 'apikey');
      return;
    }
    // basic mode — both user AND pass must pass, each a safeEqual call.
    // Secondary keys are inert as credentials in basic mode (ignore `keys`); a
    // basic-authenticated caller is always master.
    const { user, pass } = extractBasic(req);
    const userOk = safeEqual(user, config.user);
    const passOk = safeEqual(pass, config.pass);
    if (userOk && passOk) {
      res.locals.auth = { isMaster: true };
      next();
      return;
    }
    unauthorized(res, 'basic');
  };
}

/**
 * Master-only guard mounted AFTER the global `/api` auth middleware, so an
 * unauthenticated request is already 401 before this runs; a valid secondary
 * key reaches here and gets 403. Reads the `isMaster` signal auth wrote to
 * `res.locals.auth`.
 */
export function requireMaster(_req: Request, res: Response, next: NextFunction): void {
  if (res.locals.auth?.isMaster === true) {
    next();
    return;
  }
  res.status(403).json({ error: { code: 'FORBIDDEN', message: 'master credential required' } });
}

/**
 * Validates a raw WS-upgrade credential against the configured auth, reusing the
 * same `safeEqual`. For apikey mode the credential is the key; for basic mode it
 * is a base64 of `user:pass` (so the browser's single subprotocol code path
 * serves both modes). Never throws.
 */
export function validateWsCredential(config: AuthConfig, credential: string, keys?: KeyVerifier): AuthResult {
  if (typeof credential !== 'string' || credential.length === 0) return { ok: false, isMaster: false };
  if (config.mode === 'apikey') {
    return verifyApiKey(credential, config.apiKey, keys);
  }
  let decoded = '';
  try {
    decoded = Buffer.from(credential, 'base64').toString('utf8');
  } catch {
    return { ok: false, isMaster: false };
  }
  const idx = decoded.indexOf(':');
  const user = idx === -1 ? decoded : decoded.slice(0, idx);
  const pass = idx === -1 ? '' : decoded.slice(idx + 1);
  const ok = safeEqual(user, config.user) && safeEqual(pass, config.pass);
  return { ok, isMaster: ok };
}

/** Helper to construct a typed API error carrying an HTTP status + envelope code. */
export function apiError(statusCode: number, code: string, message: string): ApiError {
  const err: ApiError = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}
