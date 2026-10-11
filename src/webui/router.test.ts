import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseHash, buildHash } from '../../public/js/router.js';

test('parseHash maps the processes routes', () => {
  assert.deepEqual(parseHash('#/processes'), {
    view: 'processes',
    agentId: null,
    name: null,
    filter: null,
  });
  assert.deepEqual(parseHash('#/processes/api'), {
    view: 'processes',
    agentId: null,
    name: 'api',
    filter: null,
  });
  assert.deepEqual(parseHash('#/processes?filter=problems'), {
    view: 'processes',
    agentId: null,
    name: null,
    filter: 'problems',
  });
});

test('parseHash maps the fleet drill-down to the processes view', () => {
  assert.deepEqual(parseHash('#/fleet'), {
    view: 'fleet',
    agentId: null,
    name: null,
    filter: null,
  });
  assert.deepEqual(parseHash('#/fleet/agent-1/api'), {
    view: 'processes',
    agentId: 'agent-1',
    name: 'api',
    filter: null,
  });
});

test('filter only honors the exact value problems', () => {
  assert.equal(parseHash('#/processes?filter=bogus').filter, null);
  assert.equal(parseHash('#/processes?filter=problems').filter, 'problems');
});

test('buildHash(parseHash(h)) round-trips the route table', () => {
  for (const h of [
    '#/processes',
    '#/processes/api',
    '#/processes/api?filter=problems',
    '#/fleet',
    '#/fleet/agent-1',
    '#/fleet/agent-1/api',
    '#/fleet/agent-1/api?filter=problems',
    '#/settings',
  ]) {
    assert.equal(buildHash(parseHash(h)), h, `round-trip failed for ${h}`);
  }
});

test('reserved chars in a name are percent-encoded and decoded back exactly (AC-30, AC-32)', () => {
  const name = 'My/Proc?x y';
  const built = buildHash({ view: 'processes', agentId: null, name, filter: null });
  // The reserved chars must be encoded in the hash (no literal '/', '?', ' ').
  assert.ok(!built.includes('My/Proc'), 'slash must be encoded');
  assert.ok(built.includes('%2F') && built.includes('%3F') && built.includes('%20'));
  // ...and decode back to the exact original name.
  assert.equal(parseHash(built).name, name);
});

test('an encoded ? inside the name is not mistaken for the query delimiter', () => {
  const name = 'weird?name';
  const built = buildHash({ view: 'processes', agentId: null, name, filter: 'problems' });
  const parsed = parseHash(built);
  assert.equal(parsed.name, name);
  assert.equal(parsed.filter, 'problems');
});

test('a fleet/:agentId/:name route with reserved chars round-trips', () => {
  const route = { view: 'processes', agentId: 'ag/1', name: 'p p', filter: null };
  assert.deepEqual(parseHash(buildHash(route)), route);
});
