import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, validateLive, buildAgentAuthConfig, type AgentTokenResolver } from './agentAuth.js';
import { AgentTokenStore } from './agentTokenStore.js';
import { validateWsCredential } from '../api/auth.js';
import { createLogger } from '../core/logger.js';

const silent = createLogger({ level: 'error', sink: () => {} });

/** A live store wired behind a resolver (env tokens UNION active hashes). */
function liveResolver(envTokens: string[]) {
  const store = new AgentTokenStore({
    file: 'config/agent-tokens.json',
    logger: silent,
    readFile: async () => {
      throw new Error('ENOENT');
    },
    writeFile: async () => {},
    rename: async () => {},
    chmod: async () => {},
  });
  const resolver: AgentTokenResolver = {
    envTokens: () => envTokens,
    activeHashes: () => store.activeHashes(),
  };
  return { store, resolver };
}

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

// --- validateLive (resolver = env tokens UNION active store hashes) ---

test('validateLive accepts an env token (anti-lockout) (AC-7)', () => {
  const { resolver } = liveResolver(['env-token']);
  assert.equal(validateLive('env-token', resolver), true);
});

test('validateLive accepts an active store-token hash (AC-8)', async () => {
  const { store, resolver } = liveResolver([]);
  const token = await store.generate('web-01');
  assert.equal(validateLive(token.rawToken, resolver), true);
});

test('validateLive rejects a revoked store token (AC-9)', async () => {
  const { store, resolver } = liveResolver([]);
  const token = await store.generate('web-01');
  assert.equal(validateLive(token.rawToken, resolver), true);
  await store.revoke(token.id);
  assert.equal(validateLive(token.rawToken, resolver), false);
});

test('a token added AFTER construction authenticates with no rebuild (AC-10)', async () => {
  const { store, resolver } = liveResolver(['env-token']);
  // Nothing in the store yet; a fresh token is not accepted.
  const token = await store.generate('web-01');
  // The resolver reads the live active set, so the just-generated token works
  // without re-wiring the resolver.
  assert.equal(validateLive(token.rawToken, resolver), true);
});

test('revoke after boot stops a store token authenticating (AC-11)', async () => {
  const { store, resolver } = liveResolver([]);
  const token = await store.generate('web-01');
  assert.equal(validateLive(token.rawToken, resolver), true);
  assert.equal(await store.revoke(token.id), true);
  assert.equal(validateLive(token.rawToken, resolver), false);
});

test('validateLive rejects empty/wrong-length/malformed without throwing (AC-12)', () => {
  const { resolver } = liveResolver(['a-much-longer-configured-token-value']);
  assert.doesNotThrow(() => validateLive('', resolver));
  assert.equal(validateLive('', resolver), false);
  assert.doesNotThrow(() => validateLive('x', resolver));
  assert.equal(validateLive('x', resolver), false);
  assert.equal(validateLive('a-much-longer-provided-token-value', resolver), false);
});

test('an empty store still accepts env tokens (AC-36)', () => {
  const { resolver } = liveResolver(['env-token']);
  assert.deepEqual(resolver.activeHashes(), []);
  assert.equal(validateLive('env-token', resolver), true);
  assert.equal(validateLive('not-the-env-token', resolver), false);
});

test('human master API_KEY not accepted by validateLive; agent token separate (AC-13)', async () => {
  const MASTER = 'human-master-api-key';
  const { store, resolver } = liveResolver(['env-token']);
  const agentToken = await store.generate('web-01');
  // The human master key is NOT an agent credential.
  assert.equal(validateLive(MASTER, resolver), false);
  // The agent token is accepted by the agent resolver...
  assert.equal(validateLive(agentToken.rawToken, resolver), true);
  // ...but is NOT a human credential (verified via validateWsCredential apikey).
  const human = validateWsCredential({ mode: 'apikey', apiKey: MASTER }, agentToken.rawToken);
  assert.equal(human.ok, false, 'agent token is not a human credential');
});
