/**
 * AliasStore: persists cosmetic per-agent display aliases to a single JSON file
 * (`ALIAS_STORE_FILE`, shaped `{ [agentId]: alias }`). There is no database
 * (NFR-6) — the alias is a loss-tolerant convenience label and never changes
 * routing/keying (always by `agentId`).
 *
 * The in-memory map is the SINGLE SOURCE OF TRUTH: `set()` validates, updates
 * the map SYNCHRONOUSLY (so a following `get`/`all` already sees the new value),
 * then persists asynchronously. Writes are serialized and coalesced — one
 * physical write at a time, re-flushing the latest in-memory state if another
 * `set()` landed meanwhile — so a slow write can never clobber a newer value
 * (last-writer-wins by in-memory state). Each physical write is
 * write-to-temp-then-rename (atomic on the same filesystem). A write failure
 * logs a warn and keeps the in-memory value; it never crashes (NFR-2).
 *
 * Load is tolerant: a missing file starts empty; a corrupt/invalid file logs a
 * warn and starts empty (losing a cosmetic map must never stop the fleet
 * server — the operator can re-set aliases).
 */

import {
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  rename as fsRename,
} from 'node:fs/promises';
import { z } from 'zod';
import { aliasSchema } from '../api/schemas.js';
import type { Logger } from '../core/logger.js';

/** The on-disk shape: a map of agentId -> validated alias. */
const aliasFileSchema = z.record(z.string(), aliasSchema);

export type ReadFileFn = (file: string) => Promise<string>;
export type WriteFileFn = (file: string, data: string) => Promise<void>;
export type RenameFn = (from: string, to: string) => Promise<void>;

export interface AliasStoreOptions {
  file: string;
  logger: Logger;
  /** injectable async fs (tests). */
  readFile?: ReadFileFn;
  writeFile?: WriteFileFn;
  rename?: RenameFn;
}

export class AliasStore {
  private readonly file: string;
  private readonly tempFile: string;
  private readonly logger: Logger;
  private readonly readFile: ReadFileFn;
  private readonly writeFile: WriteFileFn;
  private readonly rename: RenameFn;

  private readonly map = new Map<string, string>();

  /** The single in-flight write, if any; concurrent sets coalesce behind it. */
  private writing: Promise<void> | null = null;
  /** Set when a new value lands while a write is in flight. */
  private dirty = false;

  constructor(opts: AliasStoreOptions) {
    this.file = opts.file;
    this.tempFile = `${opts.file}.tmp`;
    this.logger = opts.logger;
    this.readFile = opts.readFile ?? ((f) => fsReadFile(f, 'utf8'));
    this.writeFile = opts.writeFile ?? ((f, d) => fsWriteFile(f, d, 'utf8'));
    this.rename = opts.rename ?? ((from, to) => fsRename(from, to));
  }

  /** Reads + validates the file into the in-memory map. Tolerant of all failure. */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await this.readFile(this.file);
    } catch {
      // Missing/unreadable file: start empty and continue.
      this.map.clear();
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.logger.warn('alias store file is not valid JSON; starting empty', {
        file: this.file,
        error: err instanceof Error ? err.message : String(err),
      });
      this.map.clear();
      return;
    }
    const result = aliasFileSchema.safeParse(parsed);
    if (!result.success) {
      this.logger.warn('alias store file failed validation; starting empty', {
        file: this.file,
        issues: result.error.issues.length,
      });
      this.map.clear();
      return;
    }
    this.map.clear();
    for (const [id, alias] of Object.entries(result.data)) {
      this.map.set(id, alias);
    }
  }

  /** The display alias for an agent id, or undefined if none is set. */
  get(agentId: string): string | undefined {
    return this.map.get(agentId);
  }

  /** A snapshot of every persisted alias (including pre-seeded, never-seen ids). */
  all(): Record<string, string> {
    return Object.fromEntries(this.map);
  }

  /**
   * Validates `alias`, updates the in-memory map synchronously, then persists.
   * An unknown agent id is accepted and persisted (pre-seeding, AC-40). Throws
   * a validation error (the route maps it to 400) WITHOUT touching the map or
   * disk when the alias is invalid. Resolves after the write settles, so a
   * resolved call means "persisted" (a write failure resolves too, having
   * logged a warn and kept the in-memory value).
   */
  async set(agentId: string, alias: string): Promise<void> {
    const parsed = aliasSchema.safeParse(alias);
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => i.message).join('; ') || 'invalid alias';
      throw new AliasValidationError(message);
    }
    // Source of truth updated synchronously (uses the trimmed value).
    this.map.set(agentId, parsed.data);
    await this.persist();
  }

  /**
   * Serialized/coalesced persistence. If a write is already in flight, mark
   * dirty and await it: the in-flight write re-flushes the LATEST in-memory map
   * on completion, so the file converges to the newest value regardless of
   * call ordering.
   */
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

  /** Writes the current map, re-writing while `dirty` was set during a write. */
  private async flushLoop(): Promise<void> {
    do {
      this.dirty = false;
      const payload = JSON.stringify(this.all(), null, 2);
      try {
        await this.writeFile(this.tempFile, payload);
        await this.rename(this.tempFile, this.file);
      } catch (err) {
        // Never crash: keep the in-memory value, log, and stop retrying this
        // round. A later set() or a restart's load() reconciles.
        this.logger.warn('failed to persist alias store; keeping in-memory value', {
          file: this.file,
          error: err instanceof Error ? err.message : String(err),
        });
        this.dirty = false;
        return;
      }
    } while (this.dirty);
  }
}

/** Thrown by {@link AliasStore.set} on an invalid alias; mapped to 400 VALIDATION. */
export class AliasValidationError extends Error {
  readonly code = 'VALIDATION';
  constructor(message: string) {
    super(message);
    this.name = 'AliasValidationError';
  }
}
