// Fleet overview (server mode only). Renders a grid of agent cards — each shows
// the alias (or the id when no alias is set), an online badge, host/platform
// from the registered meta, the process count, and a pm2-connected badge. The
// alias is editable inline (PUT /api/agents/:id/alias); the real id is always
// shown on hover and in the edit field so an operator can tell agents apart
// regardless of the cosmetic alias (AC-37). Selecting an agent drills into the
// existing overview/detail views parameterized by that agentId.
//
// This view is only ever constructed when GET /api/system/health reports
// mode === 'server'; standalone never loads it.

import { api } from '../api.js';

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function hostLabel(meta) {
  if (!meta || typeof meta !== 'object') return '—';
  const host = meta.hostname || '—';
  const platform = meta.platform ? ` · ${meta.platform}` : '';
  return `${host}${platform}`;
}

export class AgentsView {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.root
   * @param {(agentId:string)=>void} opts.onOpenAgent  drill into the agent's overview
   * @param {(msg:string, kind?:string)=>void} opts.toast
   */
  constructor({ root, onOpenAgent, toast }) {
    this.root = root;
    this.onOpenAgent = onOpenAgent;
    this.toast = toast;
    this.agents = [];
    this.editing = null; // agent id currently being alias-edited
  }

  async refresh() {
    try {
      this.agents = await api.listAgents();
    } catch (err) {
      this.root.innerHTML = `<div class="section-head"><h1>Fleet</h1></div>
        <div class="empty"><p>Could not load agents: ${escapeHtml(err.message)}</p></div>`;
      return;
    }
    this.render();
  }

  render() {
    const head = `
      <div class="section-head">
        <h1>Fleet</h1>
        <span class="metric__label">${this.agents.length} agent${this.agents.length === 1 ? '' : 's'}</span>
      </div>`;

    if (this.agents.length === 0) {
      this.root.innerHTML = `${head}
        <div class="empty">
          <p>No agents connected yet.</p>
          <p>Start an agent with <code>MODE=agent</code> pointed at this server.</p>
        </div>`;
      return;
    }

    const cards = this.agents.map((a) => this.cardHtml(a)).join('');
    this.root.innerHTML = `${head}<div class="cards">${cards}</div>`;
    this.bind();
  }

  cardHtml(a) {
    const id = a.id;
    const display = a.alias && a.alias.length > 0 ? a.alias : id;
    const online = a.online
      ? '<span class="status status--online">online</span>'
      : '<span class="status status--stopped">offline</span>';
    const pm2 = a.pm2Connected
      ? '<span class="status status--online">pm2</span>'
      : '<span class="status status--errored">pm2 down</span>';

    const nameBlock =
      this.editing === id
        ? `<input type="text" class="agent-alias-input" data-alias-input="${escapeHtml(id)}"
             value="${escapeHtml(a.alias ?? '')}" placeholder="${escapeHtml(id)}" maxlength="60" />
           <button type="button" class="btn btn--sm" data-alias-save="${escapeHtml(id)}">Save</button>
           <button type="button" class="btn btn--sm btn--ghost" data-alias-cancel="${escapeHtml(id)}">Cancel</button>`
        : `<a class="card__name" data-open-agent="${escapeHtml(id)}" title="${escapeHtml(id)}">${escapeHtml(display)}</a>
           <button type="button" class="btn btn--sm btn--ghost" data-alias-edit="${escapeHtml(id)}" title="Edit alias (visual only)">✎</button>`;

    return `
      <article class="card" data-agent-card="${escapeHtml(id)}">
        <div class="card__head">
          ${nameBlock}
          ${online}
        </div>
        <div class="card__metrics">
          <span class="metric__label">Agent id</span>
          <span class="metric__value" title="${escapeHtml(id)}">${escapeHtml(id)}</span>
          <span class="metric__label">Host</span>
          <span class="metric__value">${escapeHtml(hostLabel(a.meta))}</span>
          <span class="metric__label">Processes</span>
          <span class="metric__value">${a.processCount ?? 0}</span>
          <span class="metric__label">PM2</span>
          <span class="metric__value">${pm2}</span>
        </div>
      </article>`;
  }

  bind() {
    for (const el of this.root.querySelectorAll('[data-open-agent]')) {
      el.addEventListener('click', () => this.onOpenAgent(el.dataset.openAgent));
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
      el.addEventListener('click', () => {
        this.editing = null;
        this.render();
      });
    }
    for (const el of this.root.querySelectorAll('[data-alias-save]')) {
      el.addEventListener('click', () => this.saveAlias(el.dataset.aliasSave));
    }
    const input = this.root.querySelector('[data-alias-input]');
    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this.saveAlias(input.dataset.aliasInput);
        if (e.key === 'Escape') {
          this.editing = null;
          this.render();
        }
      });
    }
  }

  async saveAlias(id) {
    const input = this.root.querySelector(`[data-alias-input="${CSS.escape(id)}"]`);
    const alias = input ? input.value.trim() : '';
    try {
      await api.setAlias(id, alias);
      this.toast(`Alias updated for ${id}`, 'success');
      this.editing = null;
      await this.refresh();
    } catch (err) {
      this.toast(`Alias change failed: ${err.message}`, 'error');
    }
  }
}
