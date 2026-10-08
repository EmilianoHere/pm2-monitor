/**
 * CooldownTracker: per-(ruleId, processName) anti-spam gate. After a fire,
 * further matches for the same key are suppressed until `cooldownSec` elapses;
 * suppressed matches roll into a count surfaced on the next allowed alert
 * ("+N more since last alert").
 */

export interface CooldownDecision {
  /** whether this match may fire now. */
  allowed: boolean;
  /** matches suppressed since the last fire (0 when `allowed` is a first fire). */
  suppressedCount: number;
}

interface CooldownEntry {
  lastFired: number;
  suppressed: number;
}

export interface CooldownTrackerOptions {
  /** injectable clock returning epoch ms. */
  now?: () => number;
}

export class CooldownTracker {
  private readonly now: () => number;
  private readonly entries = new Map<string, CooldownEntry>();

  constructor(options: CooldownTrackerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  private static key(ruleId: string, processName: string): string {
    return `${ruleId}\u0000${processName}`;
  }

  /**
   * Decides whether a match for `(ruleId, processName)` may fire given
   * `cooldownSec`. A permitted fire records the fire time and returns the
   * number of matches suppressed since the previous fire; a suppressed match
   * increments that running count and returns `allowed: false`.
   */
  allow(ruleId: string, processName: string, cooldownSec: number): CooldownDecision {
    const key = CooldownTracker.key(ruleId, processName);
    const now = this.now();
    const entry = this.entries.get(key);

    if (!entry) {
      this.entries.set(key, { lastFired: now, suppressed: 0 });
      return { allowed: true, suppressedCount: 0 };
    }

    const elapsedSec = (now - entry.lastFired) / 1000;
    if (elapsedSec >= cooldownSec) {
      const suppressedCount = entry.suppressed;
      entry.lastFired = now;
      entry.suppressed = 0;
      return { allowed: true, suppressedCount };
    }

    entry.suppressed += 1;
    return { allowed: false, suppressedCount: entry.suppressed };
  }

  /** Clears all cooldown state (e.g. on reload). */
  reset(): void {
    this.entries.clear();
  }
}
