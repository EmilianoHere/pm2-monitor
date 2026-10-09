/**
 * Agent identity: a stable id derived from the sanitized hostname plus a random
 * suffix persisted to disk (AGENT_ID_FILE). The id is stable per machine across
 * restarts because only the random suffix is persisted and the hostname is
 * stable; the suffix file is the agent's only persisted datum (NFR-6).
 *
 * Degraded, non-fatal behavior: if the file is missing/unreadable/empty a fresh
 * suffix is generated and written best-effort; if the directory is unwritable
 * the agent still derives and uses an in-memory id for this run and logs a warn
 * (it regenerates next boot) rather than crashing.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Logger } from '../core/logger.js';

export interface ResolveAgentIdOptions {
  /** AGENT_ID_FILE: path the random suffix is persisted to. */
  idFile: string;
  /** host name feeding the id prefix (sanitized to the safe charset). */
  hostname: string;
  logger: Logger;
  /** injectable file read (tests); returns the suffix file contents. */
  readFile?: (p: string) => string;
  /** injectable file write (tests); must mkdir -p the parent dir. */
  writeFile?: (p: string, data: string) => void;
  /** injectable suffix generator (tests). */
  randomSuffix?: () => string;
}

/**
 * Sanitizes a value to the processNameSchema-safe charset
 * (`[A-Za-z0-9._-]`), collapsing every disallowed run to a single `-`, so the
 * resulting id is wire- and log-safe. An empty result falls back to `agent`.
 */
function sanitize(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'agent';
}

function defaultReadFile(p: string): string {
  return readFileSync(p, 'utf8');
}

function defaultWriteFile(p: string, data: string): void {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, data, 'utf8');
}

function defaultRandomSuffix(): string {
  return randomBytes(4).toString('hex');
}

/**
 * Resolves the stable agent id. Reads the suffix from {@link ResolveAgentIdOptions.idFile};
 * on a missing/unreadable/empty file a new suffix is generated, persisted
 * best-effort, and an info is logged. The returned id is
 * `${sanitize(hostname)}-${suffix}`.
 */
export function resolveAgentId(opts: ResolveAgentIdOptions): string {
  const readFile = opts.readFile ?? defaultReadFile;
  const writeFile = opts.writeFile ?? defaultWriteFile;
  const randomSuffix = opts.randomSuffix ?? defaultRandomSuffix;
  const prefix = sanitize(opts.hostname);

  let suffix = '';
  try {
    suffix = readFile(opts.idFile).trim();
  } catch {
    suffix = '';
  }

  if (suffix.length > 0) {
    return `${prefix}-${suffix}`;
  }

  // Missing/unreadable/empty: generate, persist best-effort, log.
  suffix = randomSuffix();
  try {
    writeFile(opts.idFile, suffix);
    opts.logger.info('generated agent id suffix', { idFile: opts.idFile });
  } catch (err) {
    // Unwritable dir: use the in-memory id this run (regenerates next boot).
    opts.logger.warn('could not persist agent id suffix; using in-memory id', {
      idFile: opts.idFile,
      err: err instanceof Error ? err.message : String(err),
    });
  }
  return `${prefix}-${suffix}`;
}
