import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeEffectiveConfig,
  parseConfig,
  settingsPatchSchema,
  type AppConfig,
} from './env.js';

/** A fully-parsed baseline AppConfig built from a minimal valid apikey env. */
function base(): AppConfig {
  const result = parseConfig({ API_KEY: 'master-key' } as NodeJS.ProcessEnv);
  assert.equal(result.success, true);
  if (!result.success) throw new Error('baseline parse failed');
  return result.data;
}

test('empty overlays produce a result deep-equal to base (re-parse idempotence)', () => {
  const b = base();
  const merged = mergeEffectiveConfig(b, {}, {});
  assert.deepEqual({ ...merged }, { ...b });
});

test('mergeEffectiveConfig returns a frozen object', () => {
  const merged = mergeEffectiveConfig(base(), {}, {});
  assert.equal(Object.isFrozen(merged), true);
});

test('a settings overlay value overrides base', () => {
  const b = base();
  assert.equal(b.LOG_LEVEL, 'info');
  assert.equal(b.DEFAULT_COOLDOWN_SEC, 300);
  const merged = mergeEffectiveConfig(b, { LOG_LEVEL: 'debug', DEFAULT_COOLDOWN_SEC: 120 }, {});
  assert.equal(merged.LOG_LEVEL, 'debug');
  assert.equal(merged.DEFAULT_COOLDOWN_SEC, 120);
});

test('precedence: .env -> settings -> secrets, secrets wins last', () => {
  const b = base();
  // TEAMS_WEBHOOK_URL is a secret-overlay key; it must win over any earlier layer.
  const merged = mergeEffectiveConfig(
    b,
    { LOG_LEVEL: 'warn' },
    { TEAMS_WEBHOOK_URL: 'https://hooks.example/incoming' },
  );
  assert.equal(merged.LOG_LEVEL, 'warn');
  assert.equal(merged.TEAMS_WEBHOOK_URL, 'https://hooks.example/incoming');
  // base master key is untouched by the overlays.
  assert.equal(merged.API_KEY, 'master-key');
});

test('settingsPatchSchema.strict() rejects an unknown key', () => {
  const result = settingsPatchSchema.safeParse({ NOT_A_REAL_KEY: 1 });
  assert.equal(result.success, false);
});

test('settingsPatchSchema rejects a wrong-typed field', () => {
  const result = settingsPatchSchema.safeParse({ LOG_LEVEL: 'verbose' });
  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(result.error.issues.some((i) => i.path.join('.') === 'LOG_LEVEL'));
  }
});

test('settingsPatchSchema accepts a valid partial patch', () => {
  const result = settingsPatchSchema.safeParse({ LOG_LEVEL: 'debug' });
  assert.equal(result.success, true);
});
