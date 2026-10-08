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
  assert.equal(validateWsCredential(cfg, 'k'), true);
  assert.equal(validateWsCredential(cfg, 'nope'), false);
  assert.equal(validateWsCredential(cfg, ''), false);
});

test('validateWsCredential: basic mode decodes base64 user:pass', () => {
  const cfg: AuthConfig = { mode: 'basic', user: 'u', pass: 'p' };
  const good = Buffer.from('u:p').toString('base64');
  const bad = Buffer.from('u:x').toString('base64');
  assert.equal(validateWsCredential(cfg, good), true);
  assert.equal(validateWsCredential(cfg, bad), false);
});

test('validateWsCredential never throws on malformed input', () => {
  const cfg: AuthConfig = { mode: 'apikey', apiKey: 'k' };
  assert.doesNotThrow(() => validateWsCredential(cfg, '%%%not-base64%%%'));
});
