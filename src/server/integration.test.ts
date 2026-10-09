/**
 * In-process agent<->server integration (AC-59) over loopback `ws` (real
 * sockets, no TLS). It wires a server (FleetRegistry + AgentGateway + WsHub with
 * the fleet log relay) and an agent (AgentConnection + AgentRuntime over an
 * injected fakePm2Client) and exercises the full round trip:
 *   register handshake -> server receives the snapshot
 *   -> a routed control command round-trips (routeControl -> agent executes
 *      against the fake -> correlated response -> HTTP result mapped by
 *      statusForControlCode)
 *   -> a log subscribe relays a log:line to a human client
 *   -> unsubscribe stops it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLogger } from '../core/logger.js';
import { MonitorEvents } from '../core/events.js';
import { MonitorState } from '../core/state.js';
import { MetricsStore } from '../metrics/store.js';
import { ErrorTracker } from '../errors/tracker.js';
import { buildSchemas } from '../api/schemas.js';
import type { Pm2Deps } from '../api/server.js';
import { statusForControlCode } from '../api/routes/controlStatus.js';
import { FleetRegistry, type HumanLogClient, type LogLineForClient } from './registry.js';
import { AgentGateway } from './gateway.js';
import { AgentConnection } from '../agent/connection.js';
import { createWsSocketFactory } from '../agent/wsSocket.js';
import { AgentRuntime } from '../agent/runtime.js';
import { FakePm2Client, makeSnapshot } from '../testutil/fakePm2Client.js';
import type { ControlResult } from '../pm2/client.js';

const silent = createLogger({ level: 'error', sink: () => {} });
const TOKEN = 'integration-token';
const AGENT_ID = 'agent-01';

/** The server HTTP status for a routed ControlResult (ok non-create -> 200). */
function statusForControl(result: ControlResult): number {
  return result.ok ? 200 : statusForControlCode(result.code);
}

/** Waits until `pred()` is true, polling briefly (bounded). */
async function until(pred: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface Fixture {
  registry: FleetRegistry;
  agentEvents: MonitorEvents;
  fakePm2: FakePm2Client;
  close: () => Promise<void>;
}

async function boot(): Promise<Fixture> {
  // --- server side ---
  const server: Server = createServer();
  const registry = new FleetRegistry({ logger: silent, retentionMin: 180, sampleSec: 5, errorBufferSize: 500 });
  const gateway = new AgentGateway({ server, registry, tokens: [TOKEN], wsPath: '/agent', logger: silent });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;

  // --- agent side ---
  const agentEvents = new MonitorEvents();
  const metrics = new MetricsStore({ retentionMin: 180, sampleSec: 5 });
  const errors = new ErrorTracker({ events: agentEvents, bufferSize: 500, logAppend: false, logger: silent });
  const state = new MonitorState({ events: agentEvents, metrics, errors });
  const fakePm2 = new FakePm2Client({ connected: true, processes: [makeSnapshot({ name: 'api' })] });
  const pm2: Pm2Deps = {
    control: (action, name) => fakePm2.control(action, name),
    startNew: (opts) => fakePm2.startNew(opts),
    readLogsTail: (name, lines, opts) => fakePm2.readLogsTail(name, lines, opts),
  };
  // Seed a process so the initial snapshot is non-empty.
  state.applyPm2List([makeSnapshot({ name: 'api' })]);

  const connection = new AgentConnection({
    serverUrl: `ws://127.0.0.1:${port}`,
    wsPath: '/agent',
    agentId: AGENT_ID,
    token: TOKEN,
    meta: { hostname: 'h', platform: 'linux', monitorVersion: '1.0.0', nameHint: 'Alpha' },
    logger: silent,
    socketFactory: createWsSocketFactory(),
  });
  const runtime = new AgentRuntime({
    events: agentEvents,
    state,
    pm2,
    schemas: buildSchemas(),
    logger: silent,
    send: (msg) => connection.send(msg),
    isConnected: () => connection.isRegistered(),
  });
  connection.setHandlers({
    onRegistered: () => runtime.onRegistered(),
    onDisconnected: () => runtime.onDisconnected(),
    onMessage: (msg) => runtime.handleMessage(msg),
  });
  connection.start();

  return {
    registry,
    agentEvents,
    fakePm2,
    close: async () => {
      connection.stop();
      runtime.stop();
      gateway.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test('register handshake lands the agent online in the registry with the snapshot', async () => {
  const fx = await boot();
  try {
    await until(() => fx.registry.get(AGENT_ID)?.online === true);
    const entry = fx.registry.get(AGENT_ID)!;
    assert.equal(entry.online, true);
    assert.equal(entry.meta.nameHint, 'Alpha');
    // The initial snapshot populated the process map.
    await until(() => entry.processes.has('api'));
    assert.ok(entry.processes.has('api'));
  } finally {
    await fx.close();
  }
});

test('a routed control command round-trips through the agent and maps to HTTP 200', async () => {
  const fx = await boot();
  try {
    await until(() => fx.registry.get(AGENT_ID)?.online === true);
    const result: ControlResult = await fx.registry.routeControl(AGENT_ID, 'restart', 'api');
    assert.equal(result.ok, true, 'the agent executed the control against the fake');
    assert.deepEqual(fx.fakePm2.controlCalls, [{ action: 'restart', name: 'api' }]);
    const status = statusForControl(result);
    assert.equal(status, 200);
  } finally {
    await fx.close();
  }
});

test('a routed control for an unknown process maps via statusForControlCode (502 PM2_ERROR)', async () => {
  const fx = await boot();
  try {
    await until(() => fx.registry.get(AGENT_ID)?.online === true);
    const result = await fx.registry.routeControl(AGENT_ID, 'restart', 'ghost');
    assert.equal(result.ok, false);
    assert.equal(statusForControl(result), 502);
  } finally {
    await fx.close();
  }
});

test('a log subscribe relays a log:line to a human client, and unsubscribe stops it', async () => {
  const fx = await boot();
  try {
    await until(() => fx.registry.get(AGENT_ID)?.online === true);
    const got: LogLineForClient[] = [];
    const client: HumanLogClient = { deliver: (l) => got.push(l) };
    fx.registry.subscribeLogs(AGENT_ID, 'api', ['out'], client);

    // Give the upstream log:subscribe a moment to reach the agent runtime.
    await new Promise((r) => setTimeout(r, 50));
    fx.agentEvents.emit('log:line', { process: 'api', stream: 'out', level: 'info', line: 'hello', ts: 5 });
    await until(() => got.length === 1);
    assert.equal(got[0].line, 'hello');
    assert.equal(got[0].agentId, AGENT_ID);

    // Unsubscribe tears down the relay; further lines do not arrive.
    fx.registry.unsubscribeLogs(AGENT_ID, 'api', client);
    await new Promise((r) => setTimeout(r, 50));
    fx.agentEvents.emit('log:line', { process: 'api', stream: 'out', level: 'info', line: 'after', ts: 6 });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(got.length, 1, 'no lines after unsubscribe');
  } finally {
    await fx.close();
  }
});
