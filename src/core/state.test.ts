import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MonitorEvents, type ProcessTransitionEvent } from './events.js';
import { MonitorState } from './state.js';
import { MetricsStore } from '../metrics/store.js';
import { ErrorTracker } from '../errors/tracker.js';
import { createLogger } from './logger.js';
import type { ProcessSnapshot } from './types.js';

const silent = createLogger({ level: 'error', sink: () => {} });

function proc(partial: Partial<ProcessSnapshot> & { name: string }): ProcessSnapshot {
  return {
    pmId: 0,
    pid: 1,
    status: 'online',
    cpu: 10,
    memory: 1000,
    uptimeMs: 1000,
    restarts: 0,
    unstableRestarts: 0,
    mode: 'fork',
    instances: 1,
    execPath: '/app/x.js',
    lastUpdated: 1000,
    ...partial,
  };
}

function makeHub(now: () => number) {
  const events = new MonitorEvents();
  const metrics = new MetricsStore({ retentionMin: 180, sampleSec: 5, now });
  const errors = new ErrorTracker({ events, bufferSize: 100, logAppend: false, logger: silent, now });
  const state = new MonitorState({ events, metrics, errors, now });
  return { events, metrics, errors, state };
}

test('snapshot reflects applied pm2 list and flags', () => {
  let t = 1000;
  const { state } = makeHub(() => t);
  state.applyPm2List([proc({ name: 'api' }), proc({ name: 'worker' })]);
  const snap = state.snapshot();
  assert.equal(snap.processes.length, 2);
  assert.equal(snap.pm2Connected, false);
  assert.equal(snap.maintenance, false);
});

test('applyPm2List emits a transition on status change', () => {
  let t = 1000;
  const { state, events } = makeHub(() => t);
  const transitions: ProcessTransitionEvent[] = [];
  events.on('process:transition', (e) => transitions.push(e));
  state.applyPm2List([proc({ name: 'api', status: 'online' })]);
  state.applyPm2List([proc({ name: 'api', status: 'errored' })]);
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].from, 'online');
  assert.equal(transitions[0].to, 'errored');
});

test('applyPm2List removes processes no longer present', () => {
  let t = 1000;
  const { state } = makeHub(() => t);
  state.applyPm2List([proc({ name: 'api' }), proc({ name: 'worker' })]);
  state.applyPm2List([proc({ name: 'api' })]);
  assert.equal(state.getProcess('worker'), null);
});

test('setConnected toggles flag and emits connectivity events', () => {
  let t = 1000;
  const { state, events } = makeHub(() => t);
  let connectedEvents = 0;
  let disconnectedEvents = 0;
  events.on('pm2:connected', () => (connectedEvents += 1));
  events.on('pm2:disconnected', () => (disconnectedEvents += 1));
  state.setConnected(true);
  state.setConnected(true); // no-op
  state.setConnected(false);
  assert.equal(connectedEvents, 1);
  assert.equal(disconnectedEvents, 1);
  assert.equal(state.isConnected(), false);
});

test('maintenance expires lazily on read', () => {
  let t = 1000;
  const { state } = makeHub(() => t);
  state.setMaintenance({ active: true, durationMin: 1, reason: 'deploy' });
  assert.equal(state.getMaintenance().active, true);
  t += 61 * 1000;
  assert.equal(state.getMaintenance().active, false);
});

test('metrics:tick pushes samples only for online processes', () => {
  let t = 5000;
  const { state, events, metrics } = makeHub(() => t);
  events.emit('metrics:tick', [
    proc({ name: 'api', status: 'online', cpu: 20, memory: 2000, lastUpdated: 5000 }),
    proc({ name: 'worker', status: 'stopped', cpu: 0, memory: 0, lastUpdated: 5000 }),
  ]);
  assert.equal(state.getMetrics('api', 0).length, 1);
  assert.equal(state.getMetrics('worker', 0).length, 0);
  // Sample uses the memory->mem rename.
  assert.equal(state.getMetrics('api', 0)[0].mem, 2000);
  assert.deepEqual(metrics.names(), ['api']);
});

test('metrics:tick prunes series for names no longer present', () => {
  let t = 5000;
  const { state, events } = makeHub(() => t);
  events.emit('metrics:tick', [proc({ name: 'api', status: 'online', lastUpdated: 5000 })]);
  assert.equal(state.getMetrics('api', 0).length, 1);
  // api gone from the next tick -> series dropped.
  events.emit('metrics:tick', [proc({ name: 'worker', status: 'online', lastUpdated: 5000 })]);
  assert.equal(state.getMetrics('api', 0).length, 0);
});
