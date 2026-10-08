import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CooldownTracker } from './cooldown.js';

test('first fire for a key is always allowed with zero suppressed', () => {
  const now = { t: 1000 };
  const cd = new CooldownTracker({ now: () => now.t });
  const d = cd.allow('rule', 'api', 300);
  assert.equal(d.allowed, true);
  assert.equal(d.suppressedCount, 0);
});

test('matches within the cooldown are suppressed and counted', () => {
  const now = { t: 0 };
  const cd = new CooldownTracker({ now: () => now.t });
  cd.allow('rule', 'api', 300); // fire at t=0

  now.t = 10_000;
  const a = cd.allow('rule', 'api', 300);
  assert.equal(a.allowed, false);
  assert.equal(a.suppressedCount, 1);

  now.t = 20_000;
  const b = cd.allow('rule', 'api', 300);
  assert.equal(b.allowed, false);
  assert.equal(b.suppressedCount, 2);
});

test('after the cooldown elapses the next match fires and reports suppressed rollup', () => {
  const now = { t: 0 };
  const cd = new CooldownTracker({ now: () => now.t });
  cd.allow('rule', 'api', 300); // fire at t=0

  now.t = 60_000;
  cd.allow('rule', 'api', 300); // suppressed (1)
  now.t = 120_000;
  cd.allow('rule', 'api', 300); // suppressed (2)

  // 300s after the first fire.
  now.t = 300_000;
  const fire = cd.allow('rule', 'api', 300);
  assert.equal(fire.allowed, true);
  assert.equal(fire.suppressedCount, 2);

  // The rollup resets after a fire.
  now.t = 301_000;
  const after = cd.allow('rule', 'api', 300);
  assert.equal(after.allowed, false);
  assert.equal(after.suppressedCount, 1);
});

test('cooldown keys are isolated per (ruleId, processName)', () => {
  const now = { t: 0 };
  const cd = new CooldownTracker({ now: () => now.t });
  cd.allow('rule', 'api', 300);
  // Different process, same rule -> independent first fire.
  const other = cd.allow('rule', 'web', 300);
  assert.equal(other.allowed, true);
  assert.equal(other.suppressedCount, 0);
  // Different rule, same process -> independent first fire.
  const otherRule = cd.allow('rule2', 'api', 300);
  assert.equal(otherRule.allowed, true);
});

test('reset clears all cooldown state', () => {
  const now = { t: 0 };
  const cd = new CooldownTracker({ now: () => now.t });
  cd.allow('rule', 'api', 300);
  now.t = 10_000;
  assert.equal(cd.allow('rule', 'api', 300).allowed, false);
  cd.reset();
  // After reset the key is fresh again.
  const d = cd.allow('rule', 'api', 300);
  assert.equal(d.allowed, true);
  assert.equal(d.suppressedCount, 0);
});
