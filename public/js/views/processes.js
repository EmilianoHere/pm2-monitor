// PROCESOS view: the shared, router-driven process surface that folds the old
// overview.js card grid into a dense, searchable / filterable / groupable
// semantic table plus five summary cards and an attention banner. One component
// serves both standalone (WS `state` fed via setProcesses) and server-mode agent
// drill-down (a dedicated AGENT_REFRESH_MS tick re-reads api.agentProcesses). It
// does NOT wire itself into app.js yet (FEAT-005 performs the atomic switchover);
// the setProcesses/render contract is preserved verbatim from overview.js so the
// switchover is a one-line rename.

import { api } from '../api.js';
import {
  summaryAggregates,
  classifyProcess,
  needsAttention,
  attentionCounts,
  attentionSummary,
  projectOf,
  unstableThreshold,
} from '../util/compute.js';
import { fmtBytes, fmtBytesTotal, fmtUptime } from '../format.js';

/**
 * Shared refresh cadence (ms) for the server-mode agent tick. Defined once here
 * and imported by the Fleet view (FEAT-003) so "the tick" names a single value
 * (design: "Server-mode processes-view refresh tick"). 15s aligns to the stated
 * gateway heartbeat.
 */
export const AGENT_REFRESH_MS = 15000;

/** Minimum ms between consecutive refresh-tick failure toasts. */
const FAIL_TOAST_THROTTLE_MS = 10000;

/** Per-row control buttons; destructive flags match overview.js's CONTROL_BUTTONS. */
const ROW_ACTIONS = [
  { action: 'restart', label: 'Reiniciar', icon: '↻', destructive: true },
  { action: 'reload', label: 'Recargar', icon: '⟳', destructive: false },
  { action: 'stop', label: 'Detener', icon: '■', destructive: true },
];

/** Filter chips in display order. `key` matches the classification/status test. */
const CHIPS = [
  { key: 'all', label: 'Todos' },
  { key: 'online', label: 'Online' },
  { key: 'stopped', label: 'Detenidos' },
  { key: 'problems', label: 'Con problemas' },
];

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Human status label derived from classifyProcess (color is never the only signal). */
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

/** Clamp a 0..n value to a 0..100 width percentage. */
function pct(value, max) {
  if (!Number.isFinite(value) || value <= 0 || max <= 0) return 0;
  return Math.min(100, (value / max) * 100);
}

export class ProcessesView {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.root
   * @param {(name:string|null)=>void} [opts.onSelect]  optional; invoked after onNavigate for selection side-effects
   * @param {(opts:object)=>Promise<boolean>} opts.confirm  resolves true on confirm
   * @param {(msg:string, kind?:string)=>void} opts.toast
   * @param {(hash:string)=>void} opts.onNavigate  sets location.hash (row select -> hash, not DOM mutation)
   * @param {HTMLElement} [opts.detailRoot]  optional detail panel container passed through to onSelect wiring
   * @param {'standalone'|'server'} [opts.mode]  run mode; drives the no-agent empty state in server mode
   */
  constructor({ root, onSelect, confirm, toast, onNavigate, detailRoot, mode = 'standalone' }) {
    this.root = root;
    this.onSelect = onSelect;
    this.confirm = confirm;
    this.toast = toast;
    this.onNavigate = onNavigate;
    this.detailRoot = detailRoot;
    this.mode = mode;

    /** Agent scope (server mode). null => standalone (WS-fed), never ticks. */
    this.agentId = null;
    /** Active filter chip key. */
    this.filter = 'all';
    /** Case-insensitive name search substring. */
    this.search = '';
    /** Grouping toggle (default ON per FR-17/AC-12). */
    this.grouped = true;
    /** Currently selected process name (aria-selected row). */
    this.selected = null;

    /** The full scoped process set (summary totals derive from THIS, never filtered). */
    this.processes = [];

    this._interval = null;
    this._lastFailToast = 0;
  }

  /**
   * Set the active scope and (server mode) arm/replace the refresh tick.
   * @param {{ agentId?: string|null, filter?: ('problems'|null) }} [opts]
   */
  setScope({ agentId = null, filter = null } = {}) {
    const nextAgent = agentId || null;
    if (nextAgent !== this.agentId) {
      this._clearInterval();
      this.agentId = nextAgent;
    }

    // Pre-select the chip matching an incoming deep-linked filter.
    this.filter = filter === 'problems' ? 'problems' : 'all';

    if (this.agentId) {
      // Server-mode agent scope: load once now, then tick in place.
      this._armInterval();
      this._fetchAgent();
    }
    // Standalone (agentId null): never arm a timer; the table is WS `state` fed
    // via setProcesses. Render current state (may be the server-mode empty state).
    this.render();
  }

  /** Clear the current selection (null) or set it; re-renders aria-selected. */
  select(name) {
    this.selected = name || null;
    if (this.onSelect) this.onSelect(this.selected);
    this.render();
  }

  /**
   * Replace the scoped process set and re-render. Preserves the overview.js
   * contract so app.js's WS-state wiring works via a one-line rename later.
   * @param {object[]} processes
   */
  setProcesses(processes) {
    this.processes = Array.isArray(processes) ? processes : [];
    this.render();
  }

  /** Tear down timers (route exit). */
  destroy() {
    this._clearInterval();
  }

  _armInterval() {
    if (this._interval) return;
    this._interval = setInterval(() => this._fetchAgent(), AGENT_REFRESH_MS);
  }

  _clearInterval() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  }

  async _fetchAgent() {
    const agentId = this.agentId;
    if (!agentId) return;
    try {
      const procs = await api.agentProcesses(agentId);
      // Ignore a late response if the scope changed mid-flight.
      if (this.agentId !== agentId) return;
      this.setProcesses(procs);
    } catch (err) {
      const now = Date.now();
      if (now - this._lastFailToast >= FAIL_TOAST_THROTTLE_MS) {
        this._lastFailToast = now;
        this.toast(`No se pudo actualizar procesos: ${err.message}`, 'error');
      }
      // Keep the last-known table in place; the next tick retries.
    }
  }

  render() {
    // Server-mode defense-in-depth: no agent selected -> prompt to pick one in
    // Fleet instead of rendering an empty/stale table (design: "Processes-view
    // empty state"). The router normally redirects before this is reached.
    if (this.mode === 'server' && !this.agentId) {
      this.root.innerHTML = `
        <div class="section-head"><h1>Procesos</h1></div>
        <div class="empty">
          <p>Selecciona un agente en Fleet para ver sus procesos.</p>
          <button type="button" class="btn" data-go-fleet>Ir a Fleet</button>
        </div>`;
      const go = this.root.querySelector('[data-go-fleet]');
      if (go) go.addEventListener('click', () => this.onNavigate('#/fleet'));
      return;
    }

    const threshold = unstableThreshold(); // read FRESH every render (AC-8)
    const procs = this.processes;

    const summary = summaryAggregates(procs);
    const counts = attentionCounts(procs, threshold);

    const head = `
      <div class="section-head">
        <h1>Procesos</h1>
        <span class="metric__label">${procs.length} proceso${procs.length === 1 ? '' : 's'}</span>
      </div>`;

    const summaryHtml = this._summaryHtml(summary);
    const bannerHtml = this._bannerHtml(counts);
    const controlsHtml = this._controlsHtml(procs, threshold);
    const tableHtml = this._tableHtml(procs, threshold);

    this.root.innerHTML = `${head}${summaryHtml}${bannerHtml}${controlsHtml}${tableHtml}`;
    this._bind();
  }

  _summaryHtml(summary) {
    const card = (label, value) => `
      <div class="metric-card">
        <span class="metric-card__label">${label}</span>
        <span class="metric-card__value">${value}</span>
      </div>`;
    return `
      <div class="summary">
        ${card('Procesos', summary.total)}
        ${card('Online', summary.online)}
        ${card('Detenidos', summary.stopped)}
        ${card('Memoria total', fmtBytesTotal(summary.memBytes))}
        ${card('CPU total', `${summary.cpuPct.toFixed(1)}%`)}
      </div>`;
  }

  _bannerHtml(counts) {
    if (counts.total === 0) return '';
    const total = counts.total;
    const header = `${total} proceso${total === 1 ? '' : 's'} necesita${
      total === 1 ? '' : 'n'
    } atención`;
    const subtitle = attentionSummary(counts);
    return `
      <div class="attention-banner" role="status">
        <div class="attention-banner__text">
          <strong class="attention-banner__title">${header}</strong>
          <span class="attention-banner__subtitle">${escapeHtml(subtitle)}</span>
        </div>
        <button type="button" class="btn btn--sm" data-only-problems>Ver solo problemas</button>
      </div>`;
  }

  _controlsHtml(procs, threshold) {
    const chips = CHIPS.map((c) => {
      const count = this._countFor(procs, c.key, threshold);
      const active = this.filter === c.key;
      return `<button type="button" class="chip${active ? ' is-active' : ''}"
        data-chip="${c.key}" aria-pressed="${active}">${c.label} <span class="chip__count">${count}</span></button>`;
    }).join('');

    return `
      <div class="proc-controls">
        <input type="search" class="proc-search" data-search placeholder="Buscar proceso…"
          value="${escapeHtml(this.search)}" aria-label="Buscar proceso" />
        <div class="filter-chips" role="group" aria-label="Filtrar procesos">${chips}</div>
        <button type="button" class="btn btn--sm toggle-group${this.grouped ? ' is-active' : ''}"
          data-toggle-group aria-pressed="${this.grouped}">Agrupado por proyecto</button>
      </div>`;
  }

  /** Count of processes matching a chip key over the FULL scoped set. */
  _countFor(procs, key, threshold) {
    if (key === 'all') return procs.length;
    return procs.filter((p) => this._matchesChip(p, key, threshold)).length;
  }

  _matchesChip(p, key, threshold) {
    if (key === 'all') return true;
    if (key === 'online') return p.status === 'online';
    if (key === 'stopped') return p.status !== 'online';
    if (key === 'problems') return needsAttention(p, threshold);
    return true;
  }

  /** Apply search + active chip; returns the visible rows (totals never change). */
  _visibleRows(procs, threshold) {
    const q = this.search.trim().toLowerCase();
    return procs.filter((p) => {
      if (q && !String(p.name).toLowerCase().includes(q)) return false;
      return this._matchesChip(p, this.filter, threshold);
    });
  }

  _tableHtml(procs, threshold) {
    const rows = this._visibleRows(procs, threshold);
    if (rows.length === 0) {
      const msg = procs.length === 0 ? 'No hay procesos para mostrar.' : 'Ningún proceso coincide con el filtro.';
      return `<div class="empty"><p>${msg}</p></div>`;
    }

    const header = `
      <thead>
        <tr>
          <th scope="col">Proceso</th>
          <th scope="col">PID</th>
          <th scope="col">CPU</th>
          <th scope="col">Memoria</th>
          <th scope="col">Uptime</th>
          <th scope="col">Reinicios</th>
          <th scope="col">Acciones</th>
        </tr>
      </thead>`;

    let body;
    if (this.grouped) {
      body = this._groupedBodyHtml(rows, threshold);
    } else {
      body = `<tbody>${rows.map((p) => this._rowHtml(p, threshold)).join('')}</tbody>`;
    }

    return `<table class="proc-table">${header}${body}</table>`;
  }

  _groupedBodyHtml(rows, threshold) {
    // Preserve first-seen order of groups.
    const order = [];
    const groups = new Map();
    for (const p of rows) {
      const g = projectOf(p.name);
      if (!groups.has(g)) {
        groups.set(g, []);
        order.push(g);
      }
      groups.get(g).push(p);
    }

    const sections = order.map((g) => {
      const groupRows = groups.get(g);
      const agg = summaryAggregates(groupRows);
      const memLabel = fmtBytes(agg.memBytes);
      const headCell = `${agg.online}/${agg.total} online · ${memLabel}`;
      const headRow = `
        <tr class="proc-group__head">
          <th scope="colgroup" colspan="7">
            <span class="proc-group__name">${escapeHtml(g)}</span>
            <span class="proc-group__summary">${headCell}</span>
          </th>
        </tr>`;
      const dataRows = groupRows.map((p) => this._rowHtml(p, threshold)).join('');
      return `<tbody>${headRow}${dataRows}</tbody>`;
    });

    return sections.join('');
  }

  _rowHtml(p, threshold) {
    const cls = classifyProcess(p, threshold);
    const label = statusLabel(cls);
    const dotClass = statusDotClass(cls);
    const name = p.name;
    const enc = encodeURIComponent(name);
    const selected = this.selected === name;
    const restarts = p.restarts ?? 0;
    const warn = restarts >= threshold ? ' cell--warn' : '';
    const cpu = p.cpu ?? 0;
    const mem = p.memory ?? 0;
    const ariaLabel = `${name}, ${label}, PID ${p.pid ?? '—'}`;

    const actions = ROW_ACTIONS.map(
      (a) =>
        `<button type="button" class="btn btn--sm btn--icon" data-action="${a.action}" data-name="${enc}"
          aria-label="${escapeHtml(`${a.label} ${name}`)}" title="${escapeHtml(a.label)}">${a.icon}</button>`,
    ).join('');

    return `
      <tr tabindex="0" class="proc-row" data-row="${enc}"
        aria-label="${escapeHtml(ariaLabel)}" aria-selected="${selected}">
        <td class="proc-row__name">
          <span class="status ${dotClass}">${escapeHtml(label)}</span>
          <span class="proc-row__title" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
        </td>
        <td>${p.pid ?? '—'}</td>
        <td>
          <span class="cell-num">${cpu.toFixed(1)}%</span>
          <span class="bar"><span class="bar__fill" style="width:${pct(cpu, 100)}%"></span></span>
        </td>
        <td>
          <span class="cell-num">${fmtBytes(mem)}</span>
          <span class="bar"><span class="bar__fill" style="width:${pct(mem, 1024 * 1024 * 1024)}%"></span></span>
        </td>
        <td>${fmtUptime(p.uptimeMs)}</td>
        <td class="${warn.trim()}">${restarts}</td>
        <td class="proc-row__actions">${actions}</td>
      </tr>`;
  }

  _bind() {
    // Attention banner "Ver solo problemas" -> ?filter=problems.
    const problemsBtn = this.root.querySelector('[data-only-problems]');
    if (problemsBtn) {
      problemsBtn.addEventListener('click', () => this._navigateFilter('problems'));
    }

    // Filter chips.
    for (const chip of this.root.querySelectorAll('[data-chip]')) {
      chip.addEventListener('click', () => {
        const key = chip.dataset.chip;
        if (key === 'problems') {
          this._navigateFilter('problems');
          return;
        }
        this.filter = key;
        // Leaving the problems filter drops the ?filter=problems query.
        this.render();
      });
    }

    // Search box.
    const search = this.root.querySelector('[data-search]');
    if (search) {
      search.addEventListener('input', () => {
        this.search = search.value;
        this.render();
        // Restore focus + caret after the re-render.
        const next = this.root.querySelector('[data-search]');
        if (next) {
          next.focus();
          const len = next.value.length;
          next.setSelectionRange(len, len);
        }
      });
    }

    // Grouping toggle.
    const toggle = this.root.querySelector('[data-toggle-group]');
    if (toggle) {
      toggle.addEventListener('click', () => {
        this.grouped = !this.grouped;
        this.render();
      });
    }

    // Rows: Enter/Space select -> navigate to the row's hash + open detail.
    for (const row of this.root.querySelectorAll('.proc-row')) {
      const name = decodeURIComponent(row.dataset.row);
      row.addEventListener('click', (e) => {
        if (e.target.closest('[data-action]')) return; // action buttons handled below
        this._selectRow(name);
      });
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
          e.preventDefault(); // avoid page scroll on Space
          this._selectRow(name);
        }
      });
    }

    // Per-row action buttons.
    for (const btn of this.root.querySelectorAll('[data-action]')) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._handleAction(btn);
      });
    }
  }

  _navigateFilter(filter) {
    // Compose a hash that keeps the current scope + ?filter=problems.
    const name = this.selected;
    let path = this.agentId
      ? `#/fleet/${encodeURIComponent(this.agentId)}`
      : '#/processes';
    if (name) path += `/${encodeURIComponent(name)}`;
    if (filter === 'problems') path += '?filter=problems';
    this.onNavigate(path);
  }

  _selectRow(name) {
    let path = this.agentId
      ? `#/fleet/${encodeURIComponent(this.agentId)}/${encodeURIComponent(name)}`
      : `#/processes/${encodeURIComponent(name)}`;
    if (this.filter === 'problems') path += '?filter=problems';
    this.onNavigate(path);
  }

  async _handleAction(btn) {
    const name = decodeURIComponent(btn.dataset.name);
    const action = btn.dataset.action;
    const meta = ROW_ACTIONS.find((a) => a.action === action);

    if (meta && meta.destructive) {
      const ok = await this.confirm({
        title: `${meta.label} ${name}?`,
        body: `Se va a ${meta.label.toLowerCase()} "${name}".`,
        confirmLabel: meta.label,
      });
      if (!ok) return;
    }

    btn.disabled = true;
    try {
      await api.control(name, action, this.agentId);
      this.toast(`${meta.label} enviado a ${name}`, 'success');
    } catch (err) {
      this.toast(`${meta.label} falló: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
    }
  }
}
