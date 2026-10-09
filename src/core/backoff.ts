/**
 * Shared exponential-backoff delay helper. Extracted from Pm2Client so both the
 * local PM2 reconnect loop and the agent's outbound WS reconnect loop use the
 * exact same algorithm/constants: base 1s, cap 30s, +/-20% jitter.
 *
 * The RNG is injected (defaulting to Math.random) purely so jitter bounds are
 * deterministically testable; callers that pass the default observe unchanged
 * runtime behavior.
 */

const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30_000;

/**
 * Exponential backoff 1s,2s,4s,… capped at 30s with +/-20% jitter.
 *
 * @param attempt zero-based attempt counter (0 -> base, 1 -> 2*base, …).
 * @param rand injectable RNG in [0,1); defaults to Math.random. `rand()` of 0
 *   lands the delay at base*0.8, 1 at base*1.2, and 0.5 exactly at base.
 */
export function backoffDelay(attempt: number, rand: () => number = Math.random): number {
  const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
  const jitter = base * 0.2 * (rand() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

export { BACKOFF_BASE_MS, BACKOFF_CAP_MS };
