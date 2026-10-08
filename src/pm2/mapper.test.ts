import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateList,
  mapProcess,
  normalizeEventName,
  normalizeException,
  normalizeProc,
  toProcStatus,
  type RawProcess,
} from './mapper.js';
import { createLogger } from '../core/logger.js';

const NOW = 1_000_000;

// --- recorded pm2.list fixtures ---

function fixture(partial: Partial<RawProcess> & { pm2_env?: Record<string, unknown> } = {}): RawProcess {
  const { pm2_env: envOverride, ...rest } = partial;
  return {
    name: 'api',
    pid: 4242,
    pm_id: 0,
    monit: { cpu: 12.5, memory: 50_000_000 },
    ...rest,
    pm2_env: {
      status: 'online',
      pm_uptime: NOW - 60_000,
      restart_time: 3,
      unstable_restarts: 1,
      instances: 1,
      exec_mode: 'fork_mode',
      pm_exec_path: '/srv/api/index.js',
      pm_out_log_path: '/root/.pm2/logs/api-out.log',
      pm_err_log_path: '/root/.pm2/logs/api-error.log',
      ...(envOverride ?? {}),
    },
  };
}

test('mapProcess maps a fork process record', () => {
  const snap = mapProcess(fixture(), NOW);
  assert.equal(snap.name, 'api');
  assert.equal(snap.pmId, 0);
  assert.equal(snap.pid, 4242);
  assert.equal(snap.status, 'online');
  assert.equal(snap.cpu, 12.5);
  assert.equal(snap.memory, 50_000_000);
  assert.equal(snap.uptimeMs, 60_000);
  assert.equal(snap.restarts, 3);
  assert.equal(snap.unstableRestarts, 1);
  assert.equal(snap.mode, 'fork');
  assert.equal(snap.instances, 1);
  assert.equal(snap.execPath, '/srv/api/index.js');
  assert.equal(snap.lastUpdated, NOW);
});

test('mapProcess reports cluster mode and null uptime when not online', () => {
  const snap = mapProcess(fixture({ pm2_env: { status: 'stopped', exec_mode: 'cluster_mode' } }), NOW);
  assert.equal(snap.mode, 'cluster');
  assert.equal(snap.status, 'stopped');
  assert.equal(snap.uptimeMs, null);
});

test('mapProcess defaults missing fields safely', () => {
  const snap = mapProcess({ pm2_env: {} }, NOW);
  assert.equal(snap.name, 'unknown');
  assert.equal(snap.pid, null);
  assert.equal(snap.status, 'unknown');
  assert.equal(snap.cpu, 0);
  assert.equal(snap.memory, 0);
  assert.equal(snap.instances, 1);
  assert.equal(snap.execPath, null);
});

test('toProcStatus coerces unknown strings to "unknown"', () => {
  assert.equal(toProcStatus('online'), 'online');
  assert.equal(toProcStatus('errored'), 'errored');
  assert.equal(toProcStatus('weird'), 'unknown');
  assert.equal(toProcStatus(undefined), 'unknown');
});

test('aggregateList sums cpu/memory and counts instances for a cluster name', () => {
  const list: RawProcess[] = [
    fixture({ pm_id: 1, monit: { cpu: 10, memory: 100 }, pm2_env: { status: 'online', exec_mode: 'cluster_mode' } }),
    fixture({ pm_id: 0, monit: { cpu: 20, memory: 200 }, pm2_env: { status: 'online', exec_mode: 'cluster_mode' } }),
    fixture({ pm_id: 2, monit: { cpu: 5, memory: 300 }, pm2_env: { status: 'online', exec_mode: 'cluster_mode' } }),
  ];
  const [agg] = aggregateList(list, undefined, NOW);
  assert.equal(agg.name, 'api');
  assert.equal(agg.instances, 3);
  assert.equal(agg.cpu, 35);
  assert.equal(agg.memory, 600);
  // Primary = lowest pm_id.
  assert.equal(agg.pmId, 0);
  assert.equal(agg.mode, 'cluster');
});

test('aggregateList keeps distinct names separate', () => {
  const list: RawProcess[] = [fixture({ name: 'api', pm_id: 0 }), fixture({ name: 'worker', pm_id: 1 })];
  const out = aggregateList(list, undefined, NOW);
  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((p) => p.name).sort(),
    ['api', 'worker'],
  );
});

test('aggregateList warns once on a name collision across differing pm_ids', () => {
  const lines: string[] = [];
  const logger = createLogger({ level: 'warn', sink: (l) => lines.push(l) });
  const list: RawProcess[] = [
    fixture({ name: 'dup', pm_id: 0 }),
    fixture({ name: 'dup', pm_id: 1 }),
  ];
  aggregateList(list, logger, NOW);
  aggregateList(list, logger, NOW); // second call must not log again (warnOnce)
  const collisionWarns = lines.filter((l) => l.includes('duplicate pm2 process name'));
  assert.equal(collisionWarns.length, 1);
});

// --- bus packet normalizers: flat vs nested layouts ---

test('normalizeEventName resolves the flat layout', () => {
  assert.equal(normalizeEventName({ event: 'restart', process: { name: 'api', pm_id: 0 } }), 'restart');
});

test('normalizeEventName resolves the nested (data) layout', () => {
  assert.equal(normalizeEventName({ data: { event: 'stop' } }), 'stop');
});

test('normalizeEventName returns null for a malformed packet', () => {
  assert.equal(normalizeEventName({}), null);
  assert.equal(normalizeEventName(null), null);
});

test('normalizeProc resolves the flat layout', () => {
  assert.deepEqual(normalizeProc({ event: 'online', process: { name: 'api', pm_id: 7 } }), {
    name: 'api',
    pmId: 7,
  });
});

test('normalizeProc resolves the nested (data) layout', () => {
  assert.deepEqual(normalizeProc({ data: { process: { name: 'worker', pm_id: 3 } } }), {
    name: 'worker',
    pmId: 3,
  });
});

test('normalizeProc returns null when no name is present', () => {
  assert.equal(normalizeProc({ process: { pm_id: 1 } }), null);
  assert.equal(normalizeProc({}), null);
});

test('normalizeException reads a structured {message,stack} data payload', () => {
  const r = normalizeException({ message: 'boom', stack: 'Error: boom\n at x (/a/b.js:1:1)' });
  assert.equal(r.message, 'boom');
  assert.ok(r.stack.includes('Error: boom'));
});

test('normalizeException falls back to message then String(data)', () => {
  assert.equal(normalizeException({ message: 'only message' }).message, 'only message');
  assert.equal(normalizeException('raw string crash').message, 'raw string crash');
});
