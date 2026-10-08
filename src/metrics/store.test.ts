import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetricsStore } from './store.js';
import type { MetricSample } from '../core/types.js';

function sample(ts: number, cpu: number, mem: number): MetricSample {
  return { ts, cpu, mem };
}

test('capacity derives from retention and sample interval', () => {
  // 1 min retention, 5s sample => ceil(60/5) = 12 samples.
  let t = 0;
  const store = new MetricsStore({ retentionMin: 1, sampleSec: 5, now: () => t });
  for (let i = 0; i < 20; i++) {
    t = i * 5000;
    store.push('api', sample(t, i, i));
  }
  const all = store.getSeries('api', 0);
  assert.ok(all.length <= 12);
});

test('getSeries filters by sinceMs', () => {
  let t = 100_000;
  const store = new MetricsStore({ retentionMin: 180, sampleSec: 5, now: () => t });
  store.push('api', sample(90_000, 1, 1));
  store.push('api', sample(95_000, 2, 2));
  store.push('api', sample(100_000, 3, 3));
  const recent = store.getSeries('api', 95_000);
  assert.equal(recent.length, 2);
});

test('sustainedAbove returns false under insufficient coverage', () => {
  let t = 60_000;
  const store = new MetricsStore({ retentionMin: 180, sampleSec: 5, now: () => t });
  // durationSec=30 => expected=6, required=5. Only one sample present.
  store.push('api', sample(60_000, 99, 99));
  assert.equal(store.sustainedAbove('api', 'cpu', 85, 30), false);
});

test('sustainedAbove returns false when a gap exceeds 2*sampleSec', () => {
  let t = 0;
  const store = new MetricsStore({ retentionMin: 180, sampleSec: 5, now: () => t });
  // Build a window with enough samples but a real hole in the middle.
  const base = 100_000;
  store.push('api', sample(base, 99, 99));
  store.push('api', sample(base + 5000, 99, 99));
  // 20s gap (> 2*5s) then resume.
  store.push('api', sample(base + 25_000, 99, 99));
  store.push('api', sample(base + 30_000, 99, 99));
  store.push('api', sample(base + 35_000, 99, 99));
  store.push('api', sample(base + 40_000, 99, 99));
  t = base + 40_000;
  assert.equal(store.sustainedAbove('api', 'cpu', 85, 45), false);
});

test('sustainedAbove arms within one window at steady state', () => {
  let t = 0;
  const store = new MetricsStore({ retentionMin: 180, sampleSec: 5, now: () => t });
  const base = 1_000_000;
  // durationSec=30 => required=5. Provide 6 contiguous high samples.
  for (let i = 0; i < 6; i++) {
    t = base + i * 5000;
    store.push('api', sample(t, 90, 90));
  }
  assert.equal(store.sustainedAbove('api', 'cpu', 85, 30), true);
});

test('sustainedAbove returns false if any sample is at or below threshold', () => {
  let t = 0;
  const store = new MetricsStore({ retentionMin: 180, sampleSec: 5, now: () => t });
  const base = 2_000_000;
  for (let i = 0; i < 6; i++) {
    t = base + i * 5000;
    store.push('api', sample(t, i === 3 ? 50 : 90, 90));
  }
  assert.equal(store.sustainedAbove('api', 'cpu', 85, 30), false);
});

test('sustainedAbove evaluates the mem metric independently', () => {
  let t = 0;
  const store = new MetricsStore({ retentionMin: 180, sampleSec: 5, now: () => t });
  const base = 3_000_000;
  for (let i = 0; i < 6; i++) {
    t = base + i * 5000;
    store.push('api', sample(t, 1, 2_000_000_000));
  }
  assert.equal(store.sustainedAbove('api', 'mem', 1_073_741_824, 30), true);
  assert.equal(store.sustainedAbove('api', 'cpu', 85, 30), false);
});

test('drop clears a series', () => {
  let t = 0;
  const store = new MetricsStore({ retentionMin: 180, sampleSec: 5, now: () => t });
  store.push('api', sample(0, 1, 1));
  store.drop('api');
  assert.equal(store.getSeries('api', 0).length, 0);
});
