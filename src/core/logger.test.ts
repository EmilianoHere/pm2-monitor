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
