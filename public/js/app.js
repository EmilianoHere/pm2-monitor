// Bootstrap + orchestration. Reads/prompts for auth into sessionStorage, opens
// the WebSocket, discovers the run mode, constructs the view registry
// (ProcessesView + DetailPanel, AgentsView in server mode, SettingsView for a
// master session), and hands navigation to the hash router. The router is the
// SOLE owner of window.location.hash; app.renderRoute(route) is the single
// hash -> render path. Row clicks, tab clicks, and Fleet links set the hash and
// re-enter here via hashchange — nothing mutates the DOM/history directly.
//
// Mode discovery: GET /api/system/health carries a `mode` field. In standalone
// the local process snapshot (WS `state`) drives the PROCESOS table; in server
// mode the fleet view lists agents and the per-agent drill-down reuses the SAME
// ProcessesView parameterized by an agentId (REST/tick fed), so only the base
// path changes.

import { api, getAuth, setAuth, clearAuth } from './api.js';
import { WsClient } from './ws.js';
import { Router } from './router.js';
import { ProcessesView } from './views/processes.js';
import { DetailPanel } from './views/detailPanel.js';
import { AgentsView } from './views/agents.js';
import { SettingsView } from './views/settings.js';

// --- DOM refs ---
const els = {
  wsStatus: document.getElementById('ws-status'),
  hostIndicator: document.getElementById('host-indicator'),
  pm2Banner: document.getElementById('pm2-banner'),
  pm2BannerText: document.getElementById('pm2-banner-text'),
  maintToggle: document.getElementById('maintenance-toggle'),
  logout: document.getElementById('logout-btn'),
  nav: document.getElementById('nav'),
  viewProcesses: document.getElementById('view-processes'),
  processesMain: document.getElementById('view-processes-main'),
  detailPanel: document.getElementById('detail-panel'),
  fleet: document.getElementById('view-fleet'),
  settings: document.getElementById('view-settings'),
  confirmModal: document.getElementById('confirm-modal'),
  confirmTitle: document.getElementById('confirm-title'),
  confirmBody: document.getElementById('confirm-body'),
  confirmOk: document.getElementById('confirm-ok'),
  toasts: document.getElementById('toasts'),
};

// Discovered from GET /api/system/health. 'standalone' until proven otherwise so
// the standalone path never waits on the probe.
let mode = 'standalone';

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

// --- shared instances ---
const ws = new WsClient();

// Hash setter handed to the views so a row-select / tab-click / Fleet link just
// writes the hash; the router's hashchange handler re-renders (one-way flow).
const onNavigate = (hash) => {
  location.hash = hash;
};

// The PROCESOS surface (table + summary + banner). One instance serves both
// standalone (WS `state` fed via setProcesses) and server-mode agent drill-down
// (its own AGENT_REFRESH_MS tick re-reads api.agentProcesses).
const processes = new ProcessesView({
  root: els.processesMain,
  confirm: confirmDialog,
  toast,
  onNavigate,
  detailRoot: els.detailPanel,
  mode, // reassigned via setMode-equivalent before router.start()
});

// The right-side detail panel (folds detail.js, composes LogsView).
const detailPanel = new DetailPanel({
  root: els.detailPanel,
  ws,
  toast,
  confirm: confirmDialog,
});

// Keep the detail panel's tiles in sync with every table refresh. setProcesses
// is the single refresh sink for BOTH paths — the standalone WS `state` frame
// (app calls it below) and the server-mode AGENT_REFRESH_MS tick (ProcessesView
// calls it internally) — so wrapping it here updates the panel on both without
// touching the view module (FEAT-002/FEAT-003 contract: parent calls updateFrom
// on each refresh).
const _setProcesses = processes.setProcesses.bind(processes);
processes.setProcesses = (procs) => {
  _setProcesses(procs);
  detailPanel.updateFrom(processes.processes);
};

// Server-mode fleet view (lazily constructed when mode === 'server').
let fleet = null;

// Settings view (lazily constructed when a master session is confirmed via
// whoami). Null until a 200 renders the Settings tab in either mode.
let settings = null;

// The router (constructed in boot once the mode is known).
let router = null;

// Tracks the currently selected process name so renderRoute can tell a scope/
// selection change from a no-op and tear the detail panel down correctly.
let selectedName = null;
// Whether the Fleet view's timer/WS triggers are currently armed.
let fleetActive = false;

// --- route rendering (the single hash -> render path) ---
function renderRoute(route) {
  const view = route.view;

  // Leaving Fleet: stop its timer + WS triggers.
  if (fleetActive && view !== 'fleet') {
    if (fleet) fleet.destroy();
    fleetActive = false;
  }

  // Section visibility.
  els.viewProcesses.hidden = view !== 'processes';
  els.fleet.hidden = view !== 'fleet';
  els.settings.hidden = view !== 'settings';

  // Active tab (Procesos is active for both #/processes and #/fleet/:agentId
  // drill-down since the drill-down parses to view 'processes'; Fleet is active
  // only for the bare fleet list).
  setActiveTab(view === 'fleet' ? 'fleet' : view === 'settings' ? 'settings' : 'processes');

  if (view === 'processes') {
    renderProcesses(route);
  } else if (view === 'fleet') {
    // Clear any lingering selection state from a prior drill-down.
    selectedName = null;
    if (fleet) {
      if (!fleetActive) {
        fleet.start(); // arms the shared-cadence timer + WS triggers + refresh()
        fleetActive = true;
      } else {
        fleet.refresh();
      }
    }
  } else if (view === 'settings') {
    if (settings) {
      settings.mount().catch((err) => toast(`settings failed: ${err.message}`, 'error'));
    }
  }
}

function renderProcesses(route) {
  const agentId = route.agentId || null;
  const name = route.name || null;
  const filter = route.filter === 'problems' ? 'problems' : null;

  // Load/scope the right data set (standalone local vs. a drilled agent) and
  // pre-select the "Con problemas" chip when ?filter=problems is present.
  processes.setScope({ agentId, filter });

  // Host indicator: standalone shows the browser origin; a drill-down adds the
  // agent id (the Fleet card carries the real host meta).
  updateHostIndicator(agentId);

  // Mark the selected row for aria-selected (null clears it).
  processes.select(name);

  // Detail panel lifecycle: mount on a selection, unmount when cleared or when
  // switching rows.
  if (name) {
    if (selectedName !== null && selectedName !== name) detailPanel.unmount();
    showDetailPanel(true);
    detailPanel
      .mount(name, agentId || undefined, processes.processes)
      .catch((err) => toast(`detail failed: ${err.message}`, 'error'));
  } else if (selectedName !== null) {
    detailPanel.unmount();
    showDetailPanel(false);
  } else {
    showDetailPanel(false);
  }
  selectedName = name;
}

function showDetailPanel(visible) {
  els.detailPanel.hidden = !visible;
  els.viewProcesses.classList.toggle('has-detail', visible);
}

// --- top-bar helpers ---
function setActiveTab(route) {
  for (const link of els.nav.querySelectorAll('[data-route]')) {
    const active = link.dataset.route === route;
    link.classList.toggle('is-active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

function updateHostIndicator(agentId) {
  if (!els.hostIndicator) return;
  // location.host is the dashboard origin (not necessarily the monitored PM2
  // host — /api/system/health exposes no hostname). In an agent drill-down we
  // additionally surface the agent id so the operator knows the scope.
  els.hostIndicator.textContent = agentId ? `${location.host} · ${agentId}` : location.host;
}

// --- PM2 connectivity banner (standalone only) ---
function setPm2Connected(connected) {
  els.pm2Banner.hidden = connected;
  if (!connected) {
    els.pm2BannerText.textContent = 'PM2 daemon unreachable — reconnecting…';
  }
}

// --- WebSocket wiring ---
function wireWs() {
  ws.on('open', () => {
    els.wsStatus.textContent = 'En vivo · WS';
    els.wsStatus.classList.add('is-open');
    els.wsStatus.classList.remove('is-closed');
    ws.subscribe(['state', 'alerts']);
  });
  ws.on('close', () => {
    els.wsStatus.textContent = 'Sin conexión';
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
  // The local-state snapshot only drives the standalone PROCESOS table. In server
  // mode there is no single local snapshot (the per-agent grids load via REST and
  // the AGENT_REFRESH_MS tick), so WS state frames are ignored for the grid.
  if (!snapshot) return;
  if (mode === 'server') return;
  setPm2Connected(snapshot.pm2Connected);
  // Keep the maintenance toggle in sync without clobbering an in-flight change.
  if (document.activeElement !== els.maintToggle) {
    els.maintToggle.checked = Boolean(snapshot.maintenance);
  }
  // Feed the table (the wrapped setProcesses also refreshes the detail panel).
  processes.setProcesses(snapshot.processes || []);
}

// --- maintenance toggle ---
els.maintToggle.addEventListener('change', async () => {
  const active = els.maintToggle.checked;
  try {
    await api.setMaintenance({ active });
    toast(`Mantenimiento ${active ? 'activado' : 'desactivado'}`, 'success');
  } catch (err) {
    els.maintToggle.checked = !active; // revert on failure
    toast(`No se pudo cambiar mantenimiento: ${err.message}`, 'error');
  }
});

// --- sign out ---
els.logout.addEventListener('click', () => {
  clearAuth();
  ws.close();
  window.location.reload();
});

// --- boot ---
async function boot() {
  if (!ensureAuth()) {
    els.processesMain.innerHTML =
      '<div class="empty"><p>Se requieren credenciales para usar el dashboard.</p>' +
      '<button type="button" class="btn btn--primary" onclick="location.reload()">Ingresar credenciales</button></div>';
    return;
  }

  // Discover the run mode (unauthenticated). Default stays 'standalone' on error
  // so a probe failure never changes the standalone experience. The resolved
  // health is hoisted so bootServer()/AgentsView can read agentWsPath.
  let health = null;
  try {
    health = await api.health();
    if (health?.mode === 'server') mode = 'server';
  } catch {
    /* non-fatal — assume standalone */
  }

  // Derive the master signal once (whoami 200 => master). Any ApiError/network
  // failure means "not master"; the result is reused by setupSettingsNav so it
  // does not whoami a second time.
  let isMaster = false;
  let who = null;
  try {
    who = await api.whoami();
    isMaster = who?.isMaster === true;
  } catch {
    isMaster = false;
  }

  // Propagate the discovered mode to the processes view (drives its no-agent
  // empty state) now that it is known.
  processes.mode = mode;
  updateHostIndicator(null);

  wireWs();

  if (mode === 'server') {
    await bootServer({ isMaster, health });
  } else {
    await bootStandalone();
  }

  // Master-gated Settings tab (both modes). Only a 200 from whoami renders it;
  // any ApiError/network failure leaves it absent and the route guarded
  // (FR-33/AC-34). Hard enforcement is server-side (requireMaster).
  await setupSettingsNav(who);

  // Hand navigation to the router. It reads the initial hash (or redirects to
  // the mode default), then calls renderRoute. Constructed after whoami so
  // isMaster gates #/settings correctly on the first resolve.
  router = new Router({ mode, isMaster: Boolean(settings), app: { renderRoute } });
  router.start();

  // Keep the WS warm.
  setInterval(() => ws.ping(), 30000);
}

// Appends a Settings nav button and lazily constructs SettingsView when the
// stored credential is master. Runs before router.start() so router.isMaster is
// set when the first route resolves.
async function setupSettingsNav(who) {
  if (!who || who.isMaster !== true) return; // not master — no Settings entry

  settings = new SettingsView({
    root: els.settings,
    api,
    toast,
    confirm: confirmDialog,
    authMode: who.authMode,
  });

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'nav__link';
  btn.dataset.route = 'settings';
  btn.textContent = 'Settings';
  btn.addEventListener('click', () => onNavigate('#/settings'));
  els.nav.appendChild(btn);
}

// Tab clicks set the hash; the router re-renders. (Settings is wired in
// setupSettingsNav since it is appended dynamically.)
els.nav.addEventListener('click', (e) => {
  const link = e.target.closest('[data-route]');
  if (!link) return;
  const route = link.dataset.route;
  if (route === 'processes') onNavigate('#/processes');
  else if (route === 'fleet') onNavigate('#/fleet');
});

async function bootStandalone() {
  // Initial REST load so the grid fills even before the first WS frame, and to
  // surface a 401 early if the credential is wrong.
  try {
    const snapshot = await api.status();
    applySnapshot(snapshot);
  } catch (err) {
    if (err.status === 401) {
      clearAuth();
      toast('Credenciales inválidas — recarga para reingresar.', 'error');
    } else {
      toast(`Carga inicial fallida: ${err.message}`, 'error');
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

async function bootServer({ isMaster = false, health = null } = {}) {
  // The server has no local PM2 daemon, so keep the PM2-unreachable banner hidden
  // (its per-agent equivalent is the pm2-connected badge on each agent card).
  setPm2Connected(true);

  fleet = new AgentsView({
    root: els.fleet,
    onNavigate,
    toast,
    ws,
    isMaster,
    health,
  });

  // Reflect the global maintenance state (401 surfaces here too).
  try {
    const m = await api.getMaintenance();
    els.maintToggle.checked = Boolean(m.active);
  } catch (err) {
    if (err.status === 401) {
      clearAuth();
      toast('Credenciales inválidas — recarga para reingresar.', 'error');
    }
  }
}

boot();
