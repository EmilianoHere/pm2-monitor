import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, buildAgentAuthConfig } from './agentAuth.js';

test('accepts a valid token present in the list', () => {
  assert.equal(validate('secret-token', ['secret-token']), true);
});

test('rejects an invalid token without throwing', () => {
  assert.doesNotThrow(() => validate('wrong', ['secret-token']));
  assert.equal(validate('wrong', ['secret-token']), false);
});

test('rejects a missing/empty token without throwing', () => {
  assert.doesNotThrow(() => validate('', ['secret-token']));
  assert.equal(validate('', ['secret-token']), false);
});

test('rejects a wrong-length token without throwing (safeEqual length-normalizes)', () => {
  // A credential far shorter/longer than the secret would make a raw
  // timingSafeEqual throw; safeEqual sha256-normalizes so it only returns false.
  assert.doesNotThrow(() => validate('x', ['a-much-longer-configured-token-value']));
  assert.equal(validate('x', ['a-much-longer-configured-token-value']), false);
  assert.equal(validate('a-much-longer-provided-token-value', ['short']), false);
});

test('an empty token list rejects everything without throwing', () => {
  assert.doesNotThrow(() => validate('anything', []));
  assert.equal(validate('anything', []), false);
});

test('list rotation: any entry in the set matches', () => {
  const tokens = ['old-token', 'new-token'];
  assert.equal(validate('old-token', tokens), true);
  assert.equal(validate('new-token', tokens), true);
  assert.equal(validate('retired-token', tokens), false);
});

test('buildAgentAuthConfig splits AGENT_TOKENS, trims, drops empties, dedupes', () => {
  const cfg = buildAgentAuthConfig({ AGENT_TOKENS: ' a , b ,, a ,c ', AGENT_TOKEN: undefined });
  assert.deepEqual(cfg.tokens, ['a', 'b', 'c']);
});

test('buildAgentAuthConfig appends AGENT_TOKEN and dedupes against the list', () => {
  const cfg = buildAgentAuthConfig({ AGENT_TOKENS: 'a,b', AGENT_TOKEN: 'b' });
  assert.deepEqual(cfg.tokens, ['a', 'b']);
  const single = buildAgentAuthConfig({ AGENT_TOKENS: undefined, AGENT_TOKEN: 'solo' });
  assert.deepEqual(single.tokens, ['solo']);
});

test('safeEqual is the comparator used (constant-time, never throws)', () => {
  // A correct token matches, a one-char variation does not — the behavior of a
  // digest comparison, not a plain === (which this still satisfies) — and no
  // input shape throws.
  const tokens = buildAgentAuthConfig({ AGENT_TOKENS: 'tok-1,tok-2', AGENT_TOKEN: undefined }).tokens;
  assert.equal(validate('tok-1', tokens), true);
  assert.equal(validate('tok-1 ', tokens), false);
});
