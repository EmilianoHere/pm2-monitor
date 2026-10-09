import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { alertRuleSchema, alertRulesFileSchema, loadAlertRules } from './alertRules.js';
import { createLogger } from '../core/logger.js';

const silent = createLogger({ level: 'error', sink: () => {} });

function tmpFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'alert-rules-'));
  const path = join(dir, 'rules.json');
  writeFileSync(path, contents, 'utf8');
  return path;
}

test('accepts a valid errored rule and applies defaults', () => {
  const result = alertRuleSchema.safeParse({
    id: 'api-crash',
    match: { condition: { type: 'errored' } },
    channels: { teams: true },
  });
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.enabled, true);
    assert.equal(result.data.severity, 'warning');
    assert.deepEqual(result.data.match.processes, ['*']);
  }
});

test('accepts all five condition variants', () => {
  const conditions = [
    { type: 'errored' },
    { type: 'unexpected-stop' },
    { type: 'restart-threshold', count: 5, withinMin: 10 },
    { type: 'cpu-threshold', percent: 85, forSec: 120 },
    { type: 'mem-threshold', bytes: 1073741824, forSec: 120 },
    { type: 'error-spike', count: 20, withinSec: 60 },
  ];
  for (const condition of conditions) {
    const result = alertRuleSchema.safeParse({
      id: 'r1',
      match: { condition },
      channels: { email: true },
    });
    assert.equal(result.success, true, `condition ${condition.type} should parse`);
  }
});

test('rejects an invalid rule id', () => {
  const result = alertRuleSchema.safeParse({
    id: 'Bad_ID',
    match: { condition: { type: 'errored' } },
    channels: { teams: true },
  });
  assert.equal(result.success, false);
});

test('rejects a rule with no channel enabled', () => {
  const result = alertRuleSchema.safeParse({
    id: 'r1',
    match: { condition: { type: 'errored' } },
    channels: { teams: false, email: false },
  });
  assert.equal(result.success, false);
});

test('rejects an unknown condition type', () => {
  const result = alertRuleSchema.safeParse({
    id: 'r1',
    match: { condition: { type: 'disk-full' } },
    channels: { teams: true },
  });
  assert.equal(result.success, false);
});

test('rejects extra keys (strict)', () => {
  const result = alertRuleSchema.safeParse({
    id: 'r1',
    match: { condition: { type: 'errored' } },
    channels: { teams: true },
    bogus: 1,
  });
  assert.equal(result.success, false);
});

test('rejects non-positive thresholds', () => {
  const result = alertRuleSchema.safeParse({
    id: 'r1',
    match: { condition: { type: 'restart-threshold', count: 0, withinMin: 10 } },
    channels: { teams: true },
  });
  assert.equal(result.success, false);
});

test('rejects an invalid process selector', () => {
  const result = alertRuleSchema.safeParse({
    id: 'r1',
    match: { processes: ['bad name!'], condition: { type: 'errored' } },
    channels: { teams: true },
  });
  assert.equal(result.success, false);
});

test('accepts an agentId/name composite target, bare names, and *', () => {
  const result = alertRuleSchema.safeParse({
    id: 'r1',
    match: { processes: ['web-01/api', 'worker', '*'], condition: { type: 'errored' } },
    channels: { teams: true },
  });
  assert.equal(result.success, true);
  if (result.success) {
    assert.deepEqual(result.data.match.processes, ['web-01/api', 'worker', '*']);
  }
});

test('rejects a two-slash or empty-part composite target', () => {
  for (const bad of ['a/b/c', '/api', 'web-01/', 'web-01//api']) {
    const result = alertRuleSchema.safeParse({
      id: 'r1',
      match: { processes: [bad], condition: { type: 'errored' } },
      channels: { teams: true },
    });
    assert.equal(result.success, false, `${bad} should be rejected`);
  }
});

test('loadAlertRules returns [] for a missing file', () => {
  const rules = loadAlertRules(join(tmpdir(), 'does-not-exist-xyz.json'), silent);
  assert.deepEqual(rules, []);
});

test('loadAlertRules parses a valid file', () => {
  const path = tmpFile(
    JSON.stringify({
      rules: [
        { id: 'r1', match: { condition: { type: 'errored' } }, channels: { teams: true } },
      ],
    }),
  );
  const rules = loadAlertRules(path, silent);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].id, 'r1');
  rmSync(path, { force: true });
});

test('file schema defaults rules to an empty array', () => {
  const result = alertRulesFileSchema.safeParse({});
  assert.equal(result.success, true);
  if (result.success) assert.deepEqual(result.data.rules, []);
});
