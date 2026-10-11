import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fmtBytes, fmtBytesTotal, fmtUptime, fmtRelativeAge } from '../../public/js/format.js';

test('fmtBytesTotal uses two decimals for non-byte units (AC-5)', () => {
  assert.equal(fmtBytesTotal(1_084_000_000), '1.01 GB');
});

test('fmtBytes stays one decimal per-row (AC-5)', () => {
  assert.equal(fmtBytes(1_084_000_000), '1.0 GB');
});

test('fmtBytes and fmtBytesTotal handle the zero/empty case as bytes', () => {
  assert.equal(fmtBytes(0), '0 B');
  assert.equal(fmtBytesTotal(0), '0 B');
});

test('fmtUptime guards null to em dash', () => {
  assert.equal(fmtUptime(null), '—');
  assert.equal(fmtUptime(undefined), '—');
  assert.equal(fmtUptime(-1), '—');
});

test('fmtUptime formats seconds/minutes', () => {
  assert.equal(fmtUptime(5_000), '5s');
  assert.equal(fmtUptime(125_000), '2m 5s');
});

test('fmtRelativeAge humanizes seconds, minutes, hours', () => {
  const now = Date.now();
  assert.equal(fmtRelativeAge(now - 2_000), 'hace 2 s');
  assert.equal(fmtRelativeAge(now - 3 * 60_000), 'hace 3 min');
  assert.equal(fmtRelativeAge(now - 60 * 60_000), 'hace 1 h');
  assert.equal(fmtRelativeAge(null), '—');
});
