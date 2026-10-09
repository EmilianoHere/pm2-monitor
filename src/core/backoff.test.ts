import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backoffDelay } from './backoff.js';

test('doubling sequence capped at 30s (midpoint jitter via rand=0.5)', () => {
  // rand() === 0.5 => jitter factor (0.5*2-1) === 0, so delay === base exactly.
  const mid = () => 0.5;
  assert.equal(backoffDelay(0, mid), 1000);
  assert.equal(backoffDelay(1, mid), 2000);
  assert.equal(backoffDelay(2, mid), 4000);
  assert.equal(backoffDelay(3, mid), 8000);
  assert.equal(backoffDelay(4, mid), 16000);
  // 2^5 * 1000 = 32000 -> capped at 30000.
  assert.equal(backoffDelay(5, mid), 30000);
  assert.equal(backoffDelay(10, mid), 30000);
});

test('jitter lower bound: rand=0 lands at base*0.8', () => {
  const lo = () => 0;
  assert.equal(backoffDelay(0, lo), 800); // 1000 * 0.8
  assert.equal(backoffDelay(1, lo), 1600); // 2000 * 0.8
  // capped base 30000 * 0.8 = 24000
  assert.equal(backoffDelay(5, lo), 24000);
});

test('jitter upper bound: rand=1 lands at base*1.2', () => {
  const hi = () => 1;
  assert.equal(backoffDelay(0, hi), 1200); // 1000 * 1.2
  assert.equal(backoffDelay(1, hi), 2400); // 2000 * 1.2
  // capped base 30000 * 1.2 = 36000
  assert.equal(backoffDelay(5, hi), 36000);
});

test('result is always non-negative and rounded to an integer', () => {
  for (let attempt = 0; attempt <= 12; attempt += 1) {
    for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
      const d = backoffDelay(attempt, () => r);
      assert.ok(d >= 0, `delay ${d} should be >= 0`);
      assert.ok(Number.isInteger(d), `delay ${d} should be an integer`);
    }
  }
});

test('default RNG (Math.random) keeps delays within the +/-20% jitter band', () => {
  // Pm2Client calls backoffDelay(attempt) with the default rand, so its runtime
  // behavior is unchanged: every sample stays within [base*0.8, base*1.2].
  const original = Math.random;
  try {
    for (const r of [0, 0.5, 1, 0.123, 0.876]) {
      Math.random = () => r;
      const base = Math.min(30000, 1000 * 2 ** 2); // attempt 2 => 4000
      const d = backoffDelay(2); // no rand arg => default Math.random
      assert.ok(d >= Math.round(base * 0.8), `delay ${d} below lower band`);
      assert.ok(d <= Math.round(base * 1.2), `delay ${d} above upper band`);
    }
  } finally {
    Math.random = original;
  }
});
