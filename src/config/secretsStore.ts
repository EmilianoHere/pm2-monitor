/**
 * SecretsStore: persists the separable secrets overlay to a single JSON file
 * (`config/secrets.json`), kept apart from the non-secret settings overlay
 * (FR-D2, FR-E1). Mirrors {@link AliasStore} persistence (in-memory object =
 * source of truth; synchronous mutate then async coalesced temp-then-rename
 * write; corrupt/invalid → start empty + warn; write failure → keep memory +
 * warn). Written `0o600` on create.
 *
 * The ONLY secrets-derived data that ever leaves the process is `status()` — a
 * map of set/not-set booleans. `get()` is for the boot merge + effective-config
 * read only and is never serialized into a response.
 */

import {
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  rename as fsRename,
  chmod as fsChmod,
} from 'node:fs/promises';
import { z } from 'zod';
import type { SecretsOverlay, SecretsOverlayKey } from './env.js';
import type { Logger } from '../core/logger.js';
import type { ReadFileFn, WriteFileFn, RenameFn, ChmodFn } from '../server/apiKeyStore.js';

/** The four editable secret field names, in a stable order. */
export const SECRET_FIELDS: readonly SecretsOverlayKey[] = [
  'SMTP_PASS',
  'TEAMS_WEBHOOK_URL',
  'AGENT_TOKEN',
  'AGENT_TOKENS',
];

/** On-disk shape: a strict partial map restricted to the secret field names. */
export const secretsFileSchema = z
  .object({
    SMTP_PASS: z.string().min(1).optional(),
    TEAMS_WEBHOOK_URL: z.string().url().optional(),
    AGENT_TOKEN: z.string().min(1).optional(),
    AGENT_TOKENS: z.string().min(1).optional(),
  })
  .strict();

const SECRET_MODE = 0o600;

export interface SecretsStoreOptions {
  file: string;
  logger: Logger;
  readFile?: ReadFileFn;
  writeFile?: WriteFileFn;
  rename?: RenameFn;
  chmod?: ChmodFn;
}

export class SecretsValidationError extends Error {
  readonly code = 'VALIDATION';
  constructor(message: string) {
    super(message);
    this.name = 'SecretsValidationError';
  }
}

export class SecretsStore {
  private readonly file: string;
  private readonly tempFile: string;
  private readonly logger: Logger;
  private readonly readFile: ReadFileFn;
  private readonly writeFile: WriteFileFn;
  private readonly rename: RenameFn;
  private readonly chmod: ChmodFn;

  private secrets: SecretsOverlay = {};
  private firstWriteDone = false;
  private writing: Promise<void> | null = null;
  private dirty = false;

  constructor(opts: SecretsStoreOptions) {
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
      this.secrets = {};
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.logger.warn('secrets store file is not valid JSON; starting empty', {
        file: this.file,
        error: err instanceof Error ? err.message : String(err),
      });
      this.secrets = {};
      return;
    }
    const result = secretsFileSchema.safeParse(parsed);
    if (!result.success) {
      this.logger.warn('secrets store file failed validation; starting empty', {
        file: this.file,
        issues: result.error.issues.length,
      });
      this.secrets = {};
      return;
    }
    this.secrets = result.data as SecretsOverlay;
  }

  /** In-memory secret values (boot merge + effective read only; NEVER serialized). */
  get(): SecretsOverlay {
    return { ...this.secrets };
  }

  /**
   * Validates `patch`, merges it over the current secrets, then persists. Throws
   * {@link SecretsValidationError} WITHOUT touching memory/disk on invalid input.
   */
  async setMany(patch: SecretsOverlay): Promise<void> {
    const result = secretsFileSchema.safeParse(patch);
    if (!result.success) {
      const message = result.error.issues.map((i) => i.message).join('; ') || 'invalid secrets patch';
      throw new SecretsValidationError(message);
    }
    this.secrets = { ...this.secrets, ...(result.data as SecretsOverlay) };
    await this.persist();
  }

  /** Deletes a single secret field, then persists. */
  async clear(field: SecretsOverlayKey): Promise<void> {
    if (!(field in this.secrets)) return;
    const next = { ...this.secrets };
    delete next[field];
    this.secrets = next;
    await this.persist();
  }

  /** The ONLY secrets-derived data that leaves the process: set/not-set booleans. */
  status(): Record<SecretsOverlayKey, boolean> {
    return {
      SMTP_PASS: this.secrets.SMTP_PASS !== undefined,
      TEAMS_WEBHOOK_URL: this.secrets.TEAMS_WEBHOOK_URL !== undefined,
      AGENT_TOKEN: this.secrets.AGENT_TOKEN !== undefined,
      AGENT_TOKENS: this.secrets.AGENT_TOKENS !== undefined,
    };
  }

  private serialize(): string {
    return JSON.stringify(this.secrets, null, 2);
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
        this.logger.warn('failed to persist secrets store; keeping in-memory value', {
          file: this.file,
          error: err instanceof Error ? err.message : String(err),
        });
        this.dirty = false;
        return;
      }
    } while (this.dirty);
  }
}
