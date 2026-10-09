import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newCid, PendingRequests } from './correlation.js';
import type { ControlResult } from '../pm2/client.js';

/** A controllable timer harness mirroring the Pm2Client/WsHub test pattern. */
function makeTimers() {
  let seq = 0;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  return {
    setTimer: (fn: () => void, ms: number) => {
      seq += 1;
      pending.set(seq, { fn, ms });
      return seq as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (h: ReturnType<typeof setTimeout>) => {
      pending.delete(h as unknown as number);
    },
    /** fire every armed timer (simulating elapsed time). */
    fireAll: () => {
      for (const [id, { fn }] of [...pending]) {
        pending.delete(id);
        fn();
      }
    },
    size: () => pending.size,
  };
}

const timeoutResult = (cid: string): ControlResult => ({
  ok: false,
  code: 'AGENT_TIMEOUT',
  message: `no response for ${cid}`,
});

test('newCid produces a now-prefixed, dash-joined id', () => {
  const cid = newCid(() => 42, () => 0.5);
  assert.match(cid, /^42-/);
});

test('a matching cid resolves the waiter', async () => {
  const timers = makeTimers();
  const pr = new PendingRequests<ControlResult>({
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onTimeout: timeoutResult,
  });
  const p = pr.create('c1');
  const settled = pr.settle('c1', { ok: false, code: 'OK', message: 'done' });
  assert.equal(settled, true);
  const result = await p;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'OK');
  assert.equal(timers.size(), 0, 'timer should be cleared on settle');
});

test('an unknown cid is ignored', () => {
  const timers = makeTimers();
  const pr = new PendingRequests<ControlResult>({
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onTimeout: timeoutResult,
  });
  assert.equal(pr.settle('nope', { ok: false, code: 'X', message: 'y' }), false);
});

test('a duplicate / already-settled cid is ignored', () => {
  const timers = makeTimers();
  const pr = new PendingRequests<ControlResult>({
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onTimeout: timeoutResult,
  });
  void pr.create('c1');
  assert.equal(pr.settle('c1', { ok: false, code: 'A', message: '1' }), true);
  assert.equal(pr.settle('c1', { ok: false, code: 'B', message: '2' }), false);
});

test('a timeout resolves AGENT_TIMEOUT and never hangs', async () => {
  const timers = makeTimers();
  const pr = new PendingRequests<ControlResult>({
    timeoutMs: 15000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onTimeout: timeoutResult,
  });
  const p = pr.create('c1');
  timers.fireAll();
  const result = await p;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'AGENT_TIMEOUT');
  // After timeout the waiter is gone, so a late response is ignored.
  assert.equal(pr.settle('c1', { ok: true, process: {} as never }), false);
});

test('rejectAll settles all pending waiters', async () => {
  const timers = makeTimers();
  const pr = new PendingRequests<ControlResult>({
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onTimeout: timeoutResult,
  });
  const a = pr.create('a');
  const b = pr.create('b');
  pr.rejectAll({ ok: false, code: 'AGENT_DISCONNECTED', message: 'link down' });
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.ok, false);
  assert.equal(rb.ok, false);
  if (!ra.ok) assert.equal(ra.code, 'AGENT_DISCONNECTED');
  assert.equal(pr.size, 0);
  assert.equal(timers.size(), 0, 'all timers cleared');
});
