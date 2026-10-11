// FLEET view (server mode only). Rewrites the old agent-card grid into the rich
// fleet surface: a header with a "+ Conectar agente" button that opens the
// connect-agent modal (placeholders only, NEVER real secrets), four scope-wide
// summary cards computed client-side from GET /api/agents + a per-agent process
// fan-out, and one rich card per agent — alias with inline edit (the real id is
// always visible), an Online badge, a Host/Agent id/Daemon PM2/Último heartbeat
// meta row, a segmented green/amber/red health bar + legend, Memoria/CPU totals,
// a per-agent attention banner with a "Revisar" deep-link, and a dimmed
// last-known card for offline agents.
//
// Navigation is hash-based: the router owns location.hash, so this view calls
// the injected onNavigate(hash) instead of mutating the DOM/history itself.
// "Ver procesos →" -> #/fleet/:agentId ; "Revisar" -> #/fleet/:agentId?filter=problems.
//
// This view is only ever constructed when GET /api/system/health reports
// mode === 'server'; standalone never loads it. It keeps the class name
// AgentsView + the module filename so app.js imports resolve until FEAT-005
// swaps the constructor and router-wires it.

import { api, ApiError } from '../api.js';
import {
  agentHealth,
  attentionCounts,
  attentionSummary,
} from '../util/compute.js';
import { fmtRelativeAge, fmtBytes } from '../format.js';
// Single shared server-tick cadence — defined once in processes.js so the Fleet
// refresh timer and the processes-view agent tick name ONE value (FEAT-002).
import { AGENT_REFRESH_MS } from './processes.js';

/** Trailing-edge debounce window (ms) for opportunistic WS-triggered refreshes. */
const WS_REFRESH_DEBOUNCE_MS = 500;

/** Default agent WebSocket relay path shown in the connect-agent modal. */
const DEFAULT_AGENT_WS_PATH = '/agent';

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Host label from the (unknown-typed) registered meta, null-guarded. */
function hostLabel(meta) {
  if (!meta || typeof meta !== 'object') return '—';
  return meta.hostname || '—';
}

export class AgentsView {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.root
   * @param {(hash:string)=>void} opts.onNavigate  sets location.hash (the router owns navigation)
   * @param {(msg:string, kind?:string)=>void} opts.toast
   * @param {{ on:(type:string, fn:Function)=>Function }} [opts.ws]  WS client; 'state'/'alert' trigger a debounced refresh
   * @param {boolean} [opts.isMaster]  whether this session is master (gates token generation)
   * @param {object|null} [opts.health]  the resolved GET /api/system/health body (carries agentWsPath)
   */
  constructor({ root, onNavigate, toast, ws, isMaster = false, health = null }) {
    this.root = root;
    this.onNavigate = onNavigate;
    this.toast = toast;
    this.ws = ws || null;
    this.isMaster = isMaster === true;
    this.health = health || null;

    /** @type {Array<object>} the GET /api/agents rows. */
    this.agents = [];
    /** agentId -> ProcessSnapshot[] (last successful fan-out per agent). */
    this.agentProcs = new Map();
    /** Set of agentIds whose last fan-out failed (card shows stale/last-known). */
    this.stale = new Set();

    /** Agent id currently being alias-edited; null when idle. */
    this.editing = null;

    this._timer = null;
    this._wsOffs = [];
    this._wsDebounce = null;
  }

  // --- lifecycle -----------------------------------------------------------

  /** Called on route entry: arm the shared-cadence timer + WS triggers, load now. */
  start() {
    this._armTimer();
    this._wireWs();
    this.refresh();
  }

  /** Called on route exit: clear the timer + WS listeners + any pending debounce. */
  destroy() {
    this._clearTimer();
    this._unwireWs();
    if (this._wsDebounce) {
      clearTimeout(this._wsDebounce);
      this._wsDebounce = null;
    }
  }

  _armTimer() {
    if (this._timer) return;
    this._timer = setInterval(() => this.refresh(), AGENT_REFRESH_MS);
  }

  _clearTimer() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  _wireWs() {
    if (!this.ws || this._wsOffs.length) return;
    const trigger = () => this._debouncedRefresh();
    this._wsOffs.push(this.ws.on('state', trigger));
    this._wsOffs.push(this.ws.on('alert', trigger));
  }

  _unwireWs() {
    for (const off of this._wsOffs) {
      if (typeof off === 'function') off();
    }
    this._wsOffs = [];
  }

  /** Trailing-edge debounced refresh; respects the skip-while-editing guard. */
  _debouncedRefresh() {
    if (this._wsDebounce) clearTimeout(this._wsDebounce);
    this._wsDebounce = setTimeout(() => {
      this._wsDebounce = null;
      this.refresh();
    }, WS_REFRESH_DEBOUNCE_MS);
  }

  // --- data ----------------------------------------------------------------

  /**
   * Reload the fleet list + per-agent process fan-out, then re-render. Guarded:
   * while an inline alias edit is in progress (this.editing !== null) it returns
   * early WITHOUT re-fetching/re-rendering so the open edit field is preserved.
   */
  async refresh() {
    if (this.editing !== null) return; // skip-while-editing (protect alias edit)

    let agents;
    try {
      agents = await api.listAgents();
    } catch (err) {
      this.root.innerHTML = `${this._headHtml()}
        <div class="empty"><p>No se pudieron cargar los agentes: ${escapeHtml(err.message)}</p></div>`;
      this._bindHeader();
      return;
    }
    this.agents = Array.isArray(agents) ? agents : [];

    // Fan out per-agent process reads; a rejected fetch degrades THAT card to
    // stale/last-known (keep the previous snapshot if we have one) and raises at
    // most one summary toast for the whole batch.
    this.stale = new Set();
    let anyFailed = false;
    const results = await Promise.allSettled(
      this.agents.map((a) => api.agentProcesses(a.id)),
    );
    results.forEach((res, i) => {
      const id = this.agents[i].id;
      if (res.status === 'fulfilled') {
        this.agentProcs.set(id, Array.isArray(res.value) ? res.value : []);
      } else {
        this.stale.add(id);
        anyFailed = true;
        if (!this.agentProcs.has(id)) this.agentProcs.set(id, []);
      }
    });

    // Drop snapshots for agents that are no longer listed.
    const live = new Set(this.agents.map((a) => a.id));
    for (const id of [...this.agentProcs.keys()]) {
      if (!live.has(id)) this.agentProcs.delete(id);
    }

    if (anyFailed) {
      this.toast('No se pudieron actualizar algunos agentes; mostrando datos previos.', 'error');
    }

    // A late response could land after an edit started; re-check the guard.
    if (this.editing !== null) return;
    this.render();
  }

  /** Procs for an agent (empty array when none / never fetched). */
  _procsFor(id) {
    return this.agentProcs.get(id) || [];
  }

  // --- render --------------------------------------------------------------

  render() {
    const head = this._headHtml();

    if (this.agents.length === 0) {
      this.root.innerHTML = `${head}
        <div class="empty">
          <p>Todavía no hay agentes conectados.</p>
          <p>Inicia un agente con <code>MODE=agent</code> apuntando a este servidor.</p>
        </div>`;
      this._bindHeader();
      return;
    }

    const summaryHtml = this._summaryHtml();
    const cards = this.agents.map((a) => this._cardHtml(a)).join('');
    this.root.innerHTML = `${head}${summaryHtml}<div class="agent-grid">${cards}</div>`;
    this._bind();
  }

  _headHtml() {
    return `
      <div class="section-head">
        <div class="section-head__titles">
          <h1>Fleet</h1>
          <span class="section-head__subtitle">Servidores con el agente de PM2 conectado</span>
        </div>
        <button type="button" class="btn btn--primary" data-connect-agent>+ Conectar agente</button>
      </div>`;
  }

  _summaryHtml() {
    const agentCount = this.agents.length;
    const onlineCount = this.agents.filter((a) => a.online === true).length;
    const totalProcs = this.agents.reduce((s, a) => s + (a.processCount ?? 0), 0);
    const problemProcs = this.agents.reduce(
      (s, a) => s + attentionCounts(this._procsFor(a.id)).total,
      0,
    );

    const card = (label, value, mod = '') => `
      <div class="metric-card${mod}">
        <span class="metric-card__label">${label}</span>
        <span class="metric-card__value">${value}</span>
      </div>`;

    return `
      <div class="summary summary--fleet">
        ${card('Agentes', agentCount)}
        ${card('Online', onlineCount, ' metric-card--ok')}
        ${card('Procesos en total', totalProcs)}
        ${card('Procesos con problemas', problemProcs, problemProcs > 0 ? ' metric-card--danger' : '')}
      </div>`;
  }

  _cardHtml(a) {
    const id = a.id;
    const offline = a.online === false;
    const display = a.alias && a.alias.length > 0 ? a.alias : id;

    // Name block: either the inline edit field or the alias + pencil button.
    const nameBlock =
      this.editing === id
        ? `<input type="text" class="agent-alias-input" data-alias-input="${escapeHtml(id)}"
             value="${escapeHtml(a.alias ?? '')}" placeholder="${escapeHtml(id)}" maxlength="60"
             aria-label="Alias del agente" />
           <button type="button" class="btn btn--sm btn--primary" data-alias-save="${escapeHtml(id)}">Guardar</button>
           <button type="button" class="btn btn--sm btn--ghost" data-alias-cancel="${escapeHtml(id)}">Cancelar</button>`
        : `<span class="status ${offline ? 'status--stopped' : 'status--online'}" aria-hidden="true"></span>
           <span class="agent-card__name" title="${escapeHtml(id)}">${escapeHtml(display)}</span>
           <button type="button" class="btn btn--sm btn--ghost btn--icon" data-alias-edit="${escapeHtml(id)}"
             title="Editar alias" aria-label="Editar alias de ${escapeHtml(display)}">✎</button>`;

    const onlineBadge = offline
      ? '<span class="agent-card__badge agent-card__badge--offline">Offline</span>'
      : '<span class="agent-card__badge agent-card__badge--online">Online</span>';

    const metaRow = `
      <dl class="agent-meta">
        <div class="agent-meta__row"><dt>Host</dt><dd>${escapeHtml(hostLabel(a.meta))}</dd></div>
        <div class="agent-meta__row"><dt>Agent id</dt><dd title="${escapeHtml(id)}">${escapeHtml(id)}</dd></div>
        <div class="agent-meta__row"><dt>Daemon PM2</dt><dd>${a.pm2Connected ? 'Corriendo' : 'Detenido'}</dd></div>
        <div class="agent-meta__row"><dt>Último heartbeat</dt><dd>${escapeHtml(fmtRelativeAge(a.lastSeen))}</dd></div>
      </dl>`;

    // Offline cards render dimmed with last-known meta and NO live metrics.
    if (offline) {
      return `
        <article class="agent-card is-offline" data-agent-card="${escapeHtml(id)}">
          <div class="agent-card__head">
            <div class="agent-card__title">${nameBlock}</div>
            ${onlineBadge}
          </div>
          ${metaRow}
          <p class="agent-card__offline-note">Sin métricas en vivo (último dato conocido).</p>
          <div class="agent-card__footer">
            <button type="button" class="btn btn--sm" data-open-agent="${escapeHtml(id)}">Ver procesos →</button>
          </div>
        </article>`;
    }

    const procs = this._procsFor(id);
    const health = agentHealth(procs);
    const counts = attentionCounts(procs);
    const procCount = a.processCount ?? procs.length;
    const staleNote = this.stale.has(id)
      ? '<span class="agent-card__stale" title="No se pudieron leer los procesos en el último intento">· datos previos</span>'
      : '';

    return `
      <article class="agent-card" data-agent-card="${escapeHtml(id)}">
        <div class="agent-card__head">
          <div class="agent-card__title">${nameBlock}</div>
          ${onlineBadge}
        </div>
        ${metaRow}
        ${this._healthHtml(health, procCount, staleNote)}
        <div class="agent-card__totals">
          <div class="agent-card__total">
            <span class="agent-card__total-label">Memoria (procesos)</span>
            <span class="agent-card__total-value">${fmtBytes(health.memBytes)}</span>
          </div>
          <div class="agent-card__total">
            <span class="agent-card__total-label">CPU (procesos)</span>
            <span class="agent-card__total-value">${health.cpuPct.toFixed(1)}%</span>
          </div>
        </div>
        ${this._attentionHtml(id, counts)}
        <div class="agent-card__footer">
          <button type="button" class="btn btn--sm" data-open-agent="${escapeHtml(id)}">Ver procesos →</button>
        </div>
      </article>`;
  }

  /** Segmented green/amber/red health bar + legend labeled "Procesos N". */
  _healthHtml(health, procCount, staleNote) {
    const total = health.sano + health.inestable + health.detenido;
    const segPct = (n) => (total > 0 ? (n / total) * 100 : 0);
    return `
      <div class="agent-health">
        <div class="agent-health__label">Procesos ${procCount} ${staleNote}</div>
        <div class="health-bar" role="img"
          aria-label="${health.sano} sanos, ${health.inestable} inestables, ${health.detenido} detenidos">
          <span class="health-bar__seg health-bar__seg--ok" style="width:${segPct(health.sano)}%"></span>
          <span class="health-bar__seg health-bar__seg--warn" style="width:${segPct(health.inestable)}%"></span>
          <span class="health-bar__seg health-bar__seg--danger" style="width:${segPct(health.detenido)}%"></span>
        </div>
        <div class="health-legend">
          <span class="health-legend__item"><span class="health-legend__dot health-legend__dot--ok"></span>${health.sano} sanos</span>
          <span class="health-legend__item"><span class="health-legend__dot health-legend__dot--warn"></span>${health.inestable} inestable</span>
          <span class="health-legend__item"><span class="health-legend__dot health-legend__dot--danger"></span>${health.detenido} detenidos</span>
        </div>
      </div>`;
  }

  /** Per-agent attention banner shown only when there is at least one problem. */
  _attentionHtml(id, counts) {
    if (counts.total === 0) return '';
    return `
      <div class="agent-card__attention attention-banner" role="status">
        <span class="attention-banner__subtitle">${escapeHtml(attentionSummary(counts))}</span>
        <button type="button" class="btn btn--sm" data-review-agent="${escapeHtml(id)}">Revisar</button>
      </div>`;
  }

  // --- bind ----------------------------------------------------------------

  _bind() {
    this._bindHeader();

    for (const el of this.root.querySelectorAll('[data-open-agent]')) {
      el.addEventListener('click', () =>
        this.onNavigate(`#/fleet/${encodeURIComponent(el.dataset.openAgent)}`),
      );
    }

    for (const el of this.root.querySelectorAll('[data-review-agent]')) {
      el.addEventListener('click', () =>
        this.onNavigate(`#/fleet/${encodeURIComponent(el.dataset.reviewAgent)}?filter=problems`),
      );
    }

    for (const el of this.root.querySelectorAll('[data-alias-edit]')) {
      el.addEventListener('click', () => {
        this.editing = el.dataset.aliasEdit;
        this.render();
        const input = this.root.querySelector('[data-alias-input]');
        if (input) input.focus();
      });
    }

    for (const el of this.root.querySelectorAll('[data-alias-cancel]')) {
      el.addEventListener('click', () => this._cancelEdit());
    }

    for (const el of this.root.querySelectorAll('[data-alias-save]')) {
      el.addEventListener('click', () => this._saveAlias(el.dataset.aliasSave));
    }

    const input = this.root.querySelector('[data-alias-input]');
    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this._saveAlias(input.dataset.aliasInput);
        if (e.key === 'Escape') this._cancelEdit();
      });
    }
  }

  /** Bind only the header's "+ Conectar agente" button (used by empty/error states too). */
  _bindHeader() {
    const connect = this.root.querySelector('[data-connect-agent]');
    if (connect) connect.addEventListener('click', () => this.openConnectModal());
  }

  /** Cancel an inline alias edit: clear the guard then refresh so fresh data loads. */
  _cancelEdit() {
    this.editing = null;
    this.refresh();
  }

  async _saveAlias(id) {
    const input = this.root.querySelector(`[data-alias-input="${CSS.escape(id)}"]`);
    const alias = input ? input.value.trim() : '';
    try {
      await api.setAlias(id, alias);
      this.toast(`Alias actualizado para ${id}`, 'success');
      // Clear the guard BEFORE refresh so the reload is not skipped.
      this.editing = null;
      await this.refresh();
    } catch (err) {
      // Keep the field open with the prior alias so the operator can retry.
      this.toast(`No se pudo cambiar el alias: ${err.message}`, 'error');
    }
  }

  // --- connect-agent modal -------------------------------------------------

  /**
   * Open and populate #connect-modal. The modal MARKUP is added by FEAT-005's
   * index.html rewrite; this handler is built so it is ready to drive it. The
   * body shows SERVER_URL, AGENT_WS_PATH (default '/agent') and a token-required
   * note using PLACEHOLDERS ONLY — never a real key/token — plus a link to the
   * agent docs.
   */
  openConnectModal() {
    const modal = document.getElementById('connect-modal');
    if (!modal) {
      // The markup is added in FEAT-005; nothing to open yet.
      this.toast('El diálogo de conexión aún no está disponible.', 'info');
      return;
    }

    const body = modal.querySelector('[data-connect-body]') || modal.querySelector('.modal__body');
    // A master session gets the live generate flow; everyone else sees the
    // placeholder-only body (never a real token).
    if (body) body.innerHTML = this.isMaster ? this._connectBodyMasterHtml() : this._connectBodyHtml();

    modal.hidden = false;

    // Close on the backdrop, any [data-connect-close] control, and Escape. These
    // live OUTSIDE [data-connect-body], so re-rendering the body (on generate)
    // never detaches them.
    const close = () => this.closeConnectModal();
    for (const el of modal.querySelectorAll('[data-connect-close], .modal__backdrop')) {
      el.addEventListener('click', close, { once: true });
    }
    this._connectKeydown = (e) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', this._connectKeydown);

    // Master-only: wire the "Generar token" button inside the body.
    if (this.isMaster) {
      const genBtn = modal.querySelector('[data-generate-token]');
      if (genBtn) genBtn.addEventListener('click', () => this._generateToken());
    }
  }

  /**
   * Master-only: generate an agent token, then render the one-time reveal + the
   * ready-to-paste command into [data-generate-result]. On failure keep the
   * result area empty and toast.
   */
  async _generateToken() {
    const modal = document.getElementById('connect-modal');
    if (!modal) return;
    const labelInput = modal.querySelector('[data-token-label]');
    const label = (labelInput ? labelInput.value : '').trim();
    if (!label) {
      this.toast('Ingresá una etiqueta para el token.', 'error');
      return;
    }
    try {
      const result = await api.generateAgentToken(label);
      this._renderGeneratedToken(result);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err?.message ?? err);
      this.toast(`No se pudo generar el token: ${msg}`, 'error');
      // Leave [data-generate-result] empty on failure.
    }
  }

  closeConnectModal() {
    const modal = document.getElementById('connect-modal');
    if (modal) modal.hidden = true;
    if (this._connectKeydown) {
      document.removeEventListener('keydown', this._connectKeydown);
      this._connectKeydown = null;
    }
  }

  /** Populate the connect-modal body with PLACEHOLDERS ONLY (no real secrets). */
  _connectBodyHtml() {
    // Infer a sensible SERVER_URL placeholder from the current origin (ws/wss)
    // WITHOUT exposing any stored credential — this is a display hint only.
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const serverUrlPlaceholder = `${scheme}://${location.host}`;
    return `
      <div class="connect-modal">
        <p class="connect-modal__intro">
          Inicia un agente en tu servidor con <code>MODE=agent</code> y la siguiente configuración:
        </p>
        <dl class="connect-modal__fields">
          <div class="connect-modal__field">
            <dt>SERVER_URL</dt>
            <dd><code>${escapeHtml(serverUrlPlaceholder)}</code></dd>
          </div>
          <div class="connect-modal__field">
            <dt>AGENT_WS_PATH</dt>
            <dd><code>${escapeHtml(DEFAULT_AGENT_WS_PATH)}</code></dd>
          </div>
          <div class="connect-modal__field">
            <dt>AGENT_TOKEN</dt>
            <dd><code>&lt;tu-token-de-agente&gt;</code></dd>
          </div>
        </dl>
        <p class="connect-modal__note">
          Se requiere un token de agente válido. Genera y gestiona tokens en Ajustes;
          nunca se muestran aquí.
        </p>
        <p class="connect-modal__docs">
          Guía completa: <a href="docs/AGENT_PM2.md" target="_blank" rel="noopener">docs/AGENT_PM2.md</a>
        </p>
      </div>`;
  }

  /** The agent ws path to advertise: health.agentWsPath, falling back to the default. */
  _agentWsPath() {
    return (this.health && this.health.agentWsPath) || DEFAULT_AGENT_WS_PATH;
  }

  /** The SERVER_URL hint derived from the current origin (ws/wss), never a stored secret. */
  _serverUrl() {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${scheme}://${location.host}`;
  }

  /**
   * Master-only connect body: read-only SERVER_URL/AGENT_WS_PATH hints, a label
   * input, a "Generar token" button, and an (initially empty) result area that
   * _renderGeneratedToken fills with the raw-once reveal + the paste command.
   */
  _connectBodyMasterHtml() {
    return `
      <div class="connect-modal">
        <p class="connect-modal__intro">
          Generá un token de agente y copiá el comando para conectar el servidor
          (<code>MODE=agent</code>). El token se muestra una sola vez.
        </p>
        <dl class="connect-modal__fields">
          <div class="connect-modal__field">
            <dt>SERVER_URL</dt>
            <dd><code>${escapeHtml(this._serverUrl())}</code></dd>
          </div>
          <div class="connect-modal__field">
            <dt>AGENT_WS_PATH</dt>
            <dd><code>${escapeHtml(this._agentWsPath())}</code></dd>
          </div>
        </dl>
        <div class="connect-modal__generate">
          <input type="text" data-token-label maxlength="100"
            placeholder="Etiqueta (p. ej. web-01)" aria-label="Etiqueta del token" />
          <button type="button" class="btn btn--primary" data-generate-token>Generar token</button>
        </div>
        <div data-generate-result></div>
      </div>`;
  }

  /**
   * Fill ONLY [data-generate-result] (so the backdrop/Escape/close controls that
   * live outside the body survive): the raw token once + a "no se vuelve a
   * mostrar" warning, and a ready-to-paste command carrying SERVER_URL,
   * AGENT_WS_PATH, the embedded AGENT_TOKEN, the agent .env lines and the pm2
   * start step. Re-binds both Copy buttons after each render.
   */
  _renderGeneratedToken(result) {
    const modal = document.getElementById('connect-modal');
    if (!modal) return;
    const target = modal.querySelector('[data-generate-result]');
    if (!target) return;

    const serverUrl = this._serverUrl();
    const wsPath = this._agentWsPath();
    const rawToken = result.rawToken;

    // The ready-to-paste agent config: an .env block (placeholder API_KEY, since
    // the agent needs its own human-auth key) plus the pm2 start command.
    const command = [
      '# .env del agente',
      'MODE=agent',
      `SERVER_URL=${serverUrl}`,
      `AGENT_WS_PATH=${wsPath}`,
      `AGENT_TOKEN=${rawToken}`,
      'API_KEY=<cualquier-clave>',
      '',
      'pm2 start dist/index.js --name pm2-agent --cwd $(pwd)',
    ].join('\n');

    target.innerHTML = `
      <div class="secret-reveal">
        <p class="connect-modal__label">Token del agente (AGENT_TOKEN)</p>
        <div class="secret-reveal__row">
          <code data-token-raw>${escapeHtml(rawToken)}</code>
          <button type="button" class="btn btn--sm" data-copy-token>Copiar</button>
        </div>
        <p class="secret-reveal__warning" role="status">
          Guardalo ahora: no se vuelve a mostrar.
        </p>
      </div>
      <div class="connect-modal__command-wrap">
        <p class="connect-modal__label">Comando para configurar el agente</p>
        <div class="connect-modal__command-row">
          <code class="connect-modal__command" data-command>${escapeHtml(command)}</code>
          <button type="button" class="btn btn--sm" data-copy-command>Copiar</button>
        </div>
      </div>`;

    // Re-bind both Copy buttons after each render.
    this._bindCopy(target.querySelector('[data-copy-token]'), rawToken, 'Token copiado');
    this._bindCopy(target.querySelector('[data-copy-command]'), command, 'Comando copiado');
  }

  /** Wire a Copy button to write `value` to the clipboard (with a fallback). */
  _bindCopy(btn, value, okMsg) {
    if (!btn) return;
    btn.addEventListener('click', async () => {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(value);
        } else {
          const ta = document.createElement('textarea');
          ta.value = value;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        }
        this.toast(okMsg, 'success');
      } catch {
        this.toast('No se pudo copiar — seleccioná y copiá manualmente.', 'error');
      }
    });
  }
}
