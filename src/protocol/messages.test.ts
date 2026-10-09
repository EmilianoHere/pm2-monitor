import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  processSnapshotSchema,
  metricSampleSchema,
  logLineSchema,
  trackedErrorSchema,
  controlResultSchema,
} from './shapes.js';
import type {
  ProcessSnapshot,
  MetricSample,
  LogLine,
  TrackedError,
} from '../core/types.js';
import type { ControlResult } from '../pm2/client.js';

// Compile-time: the inferred schema types must be assignable to the existing
// interfaces (and vice versa). If a mirror drifts, these annotations fail to
// compile. The AssertEqual pins in shapes.ts are the primary guard; these are
// a second, test-local assertion that the inferred types line up.
test('inferred shape types are assignable to the core interfaces', () => {
  const snap = processSnapshotSchema.parse({
    pmId: 1,
    name: 'api',
    pid: null,
    status: 'online',
    cpu: 1,
    memory: 2,
    uptimeMs: null,
    restarts: 0,
    unstableRestarts: 0,
    mode: 'fork',
    instances: 1,
    execPath: null,
    lastUpdated: 3,
  });
  const asSnapshot: ProcessSnapshot = snap;
  assert.equal(asSnapshot.name, 'api');

  const sample = metricSampleSchema.parse({ ts: 1, cpu: 2, mem: 3 });
  const asSample: MetricSample = sample;
  assert.equal(asSample.ts, 1);

  const line = logLineSchema.parse({ stream: 'out', level: 'info', line: 'x', ts: 1 });
  const asLine: LogLine = line;
  assert.equal(asLine.line, 'x');

  const err = trackedErrorSchema.parse({
    signature: 's',
    processName: 'api',
    firstSeen: 1,
    lastSeen: 2,
    count: 3,
    level: 'error',
    message: 'm',
    sample: 'x',
  });
  const asErr: TrackedError = err;
  assert.equal(asErr.count, 3);

  const okResult = controlResultSchema.parse({ ok: true, process: snap });
  const asResult: ControlResult = okResult;
  assert.equal(asResult.ok, true);

  const failResult = controlResultSchema.parse({ ok: false, code: 'X', message: 'm' });
  const asFail: ControlResult = failResult;
  assert.equal(asFail.ok, false);
});

test('shape schemas reject malformed data', () => {
  assert.equal(processSnapshotSchema.safeParse({ name: 'api' }).success, false);
  assert.equal(metricSampleSchema.safeParse({ ts: 'x', cpu: 1, mem: 2 }).success, false);
  assert.equal(logLineSchema.safeParse({ stream: 'bad', level: 'info', line: 'x', ts: 1 }).success, false);
});
