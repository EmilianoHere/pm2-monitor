/**
 * Correlation-id generation and a pending-request map shared by both ends for
 * request/response routing (control commands). Timers and clock are injected
 * following the Pm2Client/WsHub test pattern so timeouts are deterministic.
 */

export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/** Generates a correlation id: `${now}-${base36 rand}`. */
export function newCid(now: () => number, rand: () => number): string {
  const suffix = Math.floor(rand() * 0xffffffff).toString(36);
  return `${now()}-${suffix}`;
}

export interface PendingRequestsOptions<T> {
  /** per-request timeout; the waiter resolves with {@link onTimeout} value. */
  timeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  now?: () => number;
  /** builds the value a timed-out waiter resolves with (e.g. AGENT_TIMEOUT). */
  onTimeout: (cid: string) => T;
}

interface Waiter<T> {
  resolve: (value: T) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * A map of correlation id -> pending Promise. `create` arms a timeout that
 * resolves the waiter with `onTimeout(cid)` so a request never hangs. `settle`
 * resolves exactly one pending+unsettled cid (returns false otherwise, so
 * unknown/duplicate/already-settled responses are ignored). `rejectAll` settles
 * every outstanding waiter — used on disconnect.
 */
export class PendingRequests<T> {
  private readonly timeoutMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
  private readonly onTimeout: (cid: string) => T;
  private readonly waiters = new Map<string, Waiter<T>>();

  constructor(opts: PendingRequestsOptions<T>) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h));
    this.onTimeout = opts.onTimeout;
  }

  /** Registers a waiter for `cid` and arms its timeout. */
  create(cid: string): Promise<T> {
    return new Promise<T>((resolve) => {
      const timer = this.setTimer(() => {
        // Timeout fired: drop the waiter and resolve with the timeout value.
        if (this.waiters.delete(cid)) {
          resolve(this.onTimeout(cid));
        }
      }, this.timeoutMs);
      this.waiters.set(cid, { resolve, timer });
    });
  }

  /**
   * Resolves the pending waiter for `cid` with `value`. Returns true if a
   * pending unsettled waiter was found; false for unknown/duplicate/settled.
   */
  settle(cid: string, value: T): boolean {
    const waiter = this.waiters.get(cid);
    if (!waiter) return false;
    this.waiters.delete(cid);
    this.clearTimer(waiter.timer);
    waiter.resolve(value);
    return true;
  }

  /** Settles every outstanding waiter with `reason` (e.g. on disconnect). */
  rejectAll(reason: T): void {
    for (const [, waiter] of this.waiters) {
      this.clearTimer(waiter.timer);
      waiter.resolve(reason);
    }
    this.waiters.clear();
  }

  /** Number of outstanding waiters (test/introspection aid). */
  get size(): number {
    return this.waiters.size;
  }
}
