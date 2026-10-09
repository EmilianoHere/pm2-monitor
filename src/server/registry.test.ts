import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FleetRegistry, type AgentWebSocket, type HumanLogClient, type LogLineForClient } from './registry.js';
import { createLogger } from '../core/logger.js';
import { decode } from '../protocol/codec.js';
import type { ProtocolMessage } from '../protocol/messages.js';
import type { ProcessSnapshot } from '../core/types.js';
import type { ControlResult } from '../pm2/client.js';

const silentLogger = createLogger({ level: 'error', sink: () => {} });

/** A controllable timer harness mirroring the agent/WsHub test pattern. */
function makeTimers() {
  let seq = 0;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  return {
    setTimer: (fn: () => void, ms: number) => {
      seq += 1;
      pending.set(seq, { fn, ms });
      return seq as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (h: ReturnType<typeof setTimeout>) => {
      pending.delete(h as unknown as number);
    },
    fireAll: () => {
      for (const [id, { fn }] of [...pending]) {
        pending.delete(id);
        fn();
      }
    },
    size: () => pending.size,
  };
}

/** A fake server-side agent socket recording decoded outbound frames. */
class FakeAgentSocket implements AgentWebSocket {
  readonly sent: ProtocolMessage[] = [];
  send(data: string): void {
    const r = decode(data);
    if (r.ok) this.sent.push(r.msg);
  }
  lastOfType<T extends ProtocolMessage['type']>(type: T): Extract<ProtocolMessage, { type: T }> | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      if (this.sent[i].type === type) return this.sent[i] as Extract<ProtocolMessage, { type: T }>;
    }
    return undefined;
  }
}

const META = { hostname: 'h', platform: 'linux', monitorVersion: '1.0.0' };

function proc(name: string, status: ProcessSnapshot['status'] = 'online'): ProcessSnapshot {
  return {
    pmId: 0,
    name,
    pid: 1,
    status,
    cpu: 0,
    memory: 0,
    uptimeMs: 0,
    restarts: 0,
    unstableRestarts: 0,
    mode: 'fork',
    instances: 1,
    execPath: null,
    lastUpdated: 1000,
  };
}

function makeRegistry(now = () => 1000) {
  const timers = makeTimers();
  // A varying rand so newCid produces distinct correlation ids per request
  // even when `now` is a fixed clock.
  let r = 0;
  const reg = new FleetRegistry({
    logger: silentLogger,
    retentionMin: 180,
    sampleSec: 5,
    errorBufferSize: 500,
    now,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    rand: () => {
      r = (r + 0.123) % 1;
      return r;
    },
  });
  return { reg, timers };
}

test('keys state by stable id and reuses the entry on re-register', () => {
  const { reg } = makeRegistry();
  const s1 = new FakeAgentSocket();
  const e1 = reg.register('web-01', META, s1);
  e1.metrics.push('api', { ts: 1000, cpu: 1, mem: 1 });

  const s2 = new FakeAgentSocket();
  const e2 = reg.register('web-01', META, s2);
  assert.equal(reg.size, 1, 'same id does not create a second entry');
  assert.equal(e2, e1, 'the retained entry is reused');
  assert.deepEqual(e2.metrics.names(), ['api'], 'history preserved across reconnect');
});

test('online/offline transitions emit fleet events and retain the entry', () => {
  const { reg } = makeRegistry();
  const events: Array<[string, string]> = [];
  reg.on('agent:online', (id) => events.push(['online', id]));
  reg.on('agent:offline', (id) => events.push(['offline', id]));

  reg.register('web-01', META, new FakeAgentSocket());
  reg.markOffline('web-01');
  assert.deepEqual(events, [['online', 'web-01'], ['offline', 'web-01']]);
  const entry = reg.get('web-01');
  assert.ok(entry, 'entry retained after offline');
  assert.equal(entry!.online, false);
});

test('state is isolated across agents', () => {
  const { reg } = makeRegistry();
  reg.register('a', META, new FakeAgentSocket());
  reg.register('b', META, new FakeAgentSocket());
  reg.handleFrame('a', { type: 'update:metrics', samples: [{ name: 'p', ts: 1000, cpu: 10, mem: 10 }] });
  assert.deepEqual(reg.get('a')!.metrics.names(), ['p']);
  assert.deepEqual(reg.get('b')!.metrics.names(), [], 'agent b untouched by agent a');
});

test('routeControl correlates a response to its ControlResult', async () => {
  const { reg } = makeRegistry();
  const socket = new FakeAgentSocket();
  reg.register('web-01', META, socket);
  const p = reg.routeControl('web-01', 'restart', 'api');
  const req = socket.lastOfType('control:request');
  assert.ok(req, 'a control:request was sent');
  const result: ControlResult = { ok: true, process: proc('api') };
  reg.handleFrame('web-01', { type: 'control:response', cid: req!.cid, result });
  assert.deepEqual(await p, result);
});

test('routeControl to an offline agent resolves AGENT_OFFLINE without blocking', async () => {
  const { reg } = makeRegistry();
  reg.register('web-01', META, new FakeAgentSocket());
  reg.markOffline('web-01');
  const r = await reg.routeControl('web-01', 'stop', 'api');
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, 'AGENT_OFFLINE');
});

test('routeControl to an unknown agent resolves AGENT_NOT_FOUND without blocking', async () => {
  const { reg } = makeRegistry();
  const r = await reg.routeControl('ghost', 'stop', 'api');
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, 'AGENT_NOT_FOUND');
});

test('disconnect rejects every in-flight routed command with AGENT_OFFLINE', async () => {
  const { reg } = makeRegistry();
  reg.register('web-01', META, new FakeAgentSocket());
  const p1 = reg.routeControl('web-01', 'restart', 'api');
  const p2 = reg.routeControl('web-01', 'stop', 'worker');
  reg.markOffline('web-01');
  for (const r of await Promise.all([p1, p2])) {
    assert.equal(r.ok, false);
    assert.equal((r as { code: string }).code, 'AGENT_OFFLINE');
  }
});

test('routed command times out to AGENT_TIMEOUT via injected timers (never hangs)', async () => {
  const { reg, timers } = makeRegistry();
  reg.register('web-01', META, new FakeAgentSocket());
  const p = reg.routeControl('web-01', 'restart', 'api');
  timers.fireAll(); // fire the 15s timeout
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, 'AGENT_TIMEOUT');
});

test('log fan-out reaches subscribed human clients only', () => {
  const { reg } = makeRegistry();
  reg.register('web-01', META, new FakeAgentSocket());
  const got: LogLineForClient[] = [];
  const client: HumanLogClient = { deliver: (l) => got.push(l) };
  reg.subscribeLogs('web-01', 'api', ['out'], client);

  reg.handleFrame('web-01', { type: 'log:line', process: 'api', stream: 'out', level: 'info', line: 'hello', ts: 5 });
  reg.handleFrame('web-01', { type: 'log:line', process: 'other', stream: 'out', level: 'info', line: 'nope', ts: 6 });

  assert.equal(got.length, 1, 'only the subscribed process is delivered');
  assert.equal(got[0].line, 'hello');
  assert.equal(got[0].agentId, 'web-01');
});

test('first subscribe sends log:subscribe upstream; last unsubscribe sends log:unsubscribe', () => {
  const { reg } = makeRegistry();
  const socket = new FakeAgentSocket();
  reg.register('web-01', META, socket);
  const c1: HumanLogClient = { deliver: () => {} };
  const c2: HumanLogClient = { deliver: () => {} };

  reg.subscribeLogs('web-01', 'api', ['out', 'err'], c1);
  reg.subscribeLogs('web-01', 'api', ['out', 'err'], c2);
  assert.equal(socket.sent.filter((m) => m.type === 'log:subscribe').length, 1, 'only one upstream subscribe');

  reg.unsubscribeLogs('web-01', 'api', c1);
  assert.equal(socket.lastOfType('log:unsubscribe'), undefined, 'not torn down while a client remains');
  reg.unsubscribeLogs('web-01', 'api', c2);
  assert.ok(socket.lastOfType('log:unsubscribe'), 'last unsubscribe tears down upstream');
});

test('snapshot prune drops a departed process series so it is no longer seen', () => {
  const { reg } = makeRegistry();
  reg.register('web-01', META, new FakeAgentSocket());
  // Two series present via metrics.
  reg.handleFrame('web-01', {
    type: 'update:metrics',
    samples: [
      { name: 'api', ts: 1000, cpu: 99, mem: 1 },
      { name: 'gone', ts: 1000, cpu: 99, mem: 1 },
    ],
  });
  assert.deepEqual(reg.get('web-01')!.metrics.names().sort(), ['api', 'gone']);

  // A snapshot without 'gone' must prune its series.
  reg.handleFrame('web-01', { type: 'snapshot', processes: [proc('api')], pm2Connected: true, generatedAt: 1000 });
  assert.deepEqual(reg.get('web-01')!.metrics.names(), ['api']);
  assert.equal(reg.get('web-01')!.metrics.sustainedAbove('gone', 'cpu', 50, 5), false, 'dead series not evaluated');
});

test('update:metrics alone does NOT prune (only snapshot prunes)', () => {
  const { reg } = makeRegistry();
  reg.register('web-01', META, new FakeAgentSocket());
  reg.handleFrame('web-01', { type: 'update:metrics', samples: [{ name: 'api', ts: 1000, cpu: 1, mem: 1 }] });
  // A later metrics frame missing 'api' must not drop the existing series.
  reg.handleFrame('web-01', { type: 'update:metrics', samples: [{ name: 'worker', ts: 1000, cpu: 1, mem: 1 }] });
  assert.deepEqual(reg.get('web-01')!.metrics.names().sort(), ['api', 'worker']);
});

test('wire ts is pushed verbatim into the per-agent metrics store', () => {
  const { reg } = makeRegistry(() => 9_999_999);
  reg.register('web-01', META, new FakeAgentSocket());
  reg.handleFrame('web-01', { type: 'update:metrics', samples: [{ name: 'api', ts: 42, cpu: 7, mem: 8 }] });
  // getSeries with sinceMs=42 includes a sample stamped exactly 42 → ts verbatim.
  const series = reg.get('web-01')!.metrics.getSeries('api', 42);
  assert.equal(series.length, 1);
  assert.equal(series[0].ts, 42, 'ts not re-stamped with server time');
});
