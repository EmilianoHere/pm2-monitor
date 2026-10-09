import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldNeutralizeInheritedIpc } from './ipc.js';

test('NODE_CHANNEL_FD set -> neutralize true, reason names NODE_CHANNEL_FD', () => {
  const decision = shouldNeutralizeInheritedIpc({ NODE_CHANNEL_FD: '3' }, false, false);
  assert.equal(decision.neutralize, true);
  assert.match(decision.reason, /NODE_CHANNEL_FD/);
});

test('process.channel present (no NODE_CHANNEL_FD) -> neutralize true', () => {
  const decision = shouldNeutralizeInheritedIpc({}, true, false);
  assert.equal(decision.neutralize, true);
  assert.match(decision.reason, /channel/);
});

test('process.send present (no NODE_CHANNEL_FD) -> neutralize true', () => {
  const decision = shouldNeutralizeInheritedIpc({}, false, true);
  assert.equal(decision.neutralize, true);
  assert.match(decision.reason, /send/);
});

test('empty NODE_CHANNEL_FD and all flags false -> neutralize false', () => {
  const decision = shouldNeutralizeInheritedIpc({ NODE_CHANNEL_FD: '' }, false, false);
  assert.equal(decision.neutralize, false);
  assert.equal(decision.reason, 'no inherited IPC channel');
});

test('all signals absent -> neutralize false', () => {
  const decision = shouldNeutralizeInheritedIpc({}, false, false);
  assert.equal(decision.neutralize, false);
  assert.equal(decision.reason, 'no inherited IPC channel');
});
