// Pure, unit-testable client-side computation over the existing ProcessSnapshot
// / AgentListRow shapes — no backend change. Classification keys off `restarts`
// (the cumulative count an operator reasons about); `unstableRestarts` is used
// only as a secondary crash signal. Every classification/aggregate helper takes
// an optional explicit `threshold` arg so tests can inject a value.

/** Default restart threshold above which an online process is "inestable". */
export const DEFAULT_UNSTABLE_THRESHOLD = 10;

/**
 * The active unstable threshold: a positive finite override from localStorage,
 * else the default. Read fresh on every render so a changed value takes effect
 * on the next render.
 * @returns {number}
 */
export function unstableThreshold() {
  const raw = Number(localStorage.getItem('pm2monitor.unstableThreshold'));
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_UNSTABLE_THRESHOLD;
}

/**
 * Classify a process into one of 'crashed' | 'unstable' | 'healthy' | 'stopped'
 * in that precedence.
 * @param {object} p ProcessSnapshot
 * @param {number} [threshold]
 * @returns {'crashed'|'unstable'|'healthy'|'stopped'}
 */
export function classifyProcess(p, threshold = unstableThreshold()) {
  const online = p.status === 'online';
  const crashed =
    p.status === 'errored' ||
    (p.status === 'stopped' && (p.unstableRestarts > 0 || p.restarts >= threshold));
  const unstable = online && p.restarts >= threshold;
  if (crashed) return 'crashed'; // detenido tras crash loop
  if (unstable) return 'unstable'; // online · inestable
  if (online) return 'healthy'; // sano
  return 'stopped'; // detenido (clean stop)
}

/**
 * Whether a process needs operator attention (crashed or unstable).
 * @param {object} p
 * @param {number} [t]
 * @returns {boolean}
 */
export function needsAttention(p, t) {
  const c = classifyProcess(p, t);
  return c === 'crashed' || c === 'unstable';
}

/**
 * Per-category attention counts over a process set (one scope, or one agent).
 * @param {object[]} procs
 * @param {number} [t]
 * @returns {{crashed:number, unstable:number, total:number}}
 */
export function attentionCounts(procs, t = unstableThreshold()) {
  let crashed = 0;
  let unstable = 0;
  for (const p of procs) {
    const c = classifyProcess(p, t);
    if (c === 'crashed') crashed += 1;
    else if (c === 'unstable') unstable += 1;
  }
  return { crashed, unstable, total: crashed + unstable };
}

/**
 * Short reason summary string; zero parts omitted, parts joined by ' · '.
 * crashed uses "detenido(s) tras crash loop"; unstable uses "inestable(s)".
 * @param {{crashed:number, unstable:number}} counts
 * @returns {string}
 */
export function attentionSummary({ crashed, unstable }) {
  const parts = [];
  if (crashed > 0) {
    parts.push(`${crashed} ${crashed === 1 ? 'detenido' : 'detenidos'} tras crash loop`);
  }
  if (unstable > 0) {
    parts.push(`${unstable} inestable${unstable === 1 ? '' : 's'}`);
  }
  return parts.join(' · ');
}

/** Closed exact-name allowlist for the "Sistema PM2" group. */
const PM2_SYSTEM = new Set(['pm2-logrotate', 'pm2-monitor', 'pm2-agent']);

/**
 * Project group for a process name: the three PM2 system literals map to
 * "Sistema PM2" (matched first); otherwise the substring after the last `-`
 * (trailing hyphens normalized first), falling back to the full name when there
 * is no interior hyphen.
 * @param {string} name
 * @returns {string}
 */
export function projectOf(name) {
  if (PM2_SYSTEM.has(name)) return 'Sistema PM2';
  const base = name.replace(/-+$/, '');
  const idx = base.lastIndexOf('-');
  if (idx === -1) return base;
  return base.slice(idx + 1);
}

/**
 * Scope-wide aggregates over the full loaded process set.
 * @param {object[]} procs
 * @returns {{total:number, online:number, stopped:number, memBytes:number, cpuPct:number}}
 */
export function summaryAggregates(procs) {
  return {
    total: procs.length,
    online: procs.filter((p) => p.status === 'online').length,
    stopped: procs.filter((p) => p.status !== 'online').length,
    memBytes: procs.reduce((s, p) => s + (p.memory || 0), 0),
    cpuPct: procs.reduce((s, p) => s + (p.cpu || 0), 0),
  };
}

/**
 * Per-agent health breakdown. `detenido` merges crashed + clean-stopped for the
 * health bar; `problems` counts inestable + crashed.
 * @param {object[]} procs
 * @param {number} [t]
 * @returns {{sano:number, inestable:number, detenido:number, memBytes:number, cpuPct:number, problems:number}}
 */
export function agentHealth(procs, t = unstableThreshold()) {
  let sano = 0;
  let inestable = 0;
  let detenido = 0;
  let crashed = 0;
  for (const p of procs) {
    const c = classifyProcess(p, t);
    if (c === 'healthy') sano += 1;
    else if (c === 'unstable') inestable += 1;
    else detenido += 1; // crashed + stopped
    if (c === 'crashed') crashed += 1;
  }
  return {
    sano,
    inestable,
    detenido,
    memBytes: procs.reduce((s, p) => s + (p.memory || 0), 0),
    cpuPct: procs.reduce((s, p) => s + (p.cpu || 0), 0),
    problems: inestable + crashed,
  };
}
