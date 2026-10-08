import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from './env.js';

test('valid apikey config parses with defaults', () => {
  const result = parseConfig({ API_KEY: 'k' } as NodeJS.ProcessEnv);
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.PORT, 3000);
    assert.equal(result.data.HOST, '127.0.0.1');
    assert.equal(result.data.AUTH_MODE, 'apikey');
    assert.equal(result.data.METRICS_SAMPLE_SEC, 5);
    assert.equal(result.data.LOG_LEVEL, 'info');
  }
});

test('coerces numeric and boolean env strings', () => {
  const result = parseConfig({
    API_KEY: 'k',
    PORT: '8080',
    METRICS_SAMPLE_SEC: '10',
    ERROR_LOG_APPEND: 'true',
    SMTP_SECURE: 'yes',
  } as NodeJS.ProcessEnv);
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.PORT, 8080);
    assert.equal(result.data.METRICS_SAMPLE_SEC, 10);
    assert.equal(result.data.ERROR_LOG_APPEND, true);
    assert.equal(result.data.SMTP_SECURE, true);
  }
});

test('apikey mode requires API_KEY', () => {
  const result = parseConfig({} as NodeJS.ProcessEnv);
  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(result.error.issues.some((i) => i.path.join('.') === 'API_KEY'));
  }
});

test('basic mode requires user and pass', () => {
  const result = parseConfig({ AUTH_MODE: 'basic' } as NodeJS.ProcessEnv);
  assert.equal(result.success, false);
  if (!result.success) {
    const paths = result.error.issues.map((i) => i.path.join('.'));
    assert.ok(paths.includes('BASIC_USER'));
    assert.ok(paths.includes('BASIC_PASS'));
  }
});

test('basic mode valid with user and pass', () => {
  const result = parseConfig({
    AUTH_MODE: 'basic',
    BASIC_USER: 'admin',
    BASIC_PASS: 'secret',
  } as NodeJS.ProcessEnv);
  assert.equal(result.success, true);
});

test('partial email config fails refinement', () => {
  const result = parseConfig({
    API_KEY: 'k',
    SMTP_HOST: 'mail.example.com',
  } as NodeJS.ProcessEnv);
  assert.equal(result.success, false);
  if (!result.success) {
    const paths = result.error.issues.map((i) => i.path.join('.'));
    assert.ok(paths.includes('SMTP_USER'));
    assert.ok(paths.includes('MAIL_TO'));
  }
});

test('full email config passes refinement', () => {
  const result = parseConfig({
    API_KEY: 'k',
    SMTP_HOST: 'mail.example.com',
    SMTP_USER: 'u',
    SMTP_PASS: 'p',
    MAIL_FROM: 'from@example.com',
    MAIL_TO: 'to@example.com',
  } as NodeJS.ProcessEnv);
  assert.equal(result.success, true);
});

test('rejects an invalid TEAMS_WEBHOOK_URL', () => {
  const result = parseConfig({ API_KEY: 'k', TEAMS_WEBHOOK_URL: 'not-a-url' } as NodeJS.ProcessEnv);
  assert.equal(result.success, false);
});

test('rejects a non-positive METRICS_SAMPLE_SEC', () => {
  const result = parseConfig({ API_KEY: 'k', METRICS_SAMPLE_SEC: '0' } as NodeJS.ProcessEnv);
  assert.equal(result.success, false);
});
