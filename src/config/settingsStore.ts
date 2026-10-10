/**
 * SettingsStore: persists the NON-secret editable config overlay to a single
 * JSON file (`config/settings.json`, a flat `{ KEY: value }` partial of the env
 * keys). Mirrors {@link AliasStore} persistence (in-memory object = source of
 * truth; synchronous mutate then async coalesced temp-then-rename write;
 * corrupt/invalid → start empty + warn; write failure → keep memory + warn).
 *
 * The on-disk shape is `settingsPatchSchema` restricted to the non-secret keys,
 * so a secret can NEVER land in `config/settings.json` (secrets live only in the
 * secrets store, §2.3). `get()` returns a shallow copy that feeds
 * `mergeEffectiveConfig` directly. The file is written `0o600` on create.
 */

import {
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  rename as fsRename,
  chmod as fsChmod,
} from 'node:fs/promises';
import { z } from 'zod';
import { configObjectSchema, type SettingsOverlay } from './env.js';
import type { Logger } from '../core/logger.js';
import type { ReadFileFn, WriteFileFn, RenameFn, ChmodFn } from '../server/apiKeyStore.js';

/** The four secret keys that must NEVER appear in the non-secret settings file. */
const SECRET_KEYS = ['SMTP_PASS', 'TEAMS_WEBHOOK_URL', 'AGENT_TOKEN', 'AGENT_TOKENS'] as const;

/**
 * The on-disk/`setMany` schema: a partial of every editable key with the four
 * secret keys stripped, so only non-secret overlay keys are accepted. Derived
 * from the pre-refine object schema (no cross-field guard fires on a partial).
 */
export const settingsOverlaySchema = configObjectSchema
  .omit({ SMTP_PASS: true, TEAMS_WEBHOOK_URL: true, AGENT_TOKEN: true, AGENT_TOKENS: true })
  .partial()
  .strict();

const SECRET_MODE = 0o600;

export interface SettingsStoreOptions {
  file: string;
  logger: Logger;
  readFile?: ReadFileFn;
  writeFile?: WriteFileFn;
  rename?: RenameFn;
  chmod?: ChmodFn;
}

export class SettingsValidationError extends Error {
  readonly code = 'VALIDATION';
  constructor(message: string) {
    super(message);
    this.name = 'SettingsValidationError';
  }
}

export class SettingsStore {
  private readonly file: string;
  private readonly tempFile: string;
  private readonly logger: Logger;
  private readonly readFile: ReadFileFn;
  private readonly writeFile: WriteFileFn;
  private readonly rename: RenameFn;
  private readonly chmod: ChmodFn;

  private overlay: SettingsOverlay = {};
  private firstWriteDone = false;
  private writing: Promise<void> | null = null;
  private dirty = false;

  constructor(opts: SettingsStoreOptions) {
    this.file = opts.file;
    this.tempFile = `${opts.file}.tmp`;
    this.logger = opts.logger;
    this.readFile = opts.readFile ?? ((f) => fsReadFile(f, 'utf8'));
    this.writeFile = opts.writeFile ?? ((f, d, o) => fsWriteFile(f, d, { encoding: 'utf8', ...(o ?? {}) }));
    this.rename = opts.rename ?? ((from, to) => fsRename(from, to));
    this.chmod = opts.chmod ?? ((f, m) => fsChmod(f, m));
  }

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await this.readFile(this.file);
    } catch {
      this.overlay = {};
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.logger.warn('settings store file is not valid JSON; starting empty', {
        file: this.file,
        error: err instanceof Error ? err.message : String(err),
      });
      this.overlay = {};
      return;
    }
    const result = settingsOverlaySchema.safeParse(parsed);
    if (!result.success) {
      this.logger.warn('settings store file failed validation; starting empty', {
        file: this.file,
        issues: result.error.issues.length,
      });
      this.overlay = {};
      return;
    }
    this.overlay = result.data as SettingsOverlay;
  }

  /** A shallow copy of the current non-secret overlay. */
  get(): SettingsOverlay {
    return { ...this.overlay };
  }

  /**
   * Validates `patch` (rejecting unknown/secret keys), merges it over the
   * current overlay, then persists. Throws {@link SettingsValidationError}
   * WITHOUT touching the overlay or disk on an invalid patch.
   */
  async setMany(patch: SettingsOverlay): Promise<void> {
    const result = settingsOverlaySchema.safeParse(patch);
    if (!result.success) {
      const message = result.error.issues.map((i) => i.message).join('; ') || 'invalid settings patch';
      throw new SettingsValidationError(message);
    }
    this.overlay = { ...this.overlay, ...(result.data as SettingsOverlay) };
    await this.persist();
  }

  private serialize(): string {
    return JSON.stringify(this.overlay, null, 2);
  }

  private async persist(): Promise<void> {
    if (this.writing) {
      this.dirty = true;
      await this.writing;
      return;
    }
    this.writing = this.flushLoop();
    try {
      await this.writing;
    } finally {
      this.writing = null;
    }
  }

  private async flushLoop(): Promise<void> {
    do {
      this.dirty = false;
      const payload = this.serialize();
      try {
        await this.writeFile(this.tempFile, payload, { mode: SECRET_MODE });
        await this.rename(this.tempFile, this.file);
        if (!this.firstWriteDone) {
          try {
            await this.chmod(this.file, SECRET_MODE);
          } catch {
            /* best-effort; non-fatal */
          }
          this.firstWriteDone = true;
        }
      } catch (err) {
        this.logger.warn('failed to persist settings store; keeping in-memory value', {
          file: this.file,
          error: err instanceof Error ? err.message : String(err),
        });
        this.dirty = false;
        return;
      }
    } while (this.dirty);
  }
}

export { SECRET_KEYS };
