// Right-side process detail panel: folds the old detail.js into the redesigned
// PROCESOS surface. It renders a big name + status label, four metric tiles
// (CPU / Memoria / Uptime / Reinicios), a meta row (PID / Modo / Grupo), an
// action row (Restart / Reload / Stop / Eliminar de PM2…), and composes the
// UNCHANGED LogsView for the live WS log tail. The Chart.js CPU/memory history
// and recent-errors table from detail.js are retained in a collapsible
// "Historial" sub-section below the log tail, preserving the numeric-table
// fallback when the Chart.js CDN is blocked.
//
// Snapshot source (single rule): the parent passes the in-memory table set via
// mount()/updateFrom() so the tiles read from it with NO network call (the warm
// common case). Only a cold deep-link (no snapshot yet) falls back to the
// detail.js fetchProcess lookup. Not wired into app.js until FEAT-005.

import { api } from '../api.js';
import { fmtBytes, fmtUptime } from '../format.js';
import { projectOf, classifyProcess } from '../util/compute.js';
import { LogsView } from './logs.js';

const ONE_HOUR_MS = 60 * 60 * 1000;

/** Action buttons; destructive flags match the CONTROL_BUTTONS gate. */
const ACTIONS = [
  { action: 'restart', label: 'Reiniciar', destructive: true },
  { action: 'reload', label: 'Recargar', destructive: false },
  { action: 'stop', label: 'Detener', destructive: true },
];

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString();
}

/** Human status label derived from classifyProcess (color never the only signal). */
function statusLabel(cls) {
  switch (cls) {
    case 'crashed':
      return 'Detenido · crash loop';
    case 'unstable':
      return 'Online · inestable';
    case 'healthy':
      return 'Online';
    default:
      return 'Detenido';
  }
}

/** The `.status--*` dot modifier for a classification. */
function statusDotClass(cls) {
  if (cls === 'crashed') return 'status--errored';
  if (cls === 'unstable') return 'status--launching';
  if (cls === 'healthy') return 'status--online';
  return 'status--stopped';
}

export class DetailPanel {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.root  the detail-panel column mount point
   * @param {import('../ws.js').WsClient} opts.ws
   * @param {(msg:string, kind?:string)=>void} opts.toast
   * @param {(opts:object)=>Promise<boolean>} opts.confirm  resolves true on confirm
   * @param {string} [opts.agentId]  optional agent scope (server mode)
   */
  constructor({ root, ws, toast, confirm, agentId }) {
    this.root = root;
    this.ws = ws;
    this.toast = toast;
    this.confirm = confirm;
    // Optional agent scope (server mode). Undefined in standalone, so every API
    // call below hits the existing /api/processes paths unchanged.
    this.agentId = agentId;

    /** Currently mounted process name (null when unmounted). */
    this.name = null;
    /** The resolved ProcessSnapshot driving the tiles. */
    this.proc = null;
    /** The last in-memory table set handed in by the parent. */
    this.tableSet = [];
    /** Whether the collapsible Historial sub-section is open. */
    this.historyOpen = false;

    this.logs = null;
    this.chart = null;
  }

  /**
   * Open the panel for `name`. The parent passes the in-memory table set so the
   * tiles read from it with no network call (warm selection). Only a cold
   * deep-link (name absent from the set) hits the fetchProcess fallback.
   * @param {string} name
   * @param {string} [agentId]
   * @param {object[]} [tableSet]  the current in-memory process set
   */
  async mount(name, agentId, tableSet) {
    if (agentId !== undefined) this.agentId = agentId;
    if (Array.isArray(tableSet)) this.tableSet = tableSet;

    this.name = name;
    this.proc = this._fromTableSet(name);

    // Cold deep-link: no snapshot in the table set yet — fall back to a read.
    if (!this.proc) {
      try {
        this.proc = await this.fetchProcess();
      } catch (err) {
        this.renderError(err.message);
        return;
      }
      // A late unmount/switch may have happened during the await.
      if (this.name !== name) return;
    }

    this.render();

    // Compose the live log tail (UNCHANGED LogsView).
    this.logs = new LogsView({
      root: this.root.querySelector('#detail-logs'),
      ws: this.ws,
      toast: this.toast,
      agentId: this.agentId,
    });
    await this.logs.mount(name);

    // History (metrics chart + recent errors) loads lazily when expanded, but
    // kick off the first load now if the operator left it open from before.
    if (this.historyOpen) this._loadHistory();
  }

  /**
   * Tear down the panel: unsubscribe the log tail, drop any chart, clear state.
   */
  unmount() {
    if (this.chart) {
      this.chart.destroy();
      this.chart = null;
    }
    if (this.logs) {
      this.logs.unmount();
      this.logs = null;
    }
    this.name = null;
    this.proc = null;
    this.root.innerHTML = '';
  }

  /**
   * Re-read the selected snapshot from a refreshed table set and re-render the
   * tiles in place. Called by the parent on each table refresh (WS `state` in
   * standalone / AGENT_REFRESH_MS tick in server). The LogsView and Historial
   * sub-section are left untouched so the live tail and chart keep running.
   * @param {object[]} tableSet
   */
  updateFrom(tableSet) {
    if (Array.isArray(tableSet)) this.tableSet = tableSet;
    if (!this.name) return;
    const next = this._fromTableSet(this.name);
    if (!next) return; // keep last-known if the process dropped out mid-refresh
    this.proc = next;
    this._renderTiles();
  }

  /** Find the named process in the current in-memory table set. */
  _fromTableSet(name) {
    return (this.tableSet || []).find((p) => p.name === name) || null;
  }

  /**
   * Cold-path snapshot read (reused from detail.js). Standalone uses
   * GET /api/processes/:name. The agent surface has no single-process read, so
   * in server mode we pull the agent's list and pick by name (same shape).
   */
  async fetchProcess() {
    if (!this.agentId) return api.getProcess(this.name);
    const procs = await api.agentProcesses(this.agentId);
    const match = (procs || []).find((p) => p.name === this.name);
    if (!match) throw new Error(`process "${this.name}" not found on agent`);
    return match;
  }

  renderError(message) {
    this.root.innerHTML = `
      <div class="detail-panel">
        <div class="detail-panel__head">
          <h2 class="detail-panel__name">${escapeHtml(this.name ?? '')}</h2>
        </div>
        <p class="metric__label">Error: ${escapeHtml(message)}</p>
      </div>`;
  }

  render() {
    const p = this.proc;
    const name = this.name;

    this.root.innerHTML = `
      <div class="detail-panel">
        <div class="detail-panel__head" id="detail-head"></div>
        <div class="metric-tiles" id="detail-tiles"></div>
        <dl class="detail-meta" id="detail-meta"></dl>
        <div class="detail-panel__actions">
          ${ACTIONS.map(
            (a) =>
              `<button type="button" class="btn btn--sm" data-action="${a.action}"
                aria-label="${escapeHtml(`${a.label} ${name}`)}">${a.label}</button>`,
          ).join('')}
          <button type="button" class="btn btn--sm btn--danger" data-action="delete"
            aria-label="${escapeHtml(`Eliminar ${name} de PM2`)}">Eliminar de PM2…</button>
        </div>
        <div id="detail-logs"></div>
        <section class="detail-history">
          <button type="button" class="detail-history__toggle" data-history-toggle
            aria-expanded="${this.historyOpen}">
            ${this.historyOpen ? '▾' : '▸'} Historial
          </button>
          <div class="detail-history__body" id="detail-history" ${this.historyOpen ? '' : 'hidden'}></div>
        </section>
      </div>`;

    this._renderTiles();
    this._bind();
    if (this.historyOpen) this._renderHistoryShell();
  }

  /** Render the name/status header, the four metric tiles, and the meta row. */
  _renderTiles() {
    const p = this.proc;
    if (!p) return;

    const cls = classifyProcess(p);
    const label = statusLabel(cls);
    const dotClass = statusDotClass(cls);

    const head = this.root.querySelector('#detail-head');
    if (head) {
      head.innerHTML = `
        <h2 class="detail-panel__name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</h2>
        <span class="status ${dotClass}">${escapeHtml(label)}</span>`;
    }

    const tile = (tLabel, value) => `
      <div class="metric-tile">
        <span class="metric-tile__label">${tLabel}</span>
        <span class="metric-tile__value">${value}</span>
      </div>`;

    const tiles = this.root.querySelector('#detail-tiles');
    if (tiles) {
      tiles.innerHTML = `
        ${tile('CPU', `${(p.cpu ?? 0).toFixed(1)}%`)}
        ${tile('Memoria', fmtBytes(p.memory))}
        ${tile('Uptime', fmtUptime(p.uptimeMs))}
        ${tile('Reinicios', p.restarts ?? 0)}`;
    }

    const meta = this.root.querySelector('#detail-meta');
    if (meta) {
      const row = (dt, dd) =>
        `<div class="detail-meta__row"><dt>${dt}</dt><dd>${dd}</dd></div>`;
      meta.innerHTML = `
        ${row('PID', p.pid ?? '—')}
        ${row('Modo', `${escapeHtml(p.mode)} × ${p.instances}`)}
        ${row('Grupo', escapeHtml(projectOf(p.name)))}`;
    }
  }

  _bind() {
    for (const btn of this.root.querySelectorAll('[data-action]')) {
      btn.addEventListener('click', () => this._handleAction(btn));
    }
    const toggle = this.root.querySelector('[data-history-toggle]');
    if (toggle) {
      toggle.addEventListener('click', () => this._toggleHistory());
    }
  }

  _toggleHistory() {
    this.historyOpen = !this.historyOpen;
    const toggle = this.root.querySelector('[data-history-toggle]');
    const body = this.root.querySelector('#detail-history');
    if (toggle) {
      toggle.setAttribute('aria-expanded', String(this.historyOpen));
      toggle.textContent = `${this.historyOpen ? '▾' : '▸'} Historial`;
    }
    if (!body) return;
    body.hidden = !this.historyOpen;
    if (this.historyOpen) {
      this._renderHistoryShell();
      this._loadHistory();
    }
  }

  _renderHistoryShell() {
    const body = this.root.querySelector('#detail-history');
    if (!body) return;
    body.innerHTML = `
      <div class="panel">
        <h3>CPU / Memoria</h3>
        <div class="chart-wrap"><canvas id="metrics-chart"></canvas><div id="metrics-fallback"></div></div>
      </div>
      <div class="panel" style="margin-top:16px;">
        <h3>Errores recientes</h3>
        <div id="detail-errors"><p class="metric__label">Cargando…</p></div>
      </div>`;
  }

  _loadHistory() {
    this.loadMetrics();
    this.loadErrors();
  }

  /**
   * CPU/memory history chart. Retained verbatim from detail.js: Chart.js via the
   * CDN, degrading to a numeric table when window.Chart is undefined. Failures
   * render inline (no toast).
   */
  async loadMetrics() {
    const canvas = this.root.querySelector('#metrics-chart');
    const fallback = this.root.querySelector('#metrics-fallback');
    if (!canvas || !fallback) return;
    let samples = [];
    try {
      const res = this.agentId
        ? await api.agentMetrics(this.agentId, this.name, ONE_HOUR_MS)
        : await api.metrics(this.name, ONE_HOUR_MS);
      samples = res.samples || [];
    } catch (err) {
      fallback.innerHTML = `<p class="metric__label">No se pudieron cargar métricas: ${escapeHtml(err.message)}</p>`;
      return;
    }

    // Chart.js loaded? If the CDN is blocked, degrade to a numeric table.
    if (typeof window.Chart === 'undefined') {
      canvas.hidden = true;
      fallback.innerHTML = this.metricsTable(samples);
      return;
    }

    const labels = samples.map((s) => fmtTime(s.ts));
    this.chart = new window.Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'CPU %',
            data: samples.map((s) => s.cpu),
            borderColor: '#4c9ffe',
            yAxisID: 'y',
            tension: 0.2,
            pointRadius: 0,
          },
          {
            label: 'Memory (MB)',
            data: samples.map((s) => s.mem / (1024 * 1024)),
            borderColor: '#3fb950',
            yAxisID: 'y1',
            tension: 0.2,
            pointRadius: 0,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          y: { type: 'linear', position: 'left', title: { display: true, text: 'CPU %' } },
          y1: {
            type: 'linear',
            position: 'right',
            grid: { drawOnChartArea: false },
            title: { display: true, text: 'MB' },
          },
        },
      },
    });
  }

  metricsTable(samples) {
    if (samples.length === 0) return '<p class="metric__label">Sin muestras aún.</p>';
    const recent = samples.slice(-30).reverse();
    const rows = recent
      .map(
        (s) =>
          `<tr><td>${fmtTime(s.ts)}</td><td>${s.cpu.toFixed(1)}%</td><td>${fmtBytes(s.mem)}</td></tr>`,
      )
      .join('');
    return `<table class="data-table">
      <thead><tr><th>Hora</th><th>CPU</th><th>Memoria</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
  }

  /** Recent-errors table. Retained from detail.js; failures render inline (no toast). */
  async loadErrors() {
    const el = this.root.querySelector('#detail-errors');
    if (!el) return;
    try {
      const errors = await api.errors({ name: this.name, limit: 50 }, this.agentId);
      if (!errors.length) {
        el.innerHTML = '<p class="metric__label">Sin errores registrados.</p>';
        return;
      }
      const rows = errors
        .map(
          (e) =>
            `<tr><td>${escapeHtml(e.level)}</td><td>${e.count}</td><td>${fmtTime(
              e.lastSeen,
            )}</td><td>${escapeHtml(e.message)}</td></tr>`,
        )
        .join('');
      el.innerHTML = `<table class="data-table">
        <thead><tr><th>Nivel</th><th>Conteo</th><th>Última vez</th><th>Mensaje</th></tr></thead>
        <tbody>${rows}</tbody></table>`;
    } catch (err) {
      el.innerHTML = `<p class="metric__label">Error: ${escapeHtml(err.message)}</p>`;
    }
  }

  async _handleAction(btn) {
    const action = btn.dataset.action;
    const name = this.name;
    const isDelete = action === 'delete';
    const meta = ACTIONS.find((a) => a.action === action);
    const label = isDelete ? 'Eliminar' : meta.label;
    const destructive = isDelete || (meta && meta.destructive);

    if (destructive) {
      const ok = await this.confirm({
        title: isDelete ? `Eliminar ${name} de PM2?` : `${label} ${name}?`,
        body: isDelete
          ? `Se va a eliminar "${name}" de PM2.`
          : `Se va a ${label.toLowerCase()} "${name}".`,
        confirmLabel: label,
      });
      if (!ok) return;
    }

    btn.disabled = true;
    try {
      if (isDelete) {
        await api.deleteProcess(name, this.agentId);
      } else {
        await api.control(name, action, this.agentId);
      }
      this.toast(`${label} enviado a ${name}`, 'success');
    } catch (err) {
      this.toast(`${label} falló: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
    }
  }
}
