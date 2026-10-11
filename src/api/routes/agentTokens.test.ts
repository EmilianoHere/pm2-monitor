import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createAgentTokensRouter } from './agentTokens.js';
import { requireMaster } from '../auth.js';
import { AgentTokenStore, AgentTokenService } from '../../server/agentTokenStore.js';
import { createLogger } from '../../core/logger.js';

const silent = createLogger({ level: 'error', sink: () => {} });

function makeService(): AgentTokenService {
  const store = new AgentTokenStore({
    file: '/tmp/none-agent-tokens.json',
    logger: silent,
    readFile: async () => {
      throw new Error('ENOENT');
    },
    writeFile: async () => {},
    rename: async () => {},
    chmod: async () => {},
  });
  return new AgentTokenService(store);
}

/**
 * Mounts the agent-tokens router behind requireMaster, with a settable
 * res.locals.auth so a test can simulate a master vs a valid-non-master caller.
 */
async function mount(
  svc: AgentTokenService,
  isMaster: boolean,
): Promise<{ base: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.auth = { isMaster };
    next();
  });
  app.use('/agent-tokens', requireMaster, createAgentTokensRouter(svc));
  const server: Server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function req(
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

test('GET returns the masked list for a master caller (AC-14)', async () => {
  const svc = makeService();
  await svc.generate('web-01');
  const h = await mount(svc, true);
  try {
    const res = await req(h.base, 'GET', '/agent-tokens');
    assert.equal(res.status, 200);
    const rows = res.json as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.ok(!('hash' in rows[0]) && !('rawToken' in rows[0]));
  } finally {
    await h.close();
  }
});

test('POST generates a token, returning rawToken once; invalid label -> 400 (AC-15)', async () => {
  const svc = makeService();
  const h = await mount(svc, true);
  try {
    const ok = await req(h.base, 'POST', '/agent-tokens', { label: 'web-01' });
    assert.equal(ok.status, 201);
    const token = ok.json as Record<string, unknown>;
    assert.ok(typeof token.rawToken === 'string' && (token.rawToken as string).length > 0);
    assert.ok(!('hash' in token));

    const bad = await req(h.base, 'POST', '/agent-tokens', { label: '   ' });
    assert.equal(bad.status, 400);
    assert.equal((bad.json as { error: { code: string } }).error.code, 'VALIDATION');
  } finally {
    await h.close();
  }
});

test('DELETE existing -> 200, unknown -> 404 (AC-16)', async () => {
  const svc = makeService();
  const token = await svc.generate('web-01');
  const h = await mount(svc, true);
  try {
    const del = await req(h.base, 'DELETE', `/agent-tokens/${token.id}`);
    assert.equal(del.status, 200);
    const unknown = await req(h.base, 'DELETE', '/agent-tokens/00000000-0000-4000-8000-000000000000');
    assert.equal(unknown.status, 404);
    assert.equal((unknown.json as { error: { code: string; message: string } }).error.message, 'unknown agent-token id');
    // Non-uuid id fails validation (400).
    const badId = await req(h.base, 'DELETE', '/agent-tokens/not-a-uuid');
    assert.equal(badId.status, 400);
  } finally {
    await h.close();
  }
});

test('PATCH relabel -> 200 (hash/prefix/id unchanged), unknown -> 404 (AC-17)', async () => {
  const svc = makeService();
  const token = await svc.generate('old');
  const before = svc.list()[0];
  const h = await mount(svc, true);
  try {
    const ok = await req(h.base, 'PATCH', `/agent-tokens/${token.id}`, { label: 'new' });
    assert.equal(ok.status, 200);
    const after = svc.list()[0];
    assert.equal(after.label, 'new');
    assert.equal(after.prefix, before.prefix);
    assert.equal(after.id, before.id);
    const unknown = await req(h.base, 'PATCH', '/agent-tokens/00000000-0000-4000-8000-000000000000', { label: 'x' });
    assert.equal(unknown.status, 404);
  } finally {
    await h.close();
  }
});

test('a valid non-master caller is 403 on every route (AC-18)', async () => {
  const svc = makeService();
  const token = await svc.generate('web-01');
  const h = await mount(svc, false);
  try {
    const get = await req(h.base, 'GET', '/agent-tokens');
    assert.equal(get.status, 403);
    const post = await req(h.base, 'POST', '/agent-tokens', { label: 'x' });
    assert.equal(post.status, 403);
    const del = await req(h.base, 'DELETE', `/agent-tokens/${token.id}`);
    assert.equal(del.status, 403);
    const patch = await req(h.base, 'PATCH', `/agent-tokens/${token.id}`, { label: 'y' });
    assert.equal(patch.status, 403);
    // The non-master attempts did not mutate the store.
    assert.equal(svc.list()[0].status, 'active');
    assert.equal(svc.list()[0].label, 'web-01');
  } finally {
    await h.close();
  }
});

test('no route emits a hash; only POST emits the raw token (AC-19)', async () => {
  const svc = makeService();
  const h = await mount(svc, true);
  try {
    const gen = await req(h.base, 'POST', '/agent-tokens', { label: 'web-01' });
    assert.ok('rawToken' in (gen.json as Record<string, unknown>));
    const list = await req(h.base, 'GET', '/agent-tokens');
    assert.ok(!JSON.stringify(list.json).includes('rawToken'));
    assert.ok(!JSON.stringify(list.json).includes('hash'));
  } finally {
    await h.close();
  }
});
