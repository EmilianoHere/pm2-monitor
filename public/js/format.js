// Humanization helpers shared across the redesigned front-end. `fmtBytes` and
// `fmtUptime` are moved VERBATIM from views/overview.js so the new components
// (processes.js, detailPanel.js, agents.js) import them without depending on a
// deleted file. `fmtBytesTotal` is a NEW dedicated two-decimal formatter for the
// PROCESOS "Memoria total" summary card; `fmtRelativeAge` humanizes the Fleet
// "Último heartbeat" age.

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/**
 * Per-row memory formatter (one decimal for non-byte units). Moved verbatim
 * from overview.js: e.g. fmtBytes(1_084_000_000) === '1.0 GB'.
 * @param {number} bytes
 * @returns {string}
 */
export function fmtBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Dedicated two-decimal formatter for the PROCESOS "Memoria total" summary card.
 * Same unit ladder as fmtBytes, two decimals for non-byte units:
 * e.g. fmtBytesTotal(1_084_000_000) === '1.01 GB'.
 * @param {number} bytes
 * @returns {string}
 */
export function fmtBytesTotal(bytes) {
  let v = bytes || 0;
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 2)} ${UNITS[i]}`;
}

/**
 * Uptime formatter. Moved verbatim from overview.js; guards null/undefined/<0.
 * @param {number|null|undefined} ms
 * @returns {string}
 */
export function fmtUptime(ms) {
  if (ms === null || ms === undefined || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/**
 * Relative age for the Fleet "Último heartbeat": 'hace 2 s' / 'hace 3 min' /
 * 'hace 1 h'. Recomputed each Fleet refresh tick so the age advances.
 * @param {number|null|undefined} epochMs
 * @returns {string}
 */
export function fmtRelativeAge(epochMs) {
  if (epochMs === null || epochMs === undefined) return '—';
  const diff = Date.now() - epochMs;
  if (!Number.isFinite(diff) || diff < 0) return '—';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `hace ${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  return `hace ${h} h`;
}
