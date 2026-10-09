import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createHealthRouter, createServerHealthRouter } from './system.js';
import type { ApiDeps } from '../server.js';

async function mount(router: express.Router): Promise<{ base: string; close: () => Promise<void> }> {
  const app = express();
  app.use('/api/system', router);
  const server: Server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function get(base: string, path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}${path}`);
  return (await res.json()) as Record<string, unknown>;
}

test('standalone health gains mode:"standalone" and keeps pm2Connected/maintenance/version/uptimeMs', async () => {
  const deps = {
    state: {
      isConnected: () => true,
      getMaintenance: () => ({ active: false }),
    },
    now: () => 5000,
    startedAt: 1000,
    version: '1.0.0',
  } as unknown as ApiDeps;
  const h = await mount(createHealthRouter(deps));
  try {
    const body = await get(h.base, '/api/system/health');
    assert.equal(body.status, 'ok');
    assert.equal(body.mode, 'standalone');
    assert.equal(body.pm2Connected, true);
    assert.equal(body.maintenance, false);
    assert.equal(body.version, '1.0.0');
    assert.equal(body.uptimeMs, 4000);
  } finally {
    await h.close();
  }
});

test('createServerHealthRouter reports mode:"server" with an agents summary and NO pm2Connected', async () => {
  const router = createServerHealthRouter({
    maintenance: { getMaintenance: () => ({ active: true }) },
    registry: { size: 3, onlineCount: () => 2 },
    version: '1.0.0',
    startedAt: 1000,
    now: () => 9000,
  });
  const h = await mount(router);
  try {
    const body = await get(h.base, '/api/system/health');
    assert.equal(body.status, 'ok');
    assert.equal(body.mode, 'server');
    assert.equal(body.maintenance, true);
    assert.deepEqual(body.agents, { total: 3, online: 2 });
    assert.equal(body.version, '1.0.0');
    assert.equal(body.uptimeMs, 8000);
    assert.ok(!('pm2Connected' in body), 'server health omits pm2Connected');
  } finally {
    await h.close();
  }
});
