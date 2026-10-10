import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MonitorEvents } from '../core/events.js';
import { ErrorTracker } from './tracker.js';
import { createLogger } from '../core/logger.js';
import type { TrackedError } from '../core/types.js';

const silent = createLogger({ level: 'error', sink: () => {} });

function makeTracker(now: () => number, bufferSize = 500) {
  const events = new MonitorEvents();
  const tracker = new ErrorTracker({
    events,
    bufferSize,
    logAppend: false,
    logger: silent,
    now,
  });
  return { events, tracker };
}

function err(partial: Partial<TrackedError> & { processName: string; level: TrackedError['level'] }): TrackedError {
  return {
    signature: '',
    firstSeen: 0,
    lastSeen: 0,
    count: 1,
    message: partial.sample ?? 'Error: boom',
    sample: partial.sample ?? 'Error: boom',
    ...partial,
  };
}

test('dedups identical errors by signature and increments count', () => {
  let t = 1_000_000;
  const { events, tracker } = makeTracker(() => t);
  events.emit('error:captured', err({ processName: 'api', level: 'error', sample: 'Error: boom at x:1:1' }));
  t += 1000;
  events.emit('error:captured', err({ processName: 'api', level: 'error', sample: 'Error: boom at x:5:9' }));
  const list = tracker.list('api');
  assert.equal(list.length, 1);
  assert.equal(list[0].count, 2);
});

test('evicts the oldest signature when over buffer capacity', () => {
  let t = 1_000_000;
  const { events, tracker } = makeTracker(() => t, 2);
  events.emit('error:captured', err({ processName: 'api', level: 'error', sample: 'E one' }));
  events.emit('error:captured', err({ processName: 'api', level: 'error', sample: 'E two' }));
  events.emit('error:captured', err({ processName: 'api', level: 'error', sample: 'E three' }));
  const list = tracker.list('api');
  assert.equal(list.length, 2);
  assert.ok(!list.some((e) => e.sample === 'E one'));
});

test('countInWindow sums error captures in the trailing window', () => {
  let t = 10_000_000;
  const { events, tracker } = makeTracker(() => t);
  events.emit('error:captured', err({ processName: 'api', level: 'error', sample: 'A' }));
  t += 2000;
  events.emit('error:captured', err({ processName: 'api', level: 'error', sample: 'B' }));
  t += 2000;
  events.emit('error:captured', err({ processName: 'api', level: 'error', sample: 'C' }));
  assert.equal(tracker.countInWindow('api', 10), 3);
  // Only the last two seconds.
  assert.equal(tracker.countInWindow('api', 3), 2);
});

test('restart ring counts only intentional === false restarts', () => {
  let t = 20_000_000;
  const { events, tracker } = makeTracker(() => t);
  events.emit('error:captured', err({ processName: 'api', level: 'restart', intentional: false, sample: 'r1' }));
  events.emit('error:captured', err({ processName: 'api', level: 'restart', intentional: true, sample: 'r2' }));
  events.emit('error:captured', err({ processName: 'api', level: 'restart', sample: 'r3' })); // undefined -> excluded
  assert.equal(tracker.restartsInWindow('api', 60), 1);
});

test('error captures do not feed the restart ring and vice versa', () => {
  let t = 30_000_000;
  const { events, tracker } = makeTracker(() => t);
  events.emit('error:captured', err({ processName: 'api', level: 'error', sample: 'e' }));
  events.emit('error:captured', err({ processName: 'api', level: 'restart', intentional: false, sample: 'r' }));
  assert.equal(tracker.countInWindow('api', 60), 1);
  assert.equal(tracker.restartsInWindow('api', 60), 1);
});

test('setMaxWindow grows the ring (zero-fill) and preserves recent counts', () => {
  let t = 40_000_000;
  const { events, tracker } = makeTracker(() => t);
  events.emit('error:captured', err({ processName: 'api', level: 'error', sample: 'a' }));
  tracker.setMaxWindow(600);
  // Still counts the recent event after a grow.
  assert.equal(tracker.countInWindow('api', 600), 1);
});

test('setMaxWindow shrink discards slots beyond the new length', () => {
  let t = 50_000_000;
  const { events, tracker } = makeTracker(() => t);
  tracker.setMaxWindow(300);
  events.emit('error:captured', err({ processName: 'api', level: 'error', sample: 'a' }));
  t += 100_000; // 100s later
  events.emit('error:captured', err({ processName: 'api', level: 'error', sample: 'b' }));
  // Shrink to 60s: the first event (100s old) must be gone.
  tracker.setMaxWindow(60);
  assert.equal(tracker.countInWindow('api', 60), 1);
});

test('clamps a window request larger than the ring length', () => {
  let t = 60_000_000;
  const { events, tracker } = makeTracker(() => t);
  events.emit('error:captured', err({ processName: 'api', level: 'error', sample: 'a' }));
  // Ring floor is 60s; asking for 999s clamps to 60 and still returns the count.
  assert.equal(tracker.countInWindow('api', 999), 1);
});

test('drop removes all state for a process', () => {
  let t = 70_000_000;
  const { events, tracker } = makeTracker(() => t);
  events.emit('error:captured', err({ processName: 'api', level: 'error', sample: 'a' }));
  tracker.drop('api');
  assert.equal(tracker.list('api').length, 0);
  assert.equal(tracker.countInWindow('api', 60), 0);
});

test('setLogAppend toggles raw-append behavior on each capture', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pm2mon-tracker-'));
  const logFile = join(dir, 'errors.log');
  try {
    const events = new MonitorEvents();
    let t = 80_000_000;
    const tracker = new ErrorTracker({
      events,
      bufferSize: 500,
      logAppend: false,
      logFile,
      logger: silent,
      now: () => t,
    });

    // Disabled: no file written.
    events.emit('error:captured', err({ processName: 'api', level: 'error', sample: 'a' }));
    assert.equal(existsSync(logFile), false);

    // Enable live: the next capture is appended.
    tracker.setLogAppend(true);
    t += 1000;
    events.emit('error:captured', err({ processName: 'api', level: 'error', sample: 'b' }));
    assert.equal(existsSync(logFile), true);
    assert.equal(readFileSync(logFile, 'utf8').trim().split('\n').length, 1);

    // Disable again: no further append.
    tracker.setLogAppend(false);
    t += 1000;
    events.emit('error:captured', err({ processName: 'api', level: 'error', sample: 'c' }));
    assert.equal(readFileSync(logFile, 'utf8').trim().split('\n').length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
