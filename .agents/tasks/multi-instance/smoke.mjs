// End-to-end hub-and-spoke smoke (design §9). Boots a MODE=server and a
// MODE=agent against the real local PM2, with a demo PM2 process, and asserts:
//  1. the agent appears online in GET /api/agents,
//  2. a control command round-trips (restart via /api/agents/:id/.../restart),
//  3. live logs stream in the drill-down (WS log:subscribe with agentId),
//  4. an alias set persists across a server restart,
//  5. MODE unset still serves the identical standalone dashboard shell.
//
// Run from the worktree root:  node .agents/tasks/multi-instance/smoke.mjs
// Requires: npm run build already run, a reachable local PM2 daemon.

import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';

const ROOT = new URL('../../../', import.meta.url).pathname;
// This worktree shares the main checkout's node_modules (no local copy).
const NODE_MODULES = `${ROOT}../../node_modules`;
const PM2_BIN = `${NODE_MODULES}/.bin/pm2`;
const SERVER_PORT = 4599;
const STANDALONE_PORT = 4600;
const API_KEY = 'smoke-api-key';
const AGENT_TOKEN = 'smoke-agent-token';
const DEMO = 'smoke-demo';
const DEMO_SCRIPT = `${ROOT}.agents/tasks/multi-instance/smoke-demo.cjs`;

// A clean base env: keep PATH/HOME etc. but drop any pm2-monitor config that may
// leak from the invoking shell (otherwise e.g. an inherited AUTH_MODE/ALERT_RULES_FILE
// would be validated against a mode that does not want it).
function baseEnv() {
  const out = {};
  const drop = new Set([
    'MODE', 'PORT', 'HOST', 'AUTH_MODE', 'API_KEY', 'BASIC_USER', 'BASIC_PASS',
    'ALERT_RULES_FILE', 'SERVER_URL', 'AGENT_TOKEN', 'AGENT_TOKENS', 'AGENT_NAME',
    'AGENT_ID_FILE', 'AGENT_WS_PATH', 'ALIAS_STORE_FILE', 'TLS_INSECURE',
    'TLS_CERT_FILE', 'TLS_KEY_FILE',
  ]);
  for (const [k, v] of Object.entries(process.env)) {
    if (!drop.has(k)) out[k] = v;
  }
  out.NODE_PATH = NODE_MODULES;
  return out;
}

const children = [];
function boot(env, label) {
  const child = spawn(process.execPath, [`${ROOT}dist/index.js`], {
    cwd: ROOT,
    env: { ...baseEnv(), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`[${label}] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[${label}!] ${d}`));
  children.push(child);
  return child;
}

function pm2(args) {
  return new Promise((resolve) => {
    const c = spawn(PM2_BIN, args, { cwd: ROOT, stdio: 'ignore' });
    c.on('exit', (code) => resolve(code));
    c.on('error', () => resolve(-1));
  });
}

async function get(port, path, auth = true) {
  const headers = auth ? { 'X-API-Key': API_KEY } : {};
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

async function post(port, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function put(port, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'PUT',
    headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function waitFor(fn, { tries = 40, gapMs = 500, what = 'condition' } = {}) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* retry */
    }
    await delay(gapMs);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? ` :: ${detail}` : ''}`);
}

async function cleanup() {
  for (const c of children) {
    try {
      c.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
  await pm2(['delete', DEMO]);
}

async function main() {
  const serverEnv = {
    MODE: 'server',
    PORT: String(SERVER_PORT),
    HOST: '127.0.0.1',
    AUTH_MODE: 'apikey',
    API_KEY,
    AGENT_TOKENS: AGENT_TOKEN,
    ALIAS_STORE_FILE: 'config/agent-aliases.smoke.json',
    AGENT_WS_PATH: '/agent',
    LOG_LEVEL: 'warn',
  };
  const agentEnv = {
    MODE: 'agent',
    // SERVER_URL is the base host; AGENT_WS_PATH (/agent) is appended by joinUrl.
    SERVER_URL: `ws://127.0.0.1:${SERVER_PORT}`,
    AGENT_TOKEN,
    AGENT_NAME: 'smoke-box',
    AGENT_ID_FILE: 'config/agent-id.smoke',
    AGENT_WS_PATH: '/agent',
    // The config schema still requires human-auth config in agent mode (unused
    // there — the agent serves no HTTP); satisfy it with a dummy key.
    AUTH_MODE: 'apikey',
    API_KEY: 'unused-in-agent-mode',
    LOG_LEVEL: 'warn',
  };

  // Fresh alias/id state for a deterministic run.
  await pm2(['delete', DEMO]);
  await spawnQuiet('rm', ['-f', `${ROOT}config/agent-aliases.smoke.json`, `${ROOT}config/agent-id.smoke`]);

  // Demo PM2 process so the agent has something to report + stream.
  await pm2(['start', DEMO_SCRIPT, '--name', DEMO]);

  // Boot server + agent.
  boot(serverEnv, 'server');
  await waitFor(async () => (await get(SERVER_PORT, '/api/system/health', false)).status === 200, {
    what: 'server health',
  });
  const health = await get(SERVER_PORT, '/api/system/health', false);
  record('server health reports mode=server', health.json.mode === 'server', JSON.stringify(health.json));

  boot(agentEnv, 'agent');

  // 1. Agent appears online.
  const agents = await waitFor(
    async () => {
      const r = await get(SERVER_PORT, '/api/agents');
      return r.status === 200 && Array.isArray(r.json) && r.json.find((a) => a.online) ? r.json : null;
    },
    { what: 'an online agent' },
  );
  const agent = agents.find((a) => a.online);
  record('agent online in GET /api/agents', Boolean(agent), JSON.stringify(agent));
  const agentId = agent.id;

  // Wait for the demo process to show up in the agent's process list.
  await waitFor(
    async () => {
      const r = await get(SERVER_PORT, `/api/agents/${agentId}/processes`);
      return r.status === 200 && r.json.find((p) => p.name === DEMO);
    },
    { what: 'demo process visible on the agent' },
  );
  record('demo process visible via /api/agents/:id/processes', true);

  // 3. Live logs stream over WS (do this before the restart so a running demo
  //    is producing lines).
  const logOk = await streamLogs(agentId);
  record('live logs stream in drill-down (WS relay)', logOk);

  // 2. Control round-trip: restart the demo via the fleet route.
  const restart = await post(SERVER_PORT, `/api/agents/${agentId}/processes/${DEMO}/restart`);
  record('control round-trip (restart)', restart.status === 200 && restart.json.ok === true, JSON.stringify(restart.json));

  // 4. Alias set persists across a server restart.
  const aliasVal = 'checkout-smoke';
  const setAlias = await put(SERVER_PORT, `/api/agents/${agentId}/alias`, { alias: aliasVal });
  record('alias set accepted', setAlias.status === 200 && setAlias.json.alias === aliasVal, JSON.stringify(setAlias.json));

  // Restart the fleet (server + agent) and confirm the alias survives — the
  // alias is persisted to ALIAS_STORE_FILE on the server and the agent keeps its
  // stable id in AGENT_ID_FILE, so after both come back the alias is re-attached.
  // Both are bounced (a realistic rolling restart) because the alias is only
  // shown on a LIVE registry row, so the agent must re-register to observe it.
  const serverChild = children[0];
  const agentChild = children[1];
  serverChild.kill('SIGKILL');
  agentChild.kill('SIGKILL');
  await delay(2000);
  boot(serverEnv, 'server2');
  await waitFor(async () => (await get(SERVER_PORT, '/api/system/health', false)).status === 200, {
    what: 'server health after restart',
  });
  boot(agentEnv, 'agent2');
  const afterRestart = await waitFor(
    async () => {
      const r = await get(SERVER_PORT, '/api/agents');
      const a = r.status === 200 && Array.isArray(r.json) ? r.json.find((x) => x.id === agentId) : null;
      return a && a.online && a.alias === aliasVal ? a : null;
    },
    { what: 'alias persisted after fleet restart', tries: 40, gapMs: 500 },
  );
  record('alias persists across restart', afterRestart.alias === aliasVal, JSON.stringify({ alias: afterRestart.alias }));

  // 5. Standalone shell unchanged: boot MODE unset and confirm the health shape
  //    is the standalone one and the dashboard shell is served identically.
  boot(
    { PORT: String(STANDALONE_PORT), HOST: '127.0.0.1', AUTH_MODE: 'apikey', API_KEY, LOG_LEVEL: 'warn' },
    'standalone',
  );
  await waitFor(async () => (await get(STANDALONE_PORT, '/api/system/health', false)).status === 200, {
    what: 'standalone health',
  });
  const saHealth = await get(STANDALONE_PORT, '/api/system/health', false);
  record(
    'standalone health reports mode=standalone with pm2Connected',
    saHealth.json.mode === 'standalone' && 'pm2Connected' in saHealth.json,
    JSON.stringify(saHealth.json),
  );
  const shellServer = await get(SERVER_PORT, '/', false);
  const shellStandalone = await get(STANDALONE_PORT, '/', false);
  record(
    'dashboard shell (index.html) byte-identical across modes',
    shellServer.json === shellStandalone.json,
    `server=${String(shellServer.json).length}B standalone=${String(shellStandalone.json).length}B`,
  );

  const allOk = results.every((r) => r.ok);
  console.log(`\nSMOKE ${allOk ? 'GREEN' : 'RED'} — ${results.filter((r) => r.ok).length}/${results.length} checks passed`);
  return allOk;
}

async function streamLogs(agentId) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${SERVER_PORT}/ws`, [`apikey.${API_KEY}`]);
    let got = false;
    const timer = setTimeout(() => {
      if (!got) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        resolve(false);
      }
    }, 12000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'log:subscribe', agentId, process: DEMO, streams: ['out', 'err'] }));
    });
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === 'log' && msg.agentId === agentId && msg.process === DEMO) {
        got = true;
        clearTimeout(timer);
        ws.close();
        resolve(true);
      }
    });
    ws.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function spawnQuiet(cmd, args) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { stdio: 'ignore' });
    c.on('exit', () => resolve());
    c.on('error', () => resolve());
  });
}

let exitCode = 1;
try {
  const ok = await main();
  exitCode = ok ? 0 : 1;
} catch (err) {
  console.error('SMOKE ERROR', err);
  exitCode = 1;
} finally {
  await cleanup();
  // Give child kills a moment.
  await delay(500);
  process.exit(exitCode);
}
