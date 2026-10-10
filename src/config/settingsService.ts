/**
 * SettingsService: the orchestration layer the settings routes call. It owns the
 * settings + secrets stores, the current effective `AppConfig`, and the live
 * subsystem handles used for hot application (design §4.3).
 *
 * - `readEffective()` returns the effective config split into hot/restart groups
 *   per the §3 table; secret fields AND `SERVER_URL` are replaced by set/not-set
 *   booleans (never plaintext); restart-required fields with a pending overlay
 *   value carry `pendingRestart: true`.
 * - `applySettings(patch)` runs the two-stage validation (§4.2) — a shape/type
 *   pass then the full-config cross-field pass over `{ ...effectiveConfig,
 *   ...patch }` — persists non-secret keys to the settings store and secret keys
 *   to the secrets store, recomputes the effective config, then applies hot
 *   fields live. Any validation failure persists NOTHING.
 * - `clearSecret(field)` deletes a secret and re-applies it hot if applicable.
 */

import {
  configSchema,
  settingsPatchSchema,
  mergeEffectiveConfig,
  type AppConfig,
  type SettingsOverlay,
  type SecretsOverlay,
  type SecretsOverlayKey,
} from './env.js';
import type { SettingsStore } from './settingsStore.js';
import type { SecretsStore } from './secretsStore.js';
import type { SmtpConfig } from '../alerts/channels/email.js';
import type { Logger, LogLevel } from '../core/logger.js';

/** The hot vs restart-required classification per the design §3 table. */
export type SettingGroup = 'hot' | 'restart';

/** The nine HOT-reloadable keys (design §3). */
const HOT_KEYS = [
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURE',
  'SMTP_USER',
  'SMTP_PASS',
  'MAIL_FROM',
  'MAIL_TO',
  'TEAMS_WEBHOOK_URL',
  'ERROR_LOG_APPEND',
  'DEFAULT_COOLDOWN_SEC',
  'DIGEST_ENABLED',
  'DIGEST_HOUR',
  'LOG_LEVEL',
] as const;

const HOT_KEY_SET = new Set<string>(HOT_KEYS);

/** The four true secrets (secrets.json) plus SERVER_URL, all masked in GET. */
const SECRET_KEYS: readonly SecretsOverlayKey[] = [
  'SMTP_PASS',
  'TEAMS_WEBHOOK_URL',
  'AGENT_TOKEN',
  'AGENT_TOKENS',
];
/**
 * Keys whose value is NEVER serialized in a GET response (set/not-set only):
 * the four true secrets, SERVER_URL, and the master credentials (API_KEY,
 * BASIC_USER, BASIC_PASS). The master credentials are plain members of
 * AppConfig that readEffective would otherwise enumerate into plaintext, so
 * they must be masked here (NFR-4 / AC-25 / AC-29).
 */
const MASKED_KEYS = new Set<string>([...SECRET_KEYS, 'SERVER_URL', 'API_KEY', 'BASIC_USER', 'BASIC_PASS']);

/** One rendered field in the grouped settings view. */
export interface SettingField {
  key: string;
  group: SettingGroup;
  /** For non-masked fields: the effective value. Omitted for masked fields. */
  value?: unknown;
  /** For masked (secret + SERVER_URL) fields: whether a value is set. */
  isSet?: boolean;
  /** True when the field is masked (secret or SERVER_URL): never carries value. */
  masked: boolean;
  /** Restart-required field with a pending overlay value awaiting a restart. */
  pendingRestart?: boolean;
}

/** The masked, grouped effective-config view returned by GET /api/settings. */
export interface GroupedSettings {
  hot: SettingField[];
  restart: SettingField[];
}

/** The live subsystem handles the service applies hot changes to (design §4.4). */
export interface SettingsHandles {
  teams: { reconfigure(webhookUrl?: string): void };
  email: { reconfigure(smtp?: SmtpConfig): void };
  engine: { setDefaultCooldownSec(n: number): void };
  digest: { setEnabled(b: boolean): void; setDigestHour(n: number): void };
  errors: { setLogAppend(b: boolean): void };
  logger: Logger;
}

/** Thrown on a settings validation failure; the route maps it to 400. */
export class SettingsValidationError extends Error {
  readonly code = 'VALIDATION';
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'SettingsValidationError';
  }
}

export interface SettingsServiceOptions {
  settingsStore: SettingsStore;
  secretsStore: SecretsStore;
  /** The frozen `.env` base config (parseConfig output). */
  base: AppConfig;
  handles: SettingsHandles;
}

export class SettingsService {
  private readonly settingsStore: SettingsStore;
  private readonly secretsStore: SecretsStore;
  private readonly base: AppConfig;
  private readonly handles: SettingsHandles;
  private effective: Readonly<AppConfig>;

  constructor(opts: SettingsServiceOptions) {
    this.settingsStore = opts.settingsStore;
    this.secretsStore = opts.secretsStore;
    this.base = opts.base;
    this.handles = opts.handles;
    this.effective = mergeEffectiveConfig(this.base, this.settingsStore.get(), this.secretsStore.get());
  }

  /** The current effective config (base + overlays). */
  getEffective(): Readonly<AppConfig> {
    return this.effective;
  }

  private groupOf(key: string): SettingGroup {
    return HOT_KEY_SET.has(key) ? 'hot' : 'restart';
  }

  /** The grouped, masked effective-config view (design §4.3). */
  readEffective(): GroupedSettings {
    const overlay = this.settingsStore.get() as Record<string, unknown>;
    const grouped: GroupedSettings = { hot: [], restart: [] };
    // Always render the masked keys (secrets + SERVER_URL) even when unset, so
    // the UI can show a "not set" indicator; render every present base key too.
    const keys = new Set<string>([...Object.keys(this.base), ...MASKED_KEYS]);
    for (const k of keys) {
      const key = k as keyof AppConfig;
      const group = this.groupOf(k);
      const masked = MASKED_KEYS.has(k);
      const field: SettingField = { key: k, group, masked };
      if (masked) {
        field.isSet = this.effective[key] !== undefined;
      } else {
        field.value = this.effective[key];
      }
      if (group === 'restart') {
        // Pending when an overlay carries this key and it differs from boot.
        // For masked SERVER_URL the marker is derived from overlay presence only.
        if (k === 'SERVER_URL') {
          field.pendingRestart = k in overlay;
        } else if (k in overlay && this.base[key] !== this.effective[key]) {
          field.pendingRestart = true;
        }
      }
      grouped[group].push(field);
    }
    return grouped;
  }

  /**
   * Two-stage validation + persist + hot-apply (design §4.2/§4.3). Persists
   * NOTHING on any validation failure.
   */
  async applySettings(patch: Record<string, unknown>): Promise<{ warnings: string[] }> {
    // Stage 1: shape/type/field-level.
    const shape = settingsPatchSchema.safeParse(patch);
    if (!shape.success) {
      throw new SettingsValidationError(summarizeZod(shape.error));
    }
    const parsed = shape.data as Record<string, unknown>;

    // Stage 2: cross-field over the post-write state (patch wins over the
    // current effective config, so a patched secret overrides the stored one).
    const merged = { ...this.effective, ...parsed };
    const cross = configSchema.safeParse(merged);
    if (!cross.success) {
      throw new SettingsValidationError(summarizeZod(cross.error));
    }

    // Split by the secret allowlist (secrets never land in settings.json).
    const nonSecret: Record<string, unknown> = {};
    const secret: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (SECRET_KEYS.includes(k as SecretsOverlayKey)) secret[k] = v;
      else nonSecret[k] = v;
    }

    if (Object.keys(nonSecret).length > 0) {
      await this.settingsStore.setMany(nonSecret as SettingsOverlay);
    }
    if (Object.keys(secret).length > 0) {
      await this.secretsStore.setMany(secret as SecretsOverlay);
    }

    this.effective = mergeEffectiveConfig(this.base, this.settingsStore.get(), this.secretsStore.get());

    const changedHot = Object.keys(parsed).filter((k) => HOT_KEY_SET.has(k));
    return { warnings: this.applyHot(changedHot) };
  }

  /** Clears a single secret, recomputes, and re-applies it hot if applicable. */
  async clearSecret(field: SecretsOverlayKey): Promise<{ warnings: string[] }> {
    await this.secretsStore.clear(field);
    this.effective = mergeEffectiveConfig(this.base, this.settingsStore.get(), this.secretsStore.get());
    const warnings = HOT_KEY_SET.has(field) ? this.applyHot([field]) : [];
    return { warnings };
  }

  /**
   * Applies each changed HOT field to its owning subsystem (design §3/§4.4). A
   * setter throw is caught, logged `warn`, and surfaced as a warning note — the
   * overlay is already persisted, so the value survives a restart.
   */
  private applyHot(fields: string[]): string[] {
    const warnings: string[] = [];
    const touchesSmtp = fields.some((f) =>
      ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM', 'MAIL_TO'].includes(f),
    );
    for (const field of fields) {
      try {
        switch (field) {
          case 'LOG_LEVEL':
            this.handles.logger.setLevel(this.effective.LOG_LEVEL as LogLevel);
            break;
          case 'DEFAULT_COOLDOWN_SEC':
            this.handles.engine.setDefaultCooldownSec(this.effective.DEFAULT_COOLDOWN_SEC);
            break;
          case 'DIGEST_ENABLED':
            this.handles.digest.setEnabled(this.effective.DIGEST_ENABLED);
            break;
          case 'DIGEST_HOUR':
            this.handles.digest.setDigestHour(this.effective.DIGEST_HOUR);
            break;
          case 'ERROR_LOG_APPEND':
            this.handles.errors.setLogAppend(this.effective.ERROR_LOG_APPEND);
            break;
          case 'TEAMS_WEBHOOK_URL':
            this.handles.teams.reconfigure(this.effective.TEAMS_WEBHOOK_URL);
            break;
          default:
            // SMTP_* / MAIL_* are handled once below.
            break;
        }
      } catch (err) {
        warnings.push(`${field}: live apply failed (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    if (touchesSmtp) {
      try {
        this.handles.email.reconfigure(this.buildSmtp());
      } catch (err) {
        warnings.push(`SMTP: live apply failed (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    return warnings;
  }

  /** Assembles the SmtpConfig from the effective config, or undefined if partial. */
  private buildSmtp(): SmtpConfig | undefined {
    const c = this.effective;
    if (!c.SMTP_HOST || !c.SMTP_USER || !c.SMTP_PASS || !c.MAIL_FROM || !c.MAIL_TO) {
      return undefined;
    }
    return {
      host: c.SMTP_HOST,
      port: c.SMTP_PORT,
      secure: c.SMTP_SECURE,
      user: c.SMTP_USER,
      pass: c.SMTP_PASS,
      from: c.MAIL_FROM,
      to: c.MAIL_TO,
    };
  }
}

function summarizeZod(err: { issues: Array<{ path: (string | number)[]; message: string }> }): string {
  return err.issues
    .map((i) => {
      const where = i.path.join('.');
      return where ? `${where}: ${i.message}` : i.message;
    })
    .join('; ');
}
