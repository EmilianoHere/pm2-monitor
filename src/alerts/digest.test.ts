import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../core/logger.js';
import { DigestScheduler, type AlertCounters, type DigestDataSource } from './digest.js';
import type { EmailChannel, RawMessage } from './channels/types.js';
import type { ProcessSnapshot, TrackedError } from '../core/types.js';

const silent = createLogger({ level: 'error', sink: () => {} });

class FakeEmail implements EmailChannel {
  readonly name = 'email' as const;
  readonly sent: RawMessage[] = [];
  constructor(
    readonly enabled = true,
    private readonly fail = false,
  ) {}
  async send(): Promise<void> {
    /* unused by the digest */
  }
  async sendRaw(msg: RawMessage): Promise<void> {
    if (this.fail) throw new Error('smtp down');
    this.sent.push(msg);
  }
}

function proc(name: string, partial: Partial<ProcessSnapshot> = {}): ProcessSnapshot {
  return {
    pmId: 0,
    name,
    pid: 1,
    status: 'online',
    cpu: 1,
    memory: 1,
    uptimeMs: 1,
    restarts: 0,
    unstableRestarts: 0,
    mode: 'fork',
    instances: 1,
    execPath: '/x.js',
    lastUpdated: 0,
    ...partial,
  };
}

function err(partial: Partial<TrackedError> & Pick<TrackedError, 'processName'>): TrackedError {
  return {
    signature: 's',
    firstSeen: 0,
    lastSeen: 0,
    count: 1,
    level: 'error',
    message: 'boom',
    sample: 'boom',
    ...partial,
  };
}

function source(procs: ProcessSnapshot[], errorsByProc: Record<string, TrackedError[]> = {}): DigestDataSource {
  return {
    processes: () => procs,
    trackedErrors: (name) => errorsByProc[name] ?? [],
  };
}

function counters(dispatched: number, suppressed: number): AlertCounters {
  return { dispatched: () => dispatched, suppressed: () => suppressed };
}

function make(opts: {
  now: number;
  digestHour: number;
  procs?: ProcessSnapshot[];
  errorsByProc?: Record<string, TrackedError[]>;
  dispatched?: number;
  suppressed?: number;
  email?: FakeEmail;
  enabled?: boolean;
}): { digest: DigestScheduler; email: FakeEmail; nowRef: { t: number } } {
  const nowRef = { t: opts.now };
  const email = opts.email ?? new FakeEmail();
  const digest = new DigestScheduler({
    email,
    source: source(opts.procs ?? [], opts.errorsByProc ?? {}),
    counters: counters(opts.dispatched ?? 0, opts.suppressed ?? 0),
    digestHour: opts.digestHour,
    enabled: opts.enabled ?? true,
    errorBufferSize: 500,
    topN: 3,
    logger: silent,
    now: () => nowRef.t,
    setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
    clearTimer: () => {},
  });
  return { digest, email, nowRef };
}

// --- next-fire computation ---

test('nextFireAt returns todays DIGEST_HOUR when it is still ahead', () => {
  // Build a local timestamp at 06:00 and ask for hour 8 the same day.
  const base = new Date(2024, 0, 2, 6, 0, 0, 0).getTime();
  const { digest } = make({ now: base, digestHour: 8 });
  const next = new Date(digest.nextFireAt(base));
  assert.equal(next.getHours(), 8);
  assert.equal(next.getDate(), 2);
});

test('nextFireAt rolls to tomorrow when DIGEST_HOUR already passed', () => {
  // 10:00 local, digest hour 8 -> next is tomorrow at 08:00.
  const base = new Date(2024, 0, 2, 10, 0, 0, 0).getTime();
  const { digest } = make({ now: base, digestHour: 8 });
  const next = new Date(digest.nextFireAt(base));
  assert.equal(next.getHours(), 8);
  assert.equal(next.getDate(), 3);
});

test('nextFireAt rolls to tomorrow when exactly at DIGEST_HOUR (strictly future)', () => {
  const base = new Date(2024, 0, 2, 8, 0, 0, 0).getTime();
  const { digest } = make({ now: base, digestHour: 8 });
  const next = new Date(digest.nextFireAt(base));
  assert.equal(next.getDate(), 3);
  assert.equal(next.getHours(), 8);
});

test('msUntilNextFire is the gap to the next occurrence', () => {
  const base = new Date(2024, 0, 2, 6, 0, 0, 0).getTime();
  const { digest } = make({ now: base, digestHour: 8 });
  assert.equal(digest.msUntilNextFire(), 2 * 60 * 60 * 1000);
});

// --- digest payload builder ---

test('build produces a report with per-process rows, counts, and top errors', () => {
  const now = new Date(2024, 5, 1, 8, 0, 0, 0).getTime();
  const { digest } = make({
    now,
    digestHour: 8,
    procs: [proc('web', { restarts: 2, status: 'online' }), proc('api', { restarts: 5, status: 'errored' })],
    errorsByProc: {
      api: [
        err({ processName: 'api', message: 'ECONNRESET', count: 9, lastSeen: now - 1000 }),
        err({ processName: 'api', message: 'old error', count: 99, lastSeen: now - 48 * 60 * 60 * 1000 }),
      ],
      web: [err({ processName: 'web', message: 'timeout', count: 4, lastSeen: now - 1000 })],
    },
    dispatched: 7,
    suppressed: 3,
  });
  const msg = digest.build();
  assert.match(msg.subject, /PM2 daily digest/);
  // Both processes listed, sorted (api before web).
  assert.ok(msg.text.indexOf('api:') < msg.text.indexOf('web:'));
  assert.match(msg.text, /restarts=5/);
  assert.match(msg.text, /Alerts dispatched: 7/);
  assert.match(msg.text, /Alerts suppressed: 3/);
  // Top errors: only within-24h entries, ranked by count desc. ECONNRESET(9) and timeout(4) kept; old(99) excluded by lastSeen.
  assert.ok(msg.text.indexOf('ECONNRESET') < msg.text.indexOf('timeout'));
  assert.doesNotMatch(msg.text, /old error/);
  assert.match(msg.text, /ERROR_BUFFER_SIZE=500/);
});

test('build notes none when no errors are within the last 24h', () => {
  const now = new Date(2024, 5, 1, 8, 0, 0, 0).getTime();
  const { digest } = make({ now, digestHour: 8, procs: [proc('api')] });
  const msg = digest.build();
  assert.match(msg.text, /none in the last 24h/);
});

// --- fire behavior ---

test('fire sends via sendRaw', async () => {
  const now = new Date(2024, 5, 1, 8, 0, 0, 0).getTime();
  const email = new FakeEmail(true, false);
  const { digest } = make({ now, digestHour: 8, email, procs: [proc('api')] });
  await digest.fire();
  assert.equal(email.sent.length, 1);
});

test('a send failure warns and does not throw', async () => {
  const now = new Date(2024, 5, 1, 8, 0, 0, 0).getTime();
  const email = new FakeEmail(true, true); // sendRaw rejects
  const { digest } = make({ now, digestHour: 8, email, procs: [proc('api')] });
  await digest.fire(); // must not reject
  assert.equal(email.sent.length, 0);
});

test('start does nothing when the email channel is not configured', () => {
  const now = new Date(2024, 5, 1, 8, 0, 0, 0).getTime();
  const email = new FakeEmail(false);
  const { digest } = make({ now, digestHour: 8, email });
  // Should not throw and should not schedule (no timer runs in tests anyway).
  digest.start();
  digest.stop();
  assert.equal(email.sent.length, 0);
});
