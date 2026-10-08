import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTeamsCard } from './teams.js';
import type { AlertPayload, AlertSeverity } from './types.js';

function payload(partial: Partial<AlertPayload> = {}): AlertPayload {
  return {
    title: 'api crashed',
    severity: 'critical',
    processName: 'api',
    ruleId: 'api-crash',
    summary: 'The api process entered the errored state.',
    facts: [{ k: 'Status', v: 'errored' }],
    timestamp: Date.parse('2024-01-02T03:04:05.000Z'),
    suppressedCount: 0,
    ...partial,
  };
}

test('buildTeamsCard produces a MessageCard with the fixed envelope', () => {
  const card = buildTeamsCard(payload());
  assert.equal(card['@type'], 'MessageCard');
  assert.equal(card['@context'], 'http://schema.org/extensions');
  assert.equal(card.title, 'api crashed');
  assert.equal(card.summary, 'api crashed');
  assert.equal(card.sections.length, 1);
  assert.equal(card.sections[0].activityTitle, 'api');
  assert.equal(card.sections[0].activitySubtitle, '2024-01-02T03:04:05.000Z');
  assert.equal(card.sections[0].text, 'The api process entered the errored state.');
});

test('buildTeamsCard themeColor varies by severity', () => {
  const colors: Record<AlertSeverity, string> = {
    info: '2EB886',
    warning: 'E3B341',
    critical: 'D23F31',
  };
  for (const severity of ['info', 'warning', 'critical'] as const) {
    const card = buildTeamsCard(payload({ severity }));
    assert.equal(card.themeColor, colors[severity]);
  }
});

test('buildTeamsCard includes process, rule, severity, time, and payload facts', () => {
  const card = buildTeamsCard(payload());
  const facts = card.sections[0].facts;
  const byName = new Map(facts.map((f) => [f.name, f.value]));
  assert.equal(byName.get('Process'), 'api');
  assert.equal(byName.get('Rule'), 'api-crash');
  assert.equal(byName.get('Severity'), 'critical');
  assert.equal(byName.get('Time'), '2024-01-02T03:04:05.000Z');
  // Payload fact is carried through.
  assert.equal(byName.get('Status'), 'errored');
});

test('buildTeamsCard adds a suppressed-count fact only when > 0', () => {
  const none = buildTeamsCard(payload({ suppressedCount: 0 }));
  assert.ok(!none.sections[0].facts.some((f) => f.name === 'Suppressed'));

  const some = buildTeamsCard(payload({ suppressedCount: 4 }));
  const suppressed = some.sections[0].facts.find((f) => f.name === 'Suppressed');
  assert.ok(suppressed);
  assert.match(suppressed.value, /\+4 more since last alert/);
});
