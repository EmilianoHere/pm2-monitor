import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusForControlCode } from './controlStatus.js';

test('statusForControlCode maps the full fleet code table', () => {
  assert.equal(statusForControlCode('PM2_UNAVAILABLE'), 409);
  assert.equal(statusForControlCode('AGENT_OFFLINE'), 409);
  assert.equal(statusForControlCode('AGENT_TIMEOUT'), 409);
  assert.equal(statusForControlCode('AGENT_NOT_FOUND'), 404);
  assert.equal(statusForControlCode('VALIDATION'), 400);
  assert.equal(statusForControlCode('PM2_ERROR'), 502);
});

test('an unknown/default code maps to 502', () => {
  assert.equal(statusForControlCode('SOMETHING_ELSE'), 502);
  assert.equal(statusForControlCode(''), 502);
});

test('the fleet mapper diverges from the standalone binary branch for VALIDATION', () => {
  // The standalone sendControlResult in processes.ts is a binary branch
  // (PM2_UNAVAILABLE ? 409 : 502), so a VALIDATION there would be 502. The fleet
  // mapper deliberately returns 400 for VALIDATION — a distinct, richer table.
  // This asserts the fleet path does NOT collapse VALIDATION to the binary 502.
  const standaloneBinary = (code: string): number => (code === 'PM2_UNAVAILABLE' ? 409 : 502);
  assert.equal(standaloneBinary('VALIDATION'), 502, 'standalone binary would be 502');
  assert.equal(statusForControlCode('VALIDATION'), 400, 'fleet mapper is 400');
  // The two agree on the codes standalone actually produces.
  assert.equal(standaloneBinary('PM2_UNAVAILABLE'), statusForControlCode('PM2_UNAVAILABLE'));
  assert.equal(standaloneBinary('PM2_ERROR'), statusForControlCode('PM2_ERROR'));
});
