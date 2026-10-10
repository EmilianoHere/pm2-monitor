// Bootstrap: read/prompt for auth into sessionStorage, open the WebSocket, route
// between the overview and detail views, render the PM2-unreachable banner from
// the WS `pm2` message, and drive the maintenance toggle via POST /api/maintenance.
//
// Mode discovery: GET /api/system/health carries a `mode` field. In standalone
// the dashboard behaves exactly as before — no agent concepts, the local process
// snapshot drives the overview, and every path below is byte-identical to today.
// In server mode the dashboard first shows a fleet overview (agent cards); the
// per-agent overview/detail reuse the SAME components parameterized by an agentId
// so only the REST/WS base path changes.

import { api, getAuth, setAuth, clearAuth } from './api.js';
import { WsClient } from './ws.js';
import { OverviewView } from './views/overview.js';
import { DetailView } from './views/detail.js';
import { AgentsView } from './views/agents.js';

// --- DOM refs ---
const els = {
  wsStatus: document.getElementById('ws-status'),
  pm2Banner: document.getElementById('pm2-banner'),
  pm2BannerText: document.getElementById('pm2-banner-text'),
  maintToggle: document.getElementById('maintenance-toggle'),
  logout: document.getElementById('logout-btn'),
  nav: document.getElementById('nav'),
  overview: document.getElementById('view-overview'),
  detail: document.getElementById('view-detail'),
  fleet: document.getElementById('view-fleet'),
  confirmModal: document.getElementById('confirm-modal'),
  confirmTitle: document.getElementById('confirm-title'),
  confirmBody: document.getElementById('confirm-body'),
  confirmOk: document.getElementById('confirm-ok'),
  toasts: document.getElementById('toasts'),
};

// Discovered from GET /api/system/health. 'standalone' until proven otherwise so
// the standalone path never waits on the probe.
let mode = 'standalone';
// Server mode: the agent currently drilled into (null = showing the fleet).
let activeAgentId = null;

// --- toasts ---
function toast(message, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast--${kind}`;
  el.textContent = message;
  els.toasts.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

// --- confirm dialog (returns a Promise<boolean>) ---
function confirmDialog({ title, body, confirmLabel = 'Confirm' }) {
  return new Promise((resolve) => {
    els.confirmTitle.textContent = title;
    els.confirmBody.textContent = body;
    els.confirmOk.textContent = confirmLabel;
    els.confirmModal.hidden = false;

    const cleanup = (result) => {
      els.confirmModal.hidden = true;
      els.confirmOk.removeEventListener('click', onOk);
      for (const c of cancels) c.removeEventListener('click', onCancel);
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const cancels = els.confirmModal.querySelectorAll('[data-confirm-cancel]');

    els.confirmOk.addEventListener('click', onOk);
    for (const c of cancels) c.addEventListener('click', onCancel);
  });
}

// --- auth prompt ---
function ensureAuth() {
  if (getAuth()) return true;
  const authMode =
    (window.prompt('Auth mode: type "apikey" or "basic"', 'apikey') || '').trim().toLowerCase();
  if (authMode === 'basic') {
    const user = window.prompt('Username:') || '';
    const pass = window.prompt('Password:') || '';
    if (!user) return false;
    setAuth({ mode: 'basic', key: btoa(`${user}:${pass}`) });
    return true;
  }
  const key = window.prompt('API key:') || '';
  if (!key) return false;
  setAuth({ mode: 'apikey', key });
  return true;
}

// --- views + router ---
const ws = new WsClient();

// Standalone views (constructed once, no agent scope). In server mode these are
// rebuilt per selected agent (see mountAgentOverview / mountAgentDetail).
let overview = new OverviewView({
  root: els.overview,
  onOpenDetail: (name) => route('detail', name),
  confirm: confirmDialog,
  toast,
});

let detail = new DetailView({
  root: els.detail,
  ws,
  toast,
  onBack: () => route('overview'),
});

// Server-mode fleet overview (lazily constructed when mode === 'server').
let fleet = null;

let currentRoute = 'overview';

function route(view, name) {
  // Tear down detail (unsubscribes logs) when leaving it.
  if (currentRoute === 'detail' && view !== 'detail') detail.unmount();

  currentRoute = view;
  els.overview.hidden = view !== 'overview';
  els.detail.hidden = view !== 'detail';
  if (els.fleet) els.fleet.hidden = view !== 'fleet';

  if (view === 'detail') {
    detail.mount(name).catch((err) => toast(`detail failed: ${err.message}`, 'error'));
  } else if (view === 'fleet') {
    if (fleet) fleet.refresh();
  } else {
    // overview (same component in both modes; the per-agent variant is bound to
    // an agentId by openAgent)
    overview.render();
  }
}

// --- server-mode fleet wiring ---
function buildNav() {
  // Server mode adds a "Fleet" link; standalone keeps the single Overview link
  // byte-identical.
  if (mode !== 'server') return;
  els.nav.innerHTML =
    '<button type="button" class="nav__link" data-route="fleet">Fleet</button>';
}

function openAgent(agentId) {
  activeAgentId = agentId;
  // Rebuild the overview/detail bound to this agent; the per-agent process grid,
  // control buttons, metrics, and log tail reuse the SAME components.
  overview = new OverviewView({
    root: els.overview,
    onOpenDetail: (name) => route('detail', name),
    confirm: confirmDialog,
    toast,
    agentId,
  });
  detail = new DetailView({
    root: els.detail,
    ws,
    toast,
    onBack: () => route('overview'),
    agentId,
  });
  loadAgentOverview(agentId);
}

async function loadAgentOverview(agentId) {
  route('overview');
  try {
    const procs = await api.agentProcesses(agentId);
    overview.setProcesses(procs || []);
  } catch (err) {
    toast(`agent load failed: ${err.message}`, 'error');
  }
}

// --- PM2 connectivity banner ---
function setPm2Connected(connected) {
  els.pm2Banner.hidden = connected;
  if (!connected) {
    els.pm2BannerText.textContent = 'PM2 daemon unreachable — reconnecting…';
  }
}

// --- WebSocket wiring ---
function wireWs() {
  ws.on('open', () => {
    els.wsStatus.classList.add('is-open');
    els.wsStatus.classList.remove('is-closed');
    ws.subscribe(['state', 'alerts']);
  });
  ws.on('close', () => {
    els.wsStatus.classList.add('is-closed');
    els.wsStatus.classList.remove('is-open');
  });

  ws.on('hello', (msg) => applySnapshot(msg.snapshot));
  ws.on('state', (msg) => applySnapshot(msg.snapshot));
  ws.on('pm2', (msg) => setPm2Connected(msg.connected));
  ws.on('process:transition', () => {
    // The next throttled `state` frame carries the fresh snapshot; nothing to do.
  });
  ws.on('alert', (msg) => {
    const p = msg.payload || {};
    const prefix = msg.delivered ? 'Alert' : 'Alert (suppressed)';
    const who = p.agentAlias || p.agentId;
    const scope = who ? `[${who}] ` : '';
    toast(
      `${prefix}: ${scope}${p.title || p.ruleId || 'rule fired'} — ${p.processName || ''}`,
      'info',
    );
  });

  ws.connect();
}

function applySnapshot(snapshot) {
  // The local-state snapshot only drives the standalone overview. In server mode
  // there is no single local snapshot (the per-agent grids load via REST), so WS
  // state frames are ignored for the process grid.
  if (!snapshot) return;
  if (mode === 'server') return;
  setPm2Connected(snapshot.pm2Connected);
  // Keep the maintenance toggle in sync without clobbering an in-flight change.
  if (document.activeElement !== els.maintToggle) {
    els.maintToggle.checked = Boolean(snapshot.maintenance);
  }
  overview.setProcesses(snapshot.processes || []);
  // Overview re-renders only when it is the active view.
  if (currentRoute === 'overview') overview.render();
}

// --- maintenance toggle ---
els.maintToggle.addEventListener('change', async () => {
  const active = els.maintToggle.checked;
  try {
    await api.setMaintenance({ active });
    toast(`Maintenance ${active ? 'enabled' : 'disabled'}`, 'success');
  } catch (err) {
    els.maintToggle.checked = !active; // revert on failure
    toast(`Maintenance change failed: ${err.message}`, 'error');
  }
});

// --- sign out ---
els.logout.addEventListener('click', () => {
  clearAuth();
  ws.close();
  window.location.reload();
});

// --- nav ---
els.nav.addEventListener('click', (e) => {
  const link = e.target.closest('[data-route]');
  if (link) route(link.dataset.route);
});

// --- boot ---
async function boot() {
  if (!ensureAuth()) {
    els.overview.innerHTML =
      '<div class="empty"><p>Credentials are required to use the dashboard.</p>' +
      '<button type="button" class="btn btn--primary" onclick="location.reload()">Enter credentials</button></div>';
    return;
  }

  // Discover the run mode (unauthenticated). Default stays 'standalone' on error
  // so a probe failure never changes the standalone experience.
  try {
    const health = await api.health();
    if (health && health.mode === 'server') mode = 'server';
  } catch {
    /* non-fatal — assume standalone */
  }

  wireWs();

  if (mode === 'server') {
    await bootServer();
  } else {
    await bootStandalone();
  }

  // Keep the WS warm.
  setInterval(() => ws.ping(), 30000);
}

async function bootStandalone() {
  // Initial REST load so the grid fills even before the first WS frame, and to
  // surface a 401 early if the credential is wrong.
  try {
    const snapshot = await api.status();
    applySnapshot(snapshot);
  } catch (err) {
    if (err.status === 401) {
      clearAuth();
      toast('Invalid credentials — reload to re-enter.', 'error');
    } else {
      toast(`Initial load failed: ${err.message}`, 'error');
    }
  }

  // Reflect current maintenance state.
  try {
    const m = await api.getMaintenance();
    els.maintToggle.checked = Boolean(m.active);
  } catch {
    /* non-fatal */
  }
}

async function bootServer() {
  // The server has no local PM2 daemon, so hide the PM2-unreachable banner (its
  // per-agent equivalent is the pm2-connected badge on each agent card).
  setPm2Connected(true);

  buildNav();
  fleet = new AgentsView({
    root: els.fleet,
    onOpenAgent: (id) => openAgent(id),
    toast,
  });
  route('fleet');

  // Reflect the global maintenance state (401 surfaces here too).
  try {
    const m = await api.getMaintenance();
    els.maintToggle.checked = Boolean(m.active);
  } catch (err) {
    if (err.status === 401) {
      clearAuth();
      toast('Invalid credentials — reload to re-enter.', 'error');
    }
  }
}

boot();
