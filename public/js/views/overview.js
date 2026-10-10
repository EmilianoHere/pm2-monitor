// Overview view: a responsive grid of process cards. Each card shows name,
// color-coded status, pid, CPU%, memory, uptime, restarts, and mode×instances,
// plus start/stop/restart/reload/delete buttons. Destructive actions
// (stop/restart/delete) go through a confirm dialog before issuing the call
// (AC9/AC14).

import { api } from '../api.js';

const CONTROL_BUTTONS = [
  { action: 'start', label: 'Start', destructive: false },
  { action: 'stop', label: 'Stop', destructive: true },
  { action: 'restart', label: 'Restart', destructive: true },
  { action: 'reload', label: 'Reload', destructive: false },
  { action: 'delete', label: 'Delete', destructive: true },
];

function statusClass(status) {
  return `status status--${status}`;
}

function fmtBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtUptime(ms) {
  if (ms === null || ms === undefined || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export class OverviewView {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.root
   * @param {(name:string)=>void} opts.onOpenDetail
   * @param {(opts:object)=>Promise<boolean>} opts.confirm  resolves true on confirm
   * @param {(msg:string, kind?:string)=>void} opts.toast
   */
  constructor({ root, onOpenDetail, confirm, toast, agentId }) {
    this.root = root;
    this.onOpenDetail = onOpenDetail;
    this.confirm = confirm;
    this.toast = toast;
    // Optional agent scope (server mode). Undefined in standalone, so control
    // and detail calls use the existing /api/processes paths unchanged.
    this.agentId = agentId;
    this.processes = [];
  }

  setProcesses(processes) {
    this.processes = Array.isArray(processes) ? processes : [];
    this.render();
  }

  render() {
    const head = `
      <div class="section-head">
        <h1>Processes</h1>
        <span class="metric__label">${this.processes.length} tracked</span>
      </div>`;

    if (this.processes.length === 0) {
      this.root.innerHTML = `${head}
        <div class="empty">
          <p>No processes to show.</p>
          <p>If PM2 is reachable but empty, start one with <code>pm2 start …</code>.</p>
        </div>`;
      return;
    }

    const cards = this.processes
      .map((p) => this.cardHtml(p))
      .join('');
    this.root.innerHTML = `${head}<div class="cards">${cards}</div>`;
    this.bind();
  }

  cardHtml(p) {
    const buttons = CONTROL_BUTTONS.map(
      (b) =>
        `<button type="button" class="btn btn--sm" data-action="${b.action}" data-name="${encodeURIComponent(
          p.name,
        )}">${b.label}</button>`,
    ).join('');

    return `
      <article class="card" data-card="${encodeURIComponent(p.name)}">
        <div class="card__head">
          <a class="card__name" data-open="${encodeURIComponent(p.name)}" title="${p.name}">${p.name}</a>
          <span class="${statusClass(p.status)}">${p.status}</span>
        </div>
        <div class="card__metrics">
          <span class="metric__label">PID</span>
          <span class="metric__value">${p.pid ?? '—'}</span>
          <span class="metric__label">CPU</span>
          <span class="metric__value">${(p.cpu ?? 0).toFixed(1)}%</span>
          <span class="metric__label">Memory</span>
          <span class="metric__value">${fmtBytes(p.memory)}</span>
          <span class="metric__label">Uptime</span>
          <span class="metric__value">${fmtUptime(p.uptimeMs)}</span>
          <span class="metric__label">Restarts</span>
          <span class="metric__value">${p.restarts ?? 0}</span>
          <span class="metric__label">Mode</span>
          <span class="metric__value">${p.mode} × ${p.instances}</span>
        </div>
        <div class="card__actions">${buttons}</div>
      </article>`;
  }

  bind() {
    for (const el of this.root.querySelectorAll('[data-open]')) {
      el.addEventListener('click', () => this.onOpenDetail(decodeURIComponent(el.dataset.open)));
    }
    for (const btn of this.root.querySelectorAll('[data-action]')) {
      btn.addEventListener('click', () => this.handleAction(btn));
    }
  }

  async handleAction(btn) {
    const name = decodeURIComponent(btn.dataset.name);
    const action = btn.dataset.action;
    const meta = CONTROL_BUTTONS.find((b) => b.action === action);

    if (meta && meta.destructive) {
      const ok = await this.confirm({
        title: `${meta.label} ${name}?`,
        body:
          action === 'delete'
            ? `This removes "${name}" from PM2. This cannot be undone.`
            : `This will ${action} "${name}".`,
        confirmLabel: meta.label,
      });
      if (!ok) return;
    }

    btn.disabled = true;
    try {
      if (action === 'delete') {
        await api.deleteProcess(name, this.agentId);
      } else {
        await api.control(name, action, this.agentId);
      }
      this.toast(`${action} issued for ${name}`, 'success');
    } catch (err) {
      this.toast(`${action} failed: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
    }
  }
}

export { fmtBytes, fmtUptime };
