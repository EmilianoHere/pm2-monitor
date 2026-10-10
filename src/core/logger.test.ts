import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, redactUrl } from './logger.js';

function capture(level: 'debug' | 'info' | 'warn' | 'error', now?: () => number) {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    level,
    now,
    sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { logger, lines };
}

test('level gating suppresses records below threshold', () => {
  const { logger, lines } = capture('warn');
  logger.debug('d');
  logger.info('i');
  logger.warn('w');
  logger.error('e');
  assert.deepEqual(
    lines.map((l) => l.level),
    ['warn', 'error'],
  );
});

test('redacts known secret keys in context', () => {
  const { logger, lines } = capture('info');
  logger.info('cfg', { API_KEY: 'super-secret', PORT: 3000 });
  assert.equal(lines[0].API_KEY, '***');
  assert.equal(lines[0].PORT, 3000);
});

test('redacts secret keys nested one level deep', () => {
  const { logger, lines } = capture('info');
  logger.info('cfg', { config: { SMTP_PASS: 'hunter2', SMTP_HOST: 'mail' } });
  const config = lines[0].config as Record<string, unknown>;
  assert.equal(config.SMTP_PASS, '***');
  assert.equal(config.SMTP_HOST, 'mail');
});

test('redacts the agent token keys and a wss url carrying a token at any depth', () => {
  const { logger, lines } = capture('info');
  logger.info('cfg', {
    AGENT_TOKEN: 'tok',
    AGENT_TOKENS: 'a,b,c',
    dial: { url: 'wss://h/agent?token=secret' },
    a: { b: { AGENT_TOKEN: 'deep' } },
  });
  const l = lines[0];
  assert.equal(l.AGENT_TOKEN, '***');
  assert.equal(l.AGENT_TOKENS, '***');
  assert.equal((l.dial as Record<string, unknown>).url, 'wss://h/agent?token=***');
  // Full-depth recursion: a secret key nested >=2 levels is still redacted.
  const a = l.a as Record<string, Record<string, unknown>>;
  assert.equal(a.b.AGENT_TOKEN, '***');
});

test('redacts SERVER_URL by key name', () => {
  const { logger, lines } = capture('info');
  logger.info('dial', { SERVER_URL: 'wss://hub.example/agent' });
  assert.equal(lines[0].SERVER_URL, '***');
});

test('a token-bearing object inside an ARRAY is NOT key-redacted (the single array edge)', () => {
  // redactContext does not recurse into arrays, so log contexts must never
  // array-wrap a secret; this documents that one edge.
  const { logger, lines } = capture('info');
  logger.info('list', { list: [{ AGENT_TOKEN: 'leaks' }] });
  const list = lines[0].list as Array<Record<string, unknown>>;
  assert.equal(list[0].AGENT_TOKEN, 'leaks');
});

test('redactUrl rewrites token query value', () => {
  assert.equal(redactUrl('/ws?token=abc123&x=1'), '/ws?token=***&x=1');
  assert.equal(redactUrl('/ws?x=1&token=abc'), '/ws?x=1&token=***');
  assert.equal(redactUrl('/ws?x=1'), '/ws?x=1');
});

test('redacts token in a logged url string value', () => {
  const { logger, lines } = capture('info');
  logger.info('req', { url: '/ws?token=secret&y=2' });
  assert.equal(lines[0].url, '/ws?token=***&y=2');
});

test('child logger carries bound context', () => {
  const { logger, lines } = capture('info');
  logger.child({ module: 'pm2' }).info('hello');
  assert.equal(lines[0].module, 'pm2');
  assert.equal(lines[0].msg, 'hello');
});

test('warnOnce emits once per key within the window', () => {
  let t = 0;
  const { logger, lines } = capture('info', () => t);
  logger.warnOnce('k', 'first');
  logger.warnOnce('k', 'second');
  assert.equal(lines.length, 1);
  t += 60_001;
  logger.warnOnce('k', 'third');
  assert.equal(lines.length, 2);
});

test('throttle gates by key and window', () => {
  let t = 0;
  const { logger } = capture('info', () => t);
  assert.equal(logger.throttle('a', 1000), true);
  assert.equal(logger.throttle('a', 1000), false);
  t += 1001;
  assert.equal(logger.throttle('a', 1000), true);
});

test('setLevel re-levels both the parent and a child logger', () => {
  const { logger, lines } = capture('info');
  const child = logger.child({ module: 'pm2' });
  // Baseline: debug is below the info threshold on both.
  logger.debug('p-before');
  child.debug('c-before');
  assert.equal(lines.length, 0);
  // Lowering the level on the parent re-levels the whole tree (shared binding).
  logger.setLevel('debug');
  logger.debug('p-after');
  child.debug('c-after');
  assert.deepEqual(
    lines.map((l) => l.msg),
    ['p-after', 'c-after'],
  );
  // Raising it back suppresses debug again on both.
  logger.setLevel('warn');
  logger.debug('p-suppressed');
  child.info('c-suppressed');
  assert.equal(lines.length, 2);
});

test('rawKey/hash/apiKey redact to *** at nested object depth', () => {
  const { logger, lines } = capture('info');
  logger.info('key', {
    generated: { rawKey: 'pmk_abcd1234', hash: 'deadbeef', apiKey: 'pmk_live' },
  });
  const generated = lines[0].generated as Record<string, unknown>;
  assert.equal(generated.rawKey, '***');
  assert.equal(generated.hash, '***');
  assert.equal(generated.apiKey, '***');
});

test('a sibling non-secret `key` field is NOT redacted', () => {
  const { logger, lines } = capture('info');
  logger.info('store', { key: 'config/settings.json', id: 'abc' });
  assert.equal(lines[0].key, 'config/settings.json');
  assert.equal(lines[0].id, 'abc');
});
