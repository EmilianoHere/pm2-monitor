import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signature } from './signature.js';

test('same error with varying ts/pid/line maps to one signature', () => {
  const a = signature(
    'api',
    'Error: boom\n    at handler (/Users/alice/app/src/server.js:42:17)\n    at next (/Users/alice/app/node_modules/x.js:10:3)',
  );
  const b = signature(
    'api',
    'Error: boom\n    at handler (/Users/alice/app/src/server.js:88:4)\n    at next (/Users/alice/app/node_modules/x.js:11:9)',
  );
  assert.equal(a, b);
});

test('long hex and number runs are normalized away', () => {
  const a = signature('api', 'request 1234567 failed deadbeefcafe1234');
  const b = signature('api', 'request 9876543 failed feedface9999aaaa');
  assert.equal(a, b);
});

test('distinct errors produce distinct signatures', () => {
  const a = signature('api', 'Error: database connection refused');
  const b = signature('api', 'Error: out of memory');
  assert.notEqual(a, b);
});

test('process name is part of the signature', () => {
  const a = signature('api', 'Error: boom');
  const b = signature('worker', 'Error: boom');
  assert.notEqual(a, b);
});

test('returns a 16-char hex string', () => {
  const sig = signature('api', 'Error: boom');
  assert.match(sig, /^[0-9a-f]{16}$/);
});

test('falls back to the first non-empty line without a stack', () => {
  const a = signature('api', '\n\n   Fatal: disk full   \n');
  const b = signature('api', 'Fatal: disk full');
  assert.equal(a, b);
});
