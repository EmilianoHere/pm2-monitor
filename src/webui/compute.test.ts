import { test } from 'node:test';
import assert from 'node:assert/strict';

// The compute helpers read localStorage only inside unstableThreshold(), which
// is reached when a classification fn is called WITHOUT an explicit threshold.
// Node has no localStorage, so provide a minimal in-memory stub before import.
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => Array.from(store.keys())[i] ?? null,
  get length() {
    return store.size;
  },
} as Storage;

const {
  DEFAULT_UNSTABLE_THRESHOLD,
  classifyProcess,
  needsAttention,
  attentionCounts,
  attentionSummary,
  projectOf,
  summaryAggregates,
  agentHealth,
} = await import('../../public/js/util/compute.js');

const T = 10;

test('DEFAULT_UNSTABLE_THRESHOLD is 10', () => {
  assert.equal(DEFAULT_UNSTABLE_THRESHOLD, 10);
});

test('classifyProcess / needsAttention cover errored, crash-stopped, unstable, clean-stopped (AC-7)', () => {
  const errored = { status: 'errored', restarts: 0, unstableRestarts: 0 };
  const crashStopped = { status: 'stopped', restarts: 0, unstableRestarts: 3 };
  const unstable = { status: 'online', restarts: 12, unstableRestarts: 0 };
  const cleanStopped = { status: 'stopped', restarts: 0, unstableRestarts: 0 };
  const healthy = { status: 'online', restarts: 1, unstableRestarts: 0 };

  assert.equal(classifyProcess(errored, T), 'crashed');
  assert.equal(classifyProcess(crashStopped, T), 'crashed');
  assert.equal(classifyProcess(unstable, T), 'unstable');
  assert.equal(classifyProcess(cleanStopped, T), 'stopped');
  assert.equal(classifyProcess(healthy, T), 'healthy');

  assert.equal(needsAttention(errored, T), true);
  assert.equal(needsAttention(unstable, T), true);
  assert.equal(needsAttention(cleanStopped, T), false);
  assert.equal(needsAttention(healthy, T), false);
});

test('threshold swap changes the result (AC-8)', () => {
  const p = { status: 'online', restarts: 5, unstableRestarts: 0 };
  assert.equal(classifyProcess(p, 10), 'healthy');
  assert.equal(classifyProcess(p, 3), 'unstable');
});

test('projectOf grouping conventions (AC-13)', () => {
  assert.equal(projectOf('MercadoPagoPuller-detecnologia'), 'detecnologia');
  assert.equal(projectOf('pm2-logrotate'), 'Sistema PM2');
  assert.equal(projectOf('pm2-monitor'), 'Sistema PM2');
  assert.equal(projectOf('pm2-agent'), 'Sistema PM2');
  assert.equal(projectOf('pm2-foo'), 'foo');
  assert.equal(projectOf('worker-'), 'worker');
  assert.equal(projectOf('api'), 'api');
});

test('attentionSummary plural and singular forms (AC-46)', () => {
  assert.equal(attentionSummary({ crashed: 2, unstable: 1 }), '2 detenidos tras crash loop · 1 inestable');
  assert.equal(attentionSummary({ crashed: 1, unstable: 0 }), '1 detenido tras crash loop');
  assert.equal(attentionSummary({ crashed: 0, unstable: 1 }), '1 inestable');
  assert.equal(attentionSummary({ crashed: 0, unstable: 2 }), '2 inestables');
  assert.equal(attentionSummary({ crashed: 0, unstable: 0 }), '');
});

test('attentionCounts aggregates per category', () => {
  const procs = [
    { status: 'errored', restarts: 0, unstableRestarts: 0 }, // crashed
    { status: 'stopped', restarts: 0, unstableRestarts: 2 }, // crashed
    { status: 'online', restarts: 12, unstableRestarts: 0 }, // unstable
    { status: 'online', restarts: 0, unstableRestarts: 0 }, // healthy
  ];
  assert.deepEqual(attentionCounts(procs, T), { crashed: 2, unstable: 1, total: 3 });
});

test('agentHealth segment counts (AC-44)', () => {
  const procs = [
    { status: 'online', restarts: 0, unstableRestarts: 0, memory: 100, cpu: 1 }, // sano
    { status: 'online', restarts: 15, unstableRestarts: 0, memory: 200, cpu: 2 }, // inestable
    { status: 'errored', restarts: 0, unstableRestarts: 0, memory: 300, cpu: 0 }, // crashed
    { status: 'stopped', restarts: 0, unstableRestarts: 0, memory: 0, cpu: 0 }, // clean stop
  ];
  const h = agentHealth(procs, T);
  assert.equal(h.sano, 1);
  assert.equal(h.inestable, 1);
  assert.equal(h.detenido, 2); // crashed + clean-stopped merged
  assert.equal(h.memBytes, 600);
  assert.equal(h.cpuPct, 3);
  assert.equal(h.problems, 2); // inestable + crashed
});

test('summaryAggregates totals (AC-4)', () => {
  const procs = [
    { status: 'online', memory: 100, cpu: 1 },
    { status: 'online', memory: 200, cpu: 2 },
    { status: 'stopped', memory: 0, cpu: 0 },
  ];
  assert.deepEqual(summaryAggregates(procs), {
    total: 3,
    online: 2,
    stopped: 1,
    memBytes: 300,
    cpuPct: 3,
  });
});
