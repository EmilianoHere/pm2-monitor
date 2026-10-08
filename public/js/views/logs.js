// Live log viewer. Subscribes to a process's logs over the WS (log:subscribe),
// renders a bounded scrolling buffer, and offers client-side text search plus a
// level toggle between the two real levels (info/error). An initial backfill is
// loaded from GET /api/processes/:name/logs.
//
// Per the design, WS live tail is server-filtered only by stream selection; the
// q search and level filter here are best-effort client-side matching.

import { api } from '../api.js';

const MAX_BUFFER = 1000;

export class LogsView {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.root        container to render into
   * @param {import('../ws.js').WsClient} opts.ws
   * @param {(msg:string, kind?:string)=>void} opts.toast
   */
  constructor({ root, ws, toast }) {
    this.root = root;
    this.ws = ws;
    this.toast = toast;
    this.process = null;
    this.buffer = []; // { stream, level, line, ts }
    this.q = '';
    this.levelFilter = 'all'; // 'all' | 'info' | 'error'
    this.offLog = null;
  }

  async mount(name) {
    this.process = name;
    this.buffer = [];
    this.renderShell();

    // Live subscription.
    this.offLog = this.ws.on('log', (msg) => {
      if (msg.process !== this.process) return;
      this.append({ stream: msg.stream, level: msg.level, line: msg.line, ts: msg.ts });
    });
    this.ws.logSubscribe(name, ['out', 'err']);

    // Initial backfill.
    try {
      const res = await api.logs(name, { lines: 200, stream: 'all' });
      for (const l of res.lines) this.buffer.push(l);
      this.trim();
      this.renderLines();
    } catch (err) {
      this.toast(`log backfill failed: ${err.message}`, 'error');
    }
  }

  unmount() {
    if (this.offLog) {
      this.offLog();
      this.offLog = null;
    }
    if (this.process) this.ws.logUnsubscribe(this.process);
    this.process = null;
  }

  append(entry) {
    this.buffer.push(entry);
    this.trim();
    if (this.matches(entry)) this.appendLineEl(entry);
  }

  trim() {
    if (this.buffer.length > MAX_BUFFER) {
      this.buffer.splice(0, this.buffer.length - MAX_BUFFER);
    }
  }

  matches(entry) {
    if (this.levelFilter !== 'all' && entry.level !== this.levelFilter) return false;
    if (this.q && !entry.line.toLowerCase().includes(this.q.toLowerCase())) return false;
    return true;
  }

  renderShell() {
    this.root.innerHTML = `
      <div class="panel">
        <h3>Live logs — ${this.process}</h3>
        <div class="logs__controls">
          <input type="text" id="log-search" placeholder="Filter lines (substring)…" />
          <select id="log-level">
            <option value="all">All levels</option>
            <option value="info">info (stdout)</option>
            <option value="error">error (stderr)</option>
          </select>
          <button type="button" class="btn btn--sm" id="log-clear">Clear</button>
        </div>
        <div class="logs__view" id="log-view"></div>
      </div>`;

    this.viewEl = this.root.querySelector('#log-view');
    this.root.querySelector('#log-search').addEventListener('input', (e) => {
      this.q = e.target.value;
      this.renderLines();
    });
    this.root.querySelector('#log-level').addEventListener('change', (e) => {
      this.levelFilter = e.target.value;
      this.renderLines();
    });
    this.root.querySelector('#log-clear').addEventListener('click', () => {
      this.buffer = [];
      this.renderLines();
    });
  }

  renderLines() {
    if (!this.viewEl) return;
    const atBottom = this.isAtBottom();
    this.viewEl.innerHTML = '';
    for (const entry of this.buffer) {
      if (this.matches(entry)) this.appendLineEl(entry, false);
    }
    if (atBottom) this.scrollToBottom();
  }

  appendLineEl(entry, autoscroll = true) {
    if (!this.viewEl) return;
    const atBottom = this.isAtBottom();
    const el = document.createElement('span');
    el.className = `log-line log-line--${entry.level}`;
    el.textContent = entry.line;
    this.viewEl.appendChild(el);
    if (autoscroll && atBottom) this.scrollToBottom();
  }

  isAtBottom() {
    if (!this.viewEl) return true;
    return this.viewEl.scrollHeight - this.viewEl.scrollTop - this.viewEl.clientHeight < 40;
  }

  scrollToBottom() {
    if (this.viewEl) this.viewEl.scrollTop = this.viewEl.scrollHeight;
  }
}
