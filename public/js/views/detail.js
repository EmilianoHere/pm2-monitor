// Detail view: per-process metadata, a CPU/memory history chart (Chart.js via
// CDN, reading GET /api/processes/:name/metrics) that degrades to a numeric
// table if the CDN is blocked, the per-process error list from GET /api/errors,
// and the live log viewer.

import { api } from '../api.js';
import { fmtBytes, fmtUptime } from './overview.js';
import { LogsView } from './logs.js';

const ONE_HOUR_MS = 60 * 60 * 1000;

function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString();
}

export class DetailView {
  constructor({ root, ws, toast, onBack, agentId }) {
    this.root = root;
    this.ws = ws;
    this.toast = toast;
    this.onBack = onBack;
    // Optional agent scope (server mode). Undefined in standalone, so every API
    // call below hits the existing /api/processes paths unchanged.
    this.agentId = agentId;
    this.name = null;
    this.chart = null;
    this.logs = null;
  }

  async mount(name) {
    this.name = name;
    this.renderShell();
    this.logs = new LogsView({
      root: this.root.querySelector('#detail-logs'),
      ws: this.ws,
      toast: this.toast,
      agentId: this.agentId,
    });
    await Promise.all([this.loadMeta(), this.loadMetrics(), this.loadErrors()]);
    await this.logs.mount(name);
  }

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
  }

  renderShell() {
    this.root.innerHTML = `
      <button type="button" class="btn btn--ghost detail__back" id="detail-back">← Back to overview</button>
      <div class="section-head"><h2 id="detail-title">${this.name}</h2></div>
      <div class="detail__grid">
        <div class="panel" id="detail-meta"><h3>Metadata</h3><p class="metric__label">Loading…</p></div>
        <div class="panel">
          <h3>CPU / Memory history</h3>
          <div class="chart-wrap"><canvas id="metrics-chart"></canvas><div id="metrics-fallback"></div></div>
        </div>
      </div>
      <div class="panel" style="margin-top:16px;">
        <h3>Recent errors</h3>
        <div id="detail-errors"><p class="metric__label">Loading…</p></div>
      </div>
      <div style="margin-top:16px;" id="detail-logs"></div>`;

    this.root.querySelector('#detail-back').addEventListener('click', () => this.onBack());
  }

  /**
   * Loads the single-process snapshot. Standalone uses GET /api/processes/:name.
   * The agent-scoped surface has no single-process read, so in server mode we
   * pull the agent's process list and pick the one by name (the server returns
   * the SAME ProcessSnapshot shape).
   */
  async fetchProcess() {
    if (!this.agentId) return api.getProcess(this.name);
    const procs = await api.agentProcesses(this.agentId);
    const match = (procs || []).find((p) => p.name === this.name);
    if (!match) throw new Error(`process "${this.name}" not found on agent`);
    return match;
  }

  async loadMeta() {
    const el = this.root.querySelector('#detail-meta');
    try {
      const p = await this.fetchProcess();
      el.innerHTML = `<h3>Metadata</h3>
        <table class="meta-table">
          <tr><td>Status</td><td><span class="status status--${p.status}">${p.status}</span></td></tr>
          <tr><td>PID</td><td>${p.pid ?? '—'}</td></tr>
          <tr><td>pm_id</td><td>${p.pmId}</td></tr>
          <tr><td>CPU</td><td>${(p.cpu ?? 0).toFixed(1)}%</td></tr>
          <tr><td>Memory</td><td>${fmtBytes(p.memory)}</td></tr>
          <tr><td>Uptime</td><td>${fmtUptime(p.uptimeMs)}</td></tr>
          <tr><td>Restarts</td><td>${p.restarts ?? 0}</td></tr>
          <tr><td>Unstable restarts</td><td>${p.unstableRestarts ?? 0}</td></tr>
          <tr><td>Mode</td><td>${p.mode} × ${p.instances}</td></tr>
          <tr><td>Exec path</td><td>${p.execPath ?? '—'}</td></tr>
        </table>`;
    } catch (err) {
      el.innerHTML = `<h3>Metadata</h3><p class="metric__label">Error: ${err.message}</p>`;
    }
  }

  async loadMetrics() {
    const canvas = this.root.querySelector('#metrics-chart');
    const fallback = this.root.querySelector('#metrics-fallback');
    let samples = [];
    try {
      const res = this.agentId
        ? await api.agentMetrics(this.agentId, this.name, ONE_HOUR_MS)
        : await api.metrics(this.name, ONE_HOUR_MS);
      samples = res.samples || [];
    } catch (err) {
      fallback.innerHTML = `<p class="metric__label">Could not load metrics: ${err.message}</p>`;
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
    if (samples.length === 0) return '<p class="metric__label">No samples yet.</p>';
    const recent = samples.slice(-30).reverse();
    const rows = recent
      .map(
        (s) =>
          `<tr><td>${fmtTime(s.ts)}</td><td>${s.cpu.toFixed(1)}%</td><td>${fmtBytes(s.mem)}</td></tr>`,
      )
      .join('');
    return `<table class="data-table">
      <thead><tr><th>Time</th><th>CPU</th><th>Memory</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
  }

  async loadErrors() {
    const el = this.root.querySelector('#detail-errors');
    try {
      const errors = await api.errors({ name: this.name, limit: 50 }, this.agentId);
      if (!errors.length) {
        el.innerHTML = '<p class="metric__label">No errors tracked.</p>';
        return;
      }
      const rows = errors
        .map(
          (e) =>
            `<tr><td>${e.level}</td><td>${e.count}</td><td>${fmtTime(e.lastSeen)}</td><td>${escapeHtml(
              e.message,
            )}</td></tr>`,
        )
        .join('');
      el.innerHTML = `<table class="data-table">
        <thead><tr><th>Level</th><th>Count</th><th>Last seen</th><th>Message</th></tr></thead>
        <tbody>${rows}</tbody></table>`;
    } catch (err) {
      el.innerHTML = `<p class="metric__label">Error: ${err.message}</p>`;
    }
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
