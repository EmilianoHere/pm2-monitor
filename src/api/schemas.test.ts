import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSchemas } from './schemas.js';

// A schema set that treats a fixed allowlist of absolute paths as existing.
const EXISTING = new Set([
  '/opt/app/server.js',
  '/opt/app/worker.py',
  '/opt/app/ecosystem.config.js',
  '/opt/app/ecosystem.json',
]);
const schemas = buildSchemas({ fileExists: (p) => EXISTING.has(p) });

function parse(schema: ReturnType<typeof buildSchemas>[keyof ReturnType<typeof buildSchemas>], input: unknown) {
  return schema.safeParse(input);
}

// --- process-name injection rejection ---

test('process-name rejects injection / path / whitespace strings', () => {
  for (const name of ['foo; rm -rf /', '../etc', 'a b', 'name|cat', '']) {
    const r = parse(schemas.nameParam, { params: { name }, query: {}, body: {} });
    assert.equal(r.success, false, `expected reject for ${JSON.stringify(name)}`);
  }
});

test('process-name accepts a valid identifier', () => {
  const r = parse(schemas.nameParam, { params: { name: 'api-worker_1.2' }, query: {}, body: {} });
  assert.equal(r.success, true);
});

// --- create-process XOR + bounds + refinements ---

function createBody(body: Record<string, unknown>) {
  return parse(schemas.createProcess, { body, query: {}, params: {} });
}

test('create-process requires exactly one of script/ecosystem', () => {
  assert.equal(createBody({}).success, false, 'neither → reject');
  assert.equal(
    createBody({ script: '/opt/app/server.js', ecosystem: '/opt/app/ecosystem.json' }).success,
    false,
    'both → reject',
  );
  assert.equal(createBody({ script: '/opt/app/server.js' }).success, true, 'script only → ok');
  assert.equal(createBody({ ecosystem: '/opt/app/ecosystem.json' }).success, true, 'ecosystem only → ok');
});

test('create-process rejects a non-absolute / traversal / missing / bad-ext script', () => {
  assert.equal(createBody({ script: 'relative.js' }).success, false, 'not absolute');
  assert.equal(createBody({ script: '/opt/app/../../etc/passwd.js' }).success, false, 'traversal');
  assert.equal(createBody({ script: '/opt/app/missing.js' }).success, false, 'does not exist');
  assert.equal(createBody({ script: '/opt/app/server.txt' }).success, false, 'bad extension');
});

test('create-process clamps instances to 1..128 and enforces cluster', () => {
  assert.equal(createBody({ script: '/opt/app/server.js', instances: 0 }).success, false, 'min 1');
  assert.equal(createBody({ script: '/opt/app/server.js', instances: 129 }).success, false, 'max 128');
  assert.equal(
    createBody({ script: '/opt/app/server.js', instances: 4, exec_mode: 'fork' }).success,
    false,
    'instances>1 with fork rejected',
  );
  const defaulted = createBody({ script: '/opt/app/server.js', instances: 4 });
  assert.equal(defaulted.success, true);
  assert.equal(
    (defaulted.success && (defaulted.data as { body: { exec_mode?: string } }).body.exec_mode) || null,
    'cluster',
    'instances>1 defaults exec_mode to cluster',
  );
});

test('create-process respects ALLOWED_SCRIPT_ROOT when set', () => {
  const rooted = buildSchemas({
    fileExists: () => true,
    allowedScriptRoot: '/opt/app',
  });
  const inside = rooted.createProcess.safeParse({ body: { script: '/opt/app/x.js' }, query: {}, params: {} });
  const outside = rooted.createProcess.safeParse({ body: { script: '/elsewhere/x.js' }, query: {}, params: {} });
  assert.equal(inside.success, true);
  assert.equal(outside.success, false);
});

// --- numeric query clamps ---

test('logs query clamps lines to <=2000 and defaults to 200', () => {
  const def = schemas.logsRequest.safeParse({ params: { name: 'api' }, query: {}, body: {} });
  assert.equal(def.success, true);
  assert.equal(def.success && (def.data as { query: { lines: number } }).query.lines, 200);

  const big = schemas.logsRequest.safeParse({ params: { name: 'api' }, query: { lines: '99999' }, body: {} });
  assert.equal(big.success && (big.data as { query: { lines: number } }).query.lines, 2000);

  const neg = schemas.logsRequest.safeParse({ params: { name: 'api' }, query: { lines: '-5' }, body: {} });
  assert.equal(neg.success, false, 'negative lines rejected');
});

test('metrics query defaults sinceMs to 1h and rejects negatives', () => {
  const def = schemas.metricsRequest.safeParse({ params: { name: 'api' }, query: {}, body: {} });
  assert.equal(def.success && (def.data as { query: { sinceMs: number } }).query.sinceMs, 60 * 60 * 1000);
  const neg = schemas.metricsRequest.safeParse({ params: { name: 'api' }, query: { sinceMs: '-1' }, body: {} });
  assert.equal(neg.success, false);
});

test('errors limit clamps to <=1000', () => {
  const r = schemas.errorsQuery.safeParse({ query: { limit: '5000' }, params: {}, body: {} });
  assert.equal(r.success && (r.data as { query: { limit: number } }).query.limit, 1000);
});
