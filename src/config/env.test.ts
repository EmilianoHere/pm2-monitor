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

test('treats an empty ALLOWED_SCRIPT_ROOT as unset', () => {
  const result = parseConfig({ API_KEY: 'k', ALLOWED_SCRIPT_ROOT: '' } as NodeJS.ProcessEnv);
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.ALLOWED_SCRIPT_ROOT, undefined);
  }
});

test('treats a whitespace-only ALLOWED_SCRIPT_ROOT as unset', () => {
  const result = parseConfig({ API_KEY: 'k', ALLOWED_SCRIPT_ROOT: '   ' } as NodeJS.ProcessEnv);
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.ALLOWED_SCRIPT_ROOT, undefined);
  }
});

test('preserves a non-empty ALLOWED_SCRIPT_ROOT', () => {
  const result = parseConfig({
    API_KEY: 'k',
    ALLOWED_SCRIPT_ROOT: '/opt/apps',
  } as NodeJS.ProcessEnv);
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.ALLOWED_SCRIPT_ROOT, '/opt/apps');
  }
});

// --- multi-instance MODE config ---

test('MODE defaults to standalone', () => {
  const result = parseConfig({ API_KEY: 'k' } as NodeJS.ProcessEnv);
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.MODE, 'standalone');
    // Legacy no-MODE env requires no new fields and keeps its defaults.
    assert.equal(result.data.AGENT_ID_FILE, 'config/agent-id');
    assert.equal(result.data.AGENT_WS_PATH, '/agent');
    assert.equal(result.data.ALIAS_STORE_FILE, 'config/agent-aliases.json');
    assert.equal(result.data.TLS_INSECURE, false);
    assert.equal(result.data.SERVER_URL, undefined);
    assert.equal(result.data.AGENT_TOKEN, undefined);
  }
});

test('a legacy env with no MODE parses unchanged (standalone)', () => {
  const result = parseConfig({
    AUTH_MODE: 'basic',
    BASIC_USER: 'admin',
    BASIC_PASS: 'secret',
  } as NodeJS.ProcessEnv);
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.MODE, 'standalone');
  }
});

test('rejects an invalid MODE value', () => {
  const result = parseConfig({ API_KEY: 'k', MODE: 'cluster' } as NodeJS.ProcessEnv);
  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(result.error.issues.some((i) => i.path.join('.') === 'MODE'));
  }
});

test('agent mode requires SERVER_URL and AGENT_TOKEN', () => {
  const result = parseConfig({ API_KEY: 'k', MODE: 'agent' } as NodeJS.ProcessEnv);
  assert.equal(result.success, false);
  if (!result.success) {
    const paths = result.error.issues.map((i) => i.path.join('.'));
    assert.ok(paths.includes('SERVER_URL'));
    assert.ok(paths.includes('AGENT_TOKEN'));
  }
});

test('agent mode valid with ws SERVER_URL and token', () => {
  const result = parseConfig({
    API_KEY: 'k',
    MODE: 'agent',
    SERVER_URL: 'wss://hub.example.com',
    AGENT_TOKEN: 't',
  } as NodeJS.ProcessEnv);
  assert.equal(result.success, true);
});

test('rejects a non-ws(s):// SERVER_URL', () => {
  const result = parseConfig({
    API_KEY: 'k',
    MODE: 'agent',
    SERVER_URL: 'https://hub.example.com',
    AGENT_TOKEN: 't',
  } as NodeJS.ProcessEnv);
  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(result.error.issues.some((i) => i.path.join('.') === 'SERVER_URL'));
  }
});

test('server mode requires at least one agent token', () => {
  const result = parseConfig({ API_KEY: 'k', MODE: 'server' } as NodeJS.ProcessEnv);
  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(result.error.issues.some((i) => i.path.join('.') === 'AGENT_TOKENS'));
  }
});

test('server mode valid with AGENT_TOKENS', () => {
  const result = parseConfig({
    API_KEY: 'k',
    MODE: 'server',
    AGENT_TOKENS: 'a,b,c',
  } as NodeJS.ProcessEnv);
  assert.equal(result.success, true);
});

test('server mode valid with AGENT_TOKEN shorthand', () => {
  const result = parseConfig({
    API_KEY: 'k',
    MODE: 'server',
    AGENT_TOKEN: 't',
  } as NodeJS.ProcessEnv);
  assert.equal(result.success, true);
});

test('half-set TLS pair fails on both keys', () => {
  const result = parseConfig({
    API_KEY: 'k',
    MODE: 'server',
    AGENT_TOKEN: 't',
    TLS_CERT_FILE: '/etc/ssl/cert.pem',
  } as NodeJS.ProcessEnv);
  assert.equal(result.success, false);
  if (!result.success) {
    const paths = result.error.issues.map((i) => i.path.join('.'));
    assert.ok(paths.includes('TLS_CERT_FILE'));
    assert.ok(paths.includes('TLS_KEY_FILE'));
  }
});

test('full TLS pair passes', () => {
  const result = parseConfig({
    API_KEY: 'k',
    MODE: 'server',
    AGENT_TOKEN: 't',
    TLS_CERT_FILE: '/etc/ssl/cert.pem',
    TLS_KEY_FILE: '/etc/ssl/key.pem',
  } as NodeJS.ProcessEnv);
  assert.equal(result.success, true);
});

test('server mode rejects AGENT_WS_PATH colliding with /ws', () => {
  const result = parseConfig({
    API_KEY: 'k',
    MODE: 'server',
    AGENT_TOKEN: 't',
    AGENT_WS_PATH: '/ws',
  } as NodeJS.ProcessEnv);
  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(result.error.issues.some((i) => i.path.join('.') === 'AGENT_WS_PATH'));
  }
});
