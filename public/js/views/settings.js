// Settings view (master session only). Two panels:
//
//   1. Configuration — the effective config split into "Hot (applies
//      immediately)" and "Restart required" groups (GET /api/settings). Non-secret
//      fields are editable inputs seeded with their effective value; a saved
//      restart-required field whose overlay differs from boot shows a
//      "pending until restart" badge. Secret/masked fields (SMTP_PASS,
//      TEAMS_WEBHOOK_URL, AGENT_TOKEN, AGENT_TOKENS, SERVER_URL) render as
//      write-only inputs with a set/not-set indicator and a Clear button; they are
//      NEVER prefilled with a value. Save sends PUT /api/settings; a 400 VALIDATION
//      surfaces per-field messages inline. An empty secret input is omitted on Save
//      (clearing is explicit via Clear).
//
//   2. API Keys — Generate prompts for a label, POSTs, then shows the raw key ONCE
//      in a modal with Copy and a "won't be shown again" warning. A table of
//      label/prefix/createdAt/status offers Revoke (confirm) and inline relabel.
//      The list never shows raw keys or hashes. Under AUTH_MODE=basic a banner
//      notes generated keys authenticate only when AUTH_MODE=apikey.
//
// This view is only ever mounted after GET /api/settings/whoami returns 200; the
// server hard-enforces master-only (requireMaster), so this gating is convenience.

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Secrets cleared via DELETE /api/settings/secrets/:field. SERVER_URL is masked
// write-only too but lives in the settings overlay, so it is cleared via a PUT
// that unsets it (per the FEAT-002 route contract).
const SECRET_FIELDS = ['SMTP_PASS', 'TEAMS_WEBHOOK_URL', 'AGENT_TOKEN', 'AGENT_TOKENS'];

function fmtDate(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

export class SettingsView {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.root
   * @param {object} opts.api                 the shared api client
   * @param {(msg:string, kind?:string)=>void} opts.toast
   * @param {(opts:object)=>Promise<boolean>} opts.confirm   confirm dialog
   * @param {string} opts.authMode            'apikey' | 'basic' (from whoami)
   */
  constructor({ root, api, toast, confirm, authMode }) {
    this.root = root;
    this.api = api;
    this.toast = toast;
    this.confirm = confirm;
    this.authMode = authMode || 'apikey';

    this.settings = null; // { hot: SettingField[], restart: SettingField[] }
    this.keys = []; // PublicKeyRow[]
    this.fieldErrors = {}; // key -> message (from the last 400 VALIDATION)
    this.editingKey = null; // key id currently being relabeled
    this.loadError = null;
  }

  // Fetch both panels, then render. Called on mount and after any mutation.
  async refresh() {
    this.loadError = null;
    try {
      const [settings, keys] = await Promise.all([
        this.api.getSettings(),
        this.api.listKeys(),
      ]);
      this.settings = settings;
      this.keys = Array.isArray(keys) ? keys : [];
    } catch (err) {
      this.loadError = err.message;
    }
    this.render();
  }

  // Alias used by the router mount.
  mount() {
    return this.refresh();
  }

  render() {
    if (this.loadError) {
      this.root.innerHTML = `
        <div class="section-head"><h1>Settings</h1></div>
        <div class="empty"><p>Could not load settings: ${escapeHtml(this.loadError)}</p></div>`;
      return;
    }
    if (!this.settings) {
      this.root.innerHTML = `
        <div class="section-head"><h1>Settings</h1></div>
        <div class="empty"><p>Loading…</p></div>`;
      return;
    }

    this.root.innerHTML = `
      <div class="section-head"><h1>Settings</h1></div>
      <div class="settings">
        ${this.configPanelHtml()}
        ${this.keysPanelHtml()}
      </div>`;
    this.bind();
  }

  // --- configuration panel ---

  configPanelHtml() {
    const hot = this.settings.hot || [];
    const restart = this.settings.restart || [];
    return `
      <section class="panel settings__config">
        <h3>Configuration</h3>
        <form data-settings-form>
          <div class="settings__group">
            <h4 class="settings__group-title">Hot (applies immediately)</h4>
            ${hot.length ? hot.map((f) => this.fieldHtml(f)).join('') : '<p class="metric__label">No hot fields.</p>'}
          </div>
          <div class="settings__group">
            <h4 class="settings__group-title">Restart required</h4>
            ${restart.length ? restart.map((f) => this.fieldHtml(f)).join('') : '<p class="metric__label">No restart-required fields.</p>'}
          </div>
          <div class="settings__actions">
            <button type="submit" class="btn btn--primary" data-settings-save>Save</button>
          </div>
        </form>
      </section>`;
  }

  fieldHtml(f) {
    const key = f.key;
    const err = this.fieldErrors[key];
    const errHtml = err
      ? `<span class="settings__field-error">${escapeHtml(err)}</span>`
      : '';
    const pending = f.pendingRestart
      ? '<span class="badge badge--pending" title="Saved; takes effect after a restart">pending until restart</span>'
      : '';

    if (f.masked) {
      const indicator = f.isSet
        ? '<span class="status status--online">set</span>'
        : '<span class="status status--stopped">not set</span>';
      return `
        <div class="settings__field secret-field">
          <label class="settings__field-label" for="set-${escapeHtml(key)}">
            ${escapeHtml(key)} ${pending}
          </label>
          <div class="secret-field__row">
            ${indicator}
            <input type="password" id="set-${escapeHtml(key)}"
              data-field="${escapeHtml(key)}" data-secret="1"
              placeholder="${f.isSet ? '•••••••• (write-only — leave blank to keep)' : 'not set'}"
              autocomplete="new-password" />
            <button type="button" class="btn btn--sm btn--ghost" data-clear-field="${escapeHtml(key)}"
              ${f.isSet ? '' : 'disabled'} title="Clear this value">Clear</button>
          </div>
          ${errHtml}
        </div>`;
    }

    // Non-secret: editable input seeded with the effective value.
    const value = f.value === undefined || f.value === null ? '' : f.value;
    return `
      <div class="settings__field">
        <label class="settings__field-label" for="set-${escapeHtml(key)}">
          ${escapeHtml(key)} ${pending}
        </label>
        <input type="text" id="set-${escapeHtml(key)}" data-field="${escapeHtml(key)}"
          value="${escapeHtml(value)}" />
        ${errHtml}
      </div>`;
  }

  // --- api keys panel ---

  keysPanelHtml() {
    const basicBanner =
      this.authMode === 'basic'
        ? `<div class="banner banner--warn settings__banner" role="status">
             Generated keys authenticate only when <code>AUTH_MODE=apikey</code>;
             in basic mode they are stored for later use.
           </div>`
        : '';

    const rows = this.keys.length
      ? this.keys.map((k) => this.keyRowHtml(k)).join('')
      : `<tr><td colspan="5" class="metric__label">No API keys yet.</td></tr>`;

    return `
      <section class="panel settings__keys">
        <div class="section-head">
          <h3>API Keys</h3>
          <button type="button" class="btn btn--sm btn--primary" data-generate-key>Generate</button>
        </div>
        ${basicBanner}
        <table class="data-table">
          <thead>
            <tr><th>Label</th><th>Prefix</th><th>Created</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </section>`;
  }

  keyRowHtml(k) {
    const id = k.id;
    const statusHtml =
      k.status === 'active'
        ? '<span class="status status--online">active</span>'
        : '<span class="status status--stopped">revoked</span>';

    const labelCell =
      this.editingKey === id
        ? `<input type="text" class="key-relabel-input" data-relabel-input="${escapeHtml(id)}"
             value="${escapeHtml(k.label ?? '')}" maxlength="100" />
           <button type="button" class="btn btn--sm" data-relabel-save="${escapeHtml(id)}">Save</button>
           <button type="button" class="btn btn--sm btn--ghost" data-relabel-cancel="${escapeHtml(id)}">Cancel</button>`
        : `<span class="key-label">${escapeHtml(k.label ?? '')}</span>
           <button type="button" class="btn btn--sm btn--ghost" data-relabel-edit="${escapeHtml(id)}" title="Rename (visual only)">✎</button>`;

    const actions =
      k.status === 'active'
        ? `<button type="button" class="btn btn--sm btn--danger" data-revoke-key="${escapeHtml(id)}">Revoke</button>`
        : '';

    return `
      <tr data-key-row="${escapeHtml(id)}">
        <td>${labelCell}</td>
        <td><code>${escapeHtml(k.prefix ?? '')}</code></td>
        <td>${escapeHtml(fmtDate(k.createdAt))}</td>
        <td>${statusHtml}</td>
        <td>${actions}</td>
      </tr>`;
  }

  // --- events ---

  bind() {
    const form = this.root.querySelector('[data-settings-form]');
    if (form) form.addEventListener('submit', (e) => this.save(e));

    for (const el of this.root.querySelectorAll('[data-clear-field]')) {
      el.addEventListener('click', () => this.clearField(el.dataset.clearField));
    }

    const gen = this.root.querySelector('[data-generate-key]');
    if (gen) gen.addEventListener('click', () => this.generate());

    for (const el of this.root.querySelectorAll('[data-revoke-key]')) {
      el.addEventListener('click', () => this.revoke(el.dataset.revokeKey));
    }
    for (const el of this.root.querySelectorAll('[data-relabel-edit]')) {
      el.addEventListener('click', () => {
        this.editingKey = el.dataset.relabelEdit;
        this.render();
        const input = this.root.querySelector('[data-relabel-input]');
        if (input) input.focus();
      });
    }
    for (const el of this.root.querySelectorAll('[data-relabel-cancel]')) {
      el.addEventListener('click', () => {
        this.editingKey = null;
        this.render();
      });
    }
    for (const el of this.root.querySelectorAll('[data-relabel-save]')) {
      el.addEventListener('click', () => this.relabel(el.dataset.relabelSave));
    }
    const relabelInput = this.root.querySelector('[data-relabel-input]');
    if (relabelInput) {
      relabelInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this.relabel(relabelInput.dataset.relabelInput);
        if (e.key === 'Escape') {
          this.editingKey = null;
          this.render();
        }
      });
    }
  }

  // Collect every field input into a patch, omitting blank secret inputs so Save
  // never clears a secret implicitly (clearing is explicit via the Clear button).
  collectPatch() {
    const patch = {};
    for (const input of this.root.querySelectorAll('[data-field]')) {
      const key = input.dataset.field;
      const isSecret = input.dataset.secret === '1';
      const raw = input.value;
      if (isSecret) {
        if (raw === '') continue; // blank secret -> leave as-is
        patch[key] = raw;
      } else {
        patch[key] = raw;
      }
    }
    return patch;
  }

  async save(e) {
    if (e) e.preventDefault();
    this.fieldErrors = {};
    const patch = this.collectPatch();
    try {
      const updated = await this.api.putSettings(patch);
      this.settings = updated;
      this.toast('Settings saved', 'success');
      if (Array.isArray(updated.warnings) && updated.warnings.length) {
        this.toast(`Applied with warnings: ${updated.warnings.join('; ')}`, 'info');
      }
      this.render();
    } catch (err) {
      if (err.code === 'VALIDATION') {
        // Surface the per-field message inline. The server message typically
        // names the field; keep the full message and show it against the whole
        // form plus the first field if parseable.
        this.toast(`Validation failed: ${err.message}`, 'error');
        this.applyValidationError(err.message);
        this.render();
      } else {
        this.toast(`Save failed: ${err.message}`, 'error');
      }
    }
  }

  // Best-effort mapping of a zod-style message ("FIELD: reason") to inline field
  // errors. Falls back to a form-level toast only (already raised by save()).
  applyValidationError(message) {
    const text = String(message || '');
    const known = [...(this.settings.hot || []), ...(this.settings.restart || [])].map(
      (f) => f.key,
    );
    for (const key of known) {
      if (text.includes(key)) {
        this.fieldErrors[key] = text;
      }
    }
  }

  async clearField(field) {
    const ok = await this.confirm({
      title: 'Clear value',
      body: `Clear ${field}? This removes the stored value.`,
      confirmLabel: 'Clear',
    });
    if (!ok) return;
    try {
      if (SECRET_FIELDS.includes(field)) {
        this.settings = await this.api.clearSecret(field);
      } else {
        // SERVER_URL and other masked overlay fields: unset via PUT.
        this.settings = await this.api.putSettings({ [field]: '' });
      }
      this.toast(`${field} cleared`, 'success');
      this.render();
    } catch (err) {
      this.toast(`Clear failed: ${err.message}`, 'error');
    }
  }

  async generate() {
    const label = (window.prompt('Label for the new API key:') || '').trim();
    if (!label) return;
    try {
      const created = await this.api.generateKey(label);
      this.showKeyModal(created);
      await this.refresh();
    } catch (err) {
      this.toast(`Generate failed: ${err.message}`, 'error');
    }
  }

  // One-time raw-key modal (reuses the .modal pattern). The raw key is shown here
  // and nowhere else; the list never carries it.
  showKeyModal(created) {
    const existing = document.getElementById('key-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.className = 'modal key-modal';
    modal.id = 'key-modal';
    modal.innerHTML = `
      <div class="modal__backdrop" data-key-modal-close></div>
      <div class="modal__dialog" role="dialog" aria-modal="true" aria-labelledby="key-modal-title">
        <h2 class="modal__title" id="key-modal-title">API key created</h2>
        <p class="modal__body">
          Copy this key now. You won't be able to see it again — only its prefix and
          label are stored.
        </p>
        <div class="key-modal__value">
          <code data-key-raw>${escapeHtml(created.rawKey)}</code>
          <button type="button" class="btn btn--sm" data-key-copy>Copy</button>
        </div>
        <div class="modal__actions">
          <button type="button" class="btn btn--primary" data-key-modal-close>Done</button>
        </div>
      </div>`;
    document.body.appendChild(modal);

    const close = () => modal.remove();
    for (const el of modal.querySelectorAll('[data-key-modal-close]')) {
      el.addEventListener('click', close);
    }
    const copyBtn = modal.querySelector('[data-key-copy]');
    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(created.rawKey);
          } else {
            const range = document.createRange();
            range.selectNodeContents(modal.querySelector('[data-key-raw]'));
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            document.execCommand('copy');
            sel.removeAllRanges();
          }
          this.toast('Key copied to clipboard', 'success');
        } catch {
          this.toast('Copy failed — select and copy manually', 'error');
        }
      });
    }
  }

  async revoke(id) {
    const ok = await this.confirm({
      title: 'Revoke key',
      body: 'Revoke this API key? It will immediately stop authenticating.',
      confirmLabel: 'Revoke',
    });
    if (!ok) return;
    try {
      await this.api.revokeKey(id);
      this.toast('Key revoked', 'success');
      await this.refresh();
    } catch (err) {
      this.toast(`Revoke failed: ${err.message}`, 'error');
    }
  }

  async relabel(id) {
    const input = this.root.querySelector(`[data-relabel-input="${CSS.escape(id)}"]`);
    const label = input ? input.value.trim() : '';
    if (!label) {
      this.toast('Label cannot be empty', 'error');
      return;
    }
    try {
      await this.api.relabelKey(id, label);
      this.toast('Key relabeled', 'success');
      this.editingKey = null;
      await this.refresh();
    } catch (err) {
      this.toast(`Relabel failed: ${err.message}`, 'error');
    }
  }
}
