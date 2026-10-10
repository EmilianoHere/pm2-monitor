import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NextFunction, Request, Response } from 'express';
import {
  createAuthMiddleware,
  safeEqual,
  validateWsCredential,
  type AuthConfig,
} from './auth.js';

// --- safeEqual: never throws, correct truth value ---

test('safeEqual returns true only for an exact match', () => {
  assert.equal(safeEqual('secret', 'secret'), true);
  assert.equal(safeEqual('secret', 'Secret'), false);
  assert.equal(safeEqual('secret', 'secre'), false);
});

test('safeEqual never throws on empty, wrong-length, or malformed input', () => {
  assert.doesNotThrow(() => safeEqual('', ''));
  assert.doesNotThrow(() => safeEqual('short', 'a-much-longer-expected-value'));
  // @ts-expect-error exercising runtime coercion of a non-string
  assert.doesNotThrow(() => safeEqual(undefined, 'x'));
  assert.equal(safeEqual('', 'nonempty'), false);
  assert.equal(safeEqual('', ''), true);
});

// --- middleware helpers ---

interface MockRes {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  locals: Record<string, unknown>;
  status(code: number): MockRes;
  json(payload: unknown): MockRes;
  setHeader(name: string, value: string): void;
}

function mockReq(headers: Record<string, string>): Request {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    header: (name: string) => lower[name.toLowerCase()],
  } as unknown as Request;
}

function mockRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    headers: {},
    body: undefined,
    locals: {},
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
  };
  return res;
}

function run(config: AuthConfig, req: Request): { res: MockRes; nextCalled: boolean } {
  const mw = createAuthMiddleware(config);
  const res = mockRes();
  let nextCalled = false;
  const next: NextFunction = () => {
    nextCalled = true;
  };
  mw(req, res as unknown as Response, next);
  return { res, nextCalled };
}

// --- apikey mode ---

test('apikey mode: X-API-Key match calls next', () => {
  const { nextCalled, res } = run({ mode: 'apikey', apiKey: 'k' }, mockReq({ 'X-API-Key': 'k' }));
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
});

test('apikey mode: Bearer token match calls next', () => {
  const { nextCalled } = run({ mode: 'apikey', apiKey: 'k' }, mockReq({ Authorization: 'Bearer k' }));
  assert.equal(nextCalled, true);
});

test('apikey mode: wrong key is 401 UNAUTHORIZED', () => {
  const { nextCalled, res } = run({ mode: 'apikey', apiKey: 'k' }, mockReq({ 'X-API-Key': 'nope' }));
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.deepEqual((res.body as { error: { code: string } }).error.code, 'UNAUTHORIZED');
});

test('apikey mode: missing credential is 401 and does not throw', () => {
  const { res } = run({ mode: 'apikey', apiKey: 'k' }, mockReq({}));
  assert.equal(res.statusCode, 401);
});

// --- basic mode ---

function basicHeader(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

test('basic mode: both user and pass must match', () => {
  const cfg: AuthConfig = { mode: 'basic', user: 'u', pass: 'p' };
  assert.equal(run(cfg, mockReq({ Authorization: basicHeader('u', 'p') })).nextCalled, true);
  assert.equal(run(cfg, mockReq({ Authorization: basicHeader('u', 'wrong') })).nextCalled, false);
  assert.equal(run(cfg, mockReq({ Authorization: basicHeader('wrong', 'p') })).nextCalled, false);
});

test('basic mode: 401 sets WWW-Authenticate', () => {
  const { res } = run({ mode: 'basic', user: 'u', pass: 'p' }, mockReq({}));
  assert.equal(res.statusCode, 401);
  assert.ok(res.headers['WWW-Authenticate']);
});

// --- WS credential validation reuses safeEqual ---

test('validateWsCredential: apikey mode matches the key', () => {
  const cfg: AuthConfig = { mode: 'apikey', apiKey: 'k' };
  assert.equal(validateWsCredential(cfg, 'k').ok, true);
  assert.equal(validateWsCredential(cfg, 'nope').ok, false);
  assert.equal(validateWsCredential(cfg, '').ok, false);
});

test('validateWsCredential: basic mode decodes base64 user:pass', () => {
  const cfg: AuthConfig = { mode: 'basic', user: 'u', pass: 'p' };
  const good = Buffer.from('u:p').toString('base64');
  const bad = Buffer.from('u:x').toString('base64');
  assert.equal(validateWsCredential(cfg, good).ok, true);
  assert.equal(validateWsCredential(cfg, bad).ok, false);
});

test('validateWsCredential never throws on malformed input', () => {
  const cfg: AuthConfig = { mode: 'apikey', apiKey: 'k' };
  assert.doesNotThrow(() => validateWsCredential(cfg, '%%%not-base64%%%'));
});

// --- isMaster + secondary-key verification (design §1.3) ---

import { createHash } from 'node:crypto';
import { requireMaster, type KeyVerifier } from './auth.js';

const sha256hex = (s: string): string => createHash('sha256').update(s).digest('hex');

/** A fake KeyVerifier returning fixed sha256hex digests of raw keys. */
function fakeKeys(...rawKeys: string[]): KeyVerifier {
  const hashes = rawKeys.map(sha256hex);
  return { activeHashes: () => hashes };
}

function runWithKeys(
  config: AuthConfig,
  req: Request,
  keys?: KeyVerifier,
): { res: MockRes; nextCalled: boolean } {
  const mw = createAuthMiddleware(config, keys);
  const res = mockRes();
  let nextCalled = false;
  const next: NextFunction = () => {
    nextCalled = true;
  };
  mw(req, res as unknown as Response, next);
  return { res, nextCalled };
}

test('apikey: master key authenticates and marks isMaster:true (AC-1,6)', () => {
  const keys = fakeKeys('secondary-raw');
  const { res, nextCalled } = runWithKeys(
    { mode: 'apikey', apiKey: 'master' },
    mockReq({ 'X-API-Key': 'master' }),
    keys,
  );
  assert.equal(nextCalled, true);
  assert.deepEqual((res as unknown as { locals: { auth: { isMaster: boolean } } }).locals.auth, {
    isMaster: true,
  });
});

test('apikey: active secondary authenticates with isMaster:false (AC-2)', () => {
  const keys = fakeKeys('secondary-raw');
  const res = mockRes() as unknown as Response & { locals: { auth?: { isMaster: boolean } } };
  const mw = createAuthMiddleware({ mode: 'apikey', apiKey: 'master' }, keys);
  let nextCalled = false;
  mw(mockReq({ 'X-API-Key': 'secondary-raw' }), res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
  assert.deepEqual(res.locals.auth, { isMaster: false });
});

test('apikey: a revoked key (absent from activeHashes) is rejected (AC-3,4)', () => {
  // Only 'live-raw' is active; 'revoked-raw' is not in the set.
  const keys = fakeKeys('live-raw');
  const { nextCalled, res } = runWithKeys(
    { mode: 'apikey', apiKey: 'master' },
    mockReq({ 'X-API-Key': 'revoked-raw' }),
    keys,
  );
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('apikey: master still authenticates with an empty/undefined key set (AC-5)', () => {
  assert.equal(
    runWithKeys({ mode: 'apikey', apiKey: 'master' }, mockReq({ 'X-API-Key': 'master' })).nextCalled,
    true,
  );
  assert.equal(
    runWithKeys({ mode: 'apikey', apiKey: 'master' }, mockReq({ 'X-API-Key': 'master' }), fakeKeys())
      .nextCalled,
    true,
  );
});

test('apikey: candidate iteration never throws across odd inputs (AC-9)', () => {
  const keys = fakeKeys('a', 'bb', 'ccc');
  assert.doesNotThrow(() => runWithKeys({ mode: 'apikey', apiKey: 'master' }, mockReq({}), keys));
  assert.doesNotThrow(() =>
    runWithKeys({ mode: 'apikey', apiKey: 'master' }, mockReq({ 'X-API-Key': 'x'.repeat(999) }), keys),
  );
});

test('basic mode: caller is master, a secondary key does not authenticate (AC-10)', () => {
  const cfg: AuthConfig = { mode: 'basic', user: 'u', pass: 'p' };
  const keys = fakeKeys('secondary-raw');
  // Only an api-key header, no basic header -> 401 even with an active key.
  assert.equal(runWithKeys(cfg, mockReq({ 'X-API-Key': 'secondary-raw' }), keys).nextCalled, false);
  // Valid basic -> master.
  const ok = runWithKeys(cfg, mockReq({ Authorization: basicHeader('u', 'p') }), keys);
  assert.equal(ok.nextCalled, true);
  assert.deepEqual((ok.res as unknown as { locals: { auth: { isMaster: boolean } } }).locals.auth, {
    isMaster: true,
  });
});

test('validateWsCredential: active secondary authenticates a WS upgrade', () => {
  const cfg: AuthConfig = { mode: 'apikey', apiKey: 'master' };
  const keys = fakeKeys('secondary-raw');
  assert.equal(validateWsCredential(cfg, 'secondary-raw', keys).ok, true);
  assert.equal(validateWsCredential(cfg, 'secondary-raw', keys).isMaster, false);
  assert.equal(validateWsCredential(cfg, 'master', keys).isMaster, true);
});

// --- requireMaster guard (AC-7) ---

function guardWith(authLocals: { isMaster: boolean } | undefined): { res: MockRes; nextCalled: boolean } {
  const res = mockRes() as MockRes & { locals: Record<string, unknown> };
  res.locals = authLocals ? { auth: authLocals } : {};
  let nextCalled = false;
  requireMaster({} as Request, res as unknown as Response, () => {
    nextCalled = true;
  });
  return { res, nextCalled };
}

test('requireMaster: master -> next; secondary -> 403; missing -> 403 (AC-7)', () => {
  assert.equal(guardWith({ isMaster: true }).nextCalled, true);

  const secondary = guardWith({ isMaster: false });
  assert.equal(secondary.nextCalled, false);
  assert.equal(secondary.res.statusCode, 403);
  assert.equal((secondary.res.body as { error: { code: string } }).error.code, 'FORBIDDEN');

  const missing = guardWith(undefined);
  assert.equal(missing.nextCalled, false);
  assert.equal(missing.res.statusCode, 403);
});
