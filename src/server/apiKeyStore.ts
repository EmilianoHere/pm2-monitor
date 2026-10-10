/**
 * ApiKeyStore: persists secondary API keys to a single JSON file
 * (`config/api-keys.json`, shaped `{ "keys": [ { id, label, hash, prefix,
 * createdAt, status } ] }`). Mirrors {@link AliasStore} EXACTLY: the in-memory
 * `Map<id, Record>` is the SINGLE SOURCE OF TRUTH; a mutate validates then
 * updates the map synchronously then persists asynchronously; writes are
 * serialized and coalesced via the `writing`/`dirty` flush loop; each physical
 * write is write-to-temp-then-rename (atomic). A corrupt/missing file logs a
 * warn and starts empty; a write failure logs a warn and keeps the in-memory
 * value (never crashes, NFR-2).
 *
 * The RAW key is NEVER persisted (FR-B1): only its sha-256 hex digest, a
 * non-secret display prefix, and metadata are stored. A derived `Set<string>`
 * of active hashes is rebuilt on every mutate/load so `activeHashes()` — the
 * {@link KeyVerifier} surface auth consults — is O(1) to read.
 *
 * The file is created `0o600` (owner read/write only) on first write — the only
 * at-rest control for the MVP alongside the gitignore (design §2).
 */

import {
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  rename as fsRename,
  chmod as fsChmod,
} from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Logger } from '../core/logger.js';

/** sha-256 hex digest helper shared by the store + the service. */
export function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

const apiKeyRecordSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).max(100),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  prefix: z.string().min(1).max(16),
  createdAt: z.number().int().nonnegative(),
  status: z.enum(['active', 'revoked']),
});

const apiKeyFileSchema = z.object({ keys: z.array(apiKeyRecordSchema) }).strict();

export type ApiKeyRecord = z.infer<typeof apiKeyRecordSchema>;

/** The public, maskable view of a key row (never the raw key, never the hash). */
export interface PublicKeyRow {
  id: string;
  label: string;
  prefix: string;
  createdAt: number;
  status: 'active' | 'revoked';
}

/** The one-time result of a key generation (rawKey returned ONCE, never stored). */
export interface GeneratedKey {
  id: string;
  label: string;
  prefix: string;
  createdAt: number;
  rawKey: string;
}

export type ReadFileFn = (file: string) => Promise<string>;
/** WIDENED (vs AliasStore) to accept an optional `{ mode }` for 0o600 writes. */
export type WriteFileFn = (file: string, data: string, opts?: { mode?: number }) => Promise<void>;
export type RenameFn = (from: string, to: string) => Promise<void>;
export type ChmodFn = (file: string, mode: number) => Promise<void>;

export interface ApiKeyStoreOptions {
  file: string;
  logger: Logger;
  /** injectable async fs (tests). */
  readFile?: ReadFileFn;
  writeFile?: WriteFileFn;
  rename?: RenameFn;
  chmod?: ChmodFn;
  /** injectable clock. */
  now?: () => number;
}

const SECRET_MODE = 0o600;

export class ApiKeyStore {
  private readonly file: string;
  private readonly tempFile: string;
  private readonly logger: Logger;
  private readonly readFile: ReadFileFn;
  private readonly writeFile: WriteFileFn;
  private readonly rename: RenameFn;
  private readonly chmod: ChmodFn;
  private readonly now: () => number;

  private readonly map = new Map<string, ApiKeyRecord>();
  /** Derived set of ACTIVE key hashes; rebuilt on every mutate/load. */
  private activeHashSet = new Set<string>();
  /** True until the first successful write, so we chmod 0o600 once on create. */
  private firstWriteDone = false;

  private writing: Promise<void> | null = null;
  private dirty = false;

  constructor(opts: ApiKeyStoreOptions) {
    this.file = opts.file;
    this.tempFile = `${opts.file}.tmp`;
    this.logger = opts.logger;
    this.readFile = opts.readFile ?? ((f) => fsReadFile(f, 'utf8'));
    this.writeFile = opts.writeFile ?? ((f, d, o) => fsWriteFile(f, d, { encoding: 'utf8', ...(o ?? {}) }));
    this.rename = opts.rename ?? ((from, to) => fsRename(from, to));
    this.chmod = opts.chmod ?? ((f, m) => fsChmod(f, m));
    this.now = opts.now ?? (() => Date.now());
  }

  /** Reads + validates the file into the in-memory map. Tolerant of all failure. */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await this.readFile(this.file);
    } catch {
      this.map.clear();
      this.rebuildActiveHashes();
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.logger.warn('api-key store file is not valid JSON; starting empty', {
        file: this.file,
        error: err instanceof Error ? err.message : String(err),
      });
      this.map.clear();
      this.rebuildActiveHashes();
      return;
    }
    const result = apiKeyFileSchema.safeParse(parsed);
    if (!result.success) {
      this.logger.warn('api-key store file failed validation; starting empty', {
        file: this.file,
        issues: result.error.issues.length,
      });
      this.map.clear();
      this.rebuildActiveHashes();
      return;
    }
    this.map.clear();
    for (const record of result.data.keys) {
      this.map.set(record.id, record);
    }
    this.rebuildActiveHashes();
  }

  /** The {@link KeyVerifier} surface auth consults: ACTIVE key hashes. */
  activeHashes(): readonly string[] {
    return [...this.activeHashSet];
  }

  /** Maskable rows (label/prefix/createdAt/status only; never raw key/hash). */
  list(): PublicKeyRow[] {
    return [...this.map.values()].map((r) => ({
      id: r.id,
      label: r.label,
      prefix: r.prefix,
      createdAt: r.createdAt,
      status: r.status,
    }));
  }

  /**
   * Generates a new active key. Returns the raw key ONCE (never persisted);
   * persists only hash+prefix+meta. Resolves after the write settles.
   */
  async generate(label: string): Promise<GeneratedKey> {
    const rawKey = randomBytes(32).toString('base64url');
    const id = randomUUID();
    const createdAt = this.now();
    const prefix = `pmk_${rawKey.slice(0, 8)}`;
    const record: ApiKeyRecord = {
      id,
      label,
      hash: sha256hex(rawKey),
      prefix,
      createdAt,
      status: 'active',
    };
    this.map.set(id, record);
    this.rebuildActiveHashes();
    await this.persist();
    return { id, label, prefix, createdAt, rawKey };
  }

  /** Flips a key to `revoked` (dropping it from activeHashes). False if unknown. */
  async revoke(id: string): Promise<boolean> {
    const record = this.map.get(id);
    if (!record) return false;
    this.map.set(id, { ...record, status: 'revoked' });
    this.rebuildActiveHashes();
    await this.persist();
    return true;
  }

  /** Updates ONLY the label; hash/prefix/id unchanged. False if unknown. */
  async relabel(id: string, label: string): Promise<boolean> {
    const record = this.map.get(id);
    if (!record) return false;
    this.map.set(id, { ...record, label });
    // Label does not affect active hashes, but rebuild for consistency.
    this.rebuildActiveHashes();
    await this.persist();
    return true;
  }

  private rebuildActiveHashes(): void {
    const next = new Set<string>();
    for (const record of this.map.values()) {
      if (record.status === 'active') next.add(record.hash);
    }
    this.activeHashSet = next;
  }

  private serialize(): string {
    return JSON.stringify({ keys: [...this.map.values()] }, null, 2);
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
          // Defensive chmod on first create (best-effort; Windows ignores mode).
          try {
            await this.chmod(this.file, SECRET_MODE);
          } catch {
            /* best-effort; non-fatal */
          }
          this.firstWriteDone = true;
        }
      } catch (err) {
        this.logger.warn('failed to persist api-key store; keeping in-memory value', {
          file: this.file,
          error: err instanceof Error ? err.message : String(err),
        });
        this.dirty = false;
        return;
      }
    } while (this.dirty);
  }
}

/**
 * ApiKeyService: a thin wrapper exposing the generate/list/revoke/relabel/
 * activeHashes surface the routes + auth consume. Backed by an
 * {@link ApiKeyStore} (its KeyVerifier reads the same in-memory active-hash set).
 */
export class ApiKeyService {
  constructor(private readonly store: ApiKeyStore) {}

  generate(label: string): Promise<GeneratedKey> {
    return this.store.generate(label);
  }

  list(): PublicKeyRow[] {
    return this.store.list();
  }

  revoke(id: string): Promise<boolean> {
    return this.store.revoke(id);
  }

  relabel(id: string, label: string): Promise<boolean> {
    return this.store.relabel(id, label);
  }

  activeHashes(): readonly string[] {
    return this.store.activeHashes();
  }
}
