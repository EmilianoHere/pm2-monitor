/**
 * Pure error-signature computation for deduplication.
 *
 * Groups "same error, different timestamp/pid/line-column" into one signature
 * while keeping distinct errors separate.
 */

import { createHash } from 'node:crypto';
import { basename } from 'node:path';

const STACK_FRAME_RE = /at .+ \(?(.+):\d+:\d+\)?/;
const LINE_COL_RE = /:\d+:\d+/g;
const LONG_HEX_RE = /\b[0-9a-f]{8,}\b/gi;
const NUMBER_RUN_RE = /\d{3,}/g;
const WHITESPACE_RE = /\s+/g;

/** Replaces absolute path prefixes with their basename inside a frame line. */
function pathsToBasenames(text: string): string {
  // Replace path-like tokens (containing a separator) with their basename.
  return text.replace(/(?:[A-Za-z]:)?[\w./\\-]*[/\\][\w./\\-]+/g, (match) => {
    // Keep the trailing :line:col if present on the same token.
    const colonSplit = match.match(/^(.*?)(:\d+:\d+)?$/);
    if (!colonSplit) return basename(match);
    const [, pathPart, lineCol = ''] = colonSplit;
    return basename(pathPart) + lineCol;
  });
}

/**
 * Computes a stable dedup signature for an error.
 *
 * @param processName the owning pm2 process name (prepended before hashing)
 * @param text the error text (stderr line group or err/stack field)
 */
export function signature(processName: string, text: string): string {
  const source = (text ?? '').toString();

  // 1-2. Extract the first stack frame, or fall back to the first non-empty line.
  let core = '';
  const frameMatch = source.match(STACK_FRAME_RE);
  if (frameMatch) {
    core = frameMatch[0];
  } else {
    core = source
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? '';
  }

  // 3. Normalize.
  let normalized = pathsToBasenames(core);
  normalized = normalized.replace(LINE_COL_RE, ':*');
  normalized = normalized.replace(LONG_HEX_RE, '#');
  normalized = normalized.replace(NUMBER_RUN_RE, '#');
  normalized = normalized.replace(WHITESPACE_RE, ' ').trim().toLowerCase();

  // 4. Prepend the process name.
  const material = `${processName}\n${normalized}`;

  // 5. sha1, first 16 hex chars.
  return createHash('sha1').update(material).digest('hex').slice(0, 16);
}
