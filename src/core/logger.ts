/**
 * Structured JSON logger.
 *
 * - Levels: debug < info < warn < error, gated by LOG_LEVEL.
 * - Child loggers carry a bound context object merged into every record.
 * - A redaction set replaces known secret keys with `***` anywhere they appear
 *   in a logged context object: `redactContext` recurses into nested plain
 *   objects to FULL DEPTH (no depth bound), so a secret key or a `token=` URL is
 *   redacted at any nesting level. The one edge is arrays — `redactContext` does
 *   not recurse into them, so a token-bearing object placed inside an array
 *   element is NOT key-redacted; log contexts must never array-wrap a secret.
 * - `redactUrl` rewrites `token=...` query values to `token=***` so credentials
 *   carried in a URL never reach the logs.
 * - `warnOnce` / `throttle` rate-limit noisy repeated warnings.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** Secret keys whose values are replaced with `***` when logged. */
export const REDACTED_KEYS: ReadonlySet<string> = new Set([
  'API_KEY',
  'BASIC_PASS',
  'SMTP_PASS',
  'TEAMS_WEBHOOK_URL',
  'AGENT_TOKEN',
  'AGENT_TOKENS',
  'SERVER_URL',
  'rawKey',
  'hash',
  'apiKey',
]);

const REDACTED = '***';

/** Rewrites any `token=<value>` in a URL/query string to `token=***`. */
export function redactUrl(url: string): string {
  if (typeof url !== 'string') return url;
  return url.replace(/([?&]token=)[^&#\s]*/gi, `$1${REDACTED}`);
}

type LogContext = Record<string, unknown>;

function redactValue(key: string, value: unknown): unknown {
  if (REDACTED_KEYS.has(key)) return REDACTED;
  if (typeof value === 'string' && /[?&]token=/i.test(value)) {
    return redactUrl(value);
  }
  return value;
}

function redactContext(ctx: LogContext): LogContext {
  const out: LogContext = {};
  for (const [key, value] of Object.entries(ctx)) {
    if (REDACTED_KEYS.has(key)) {
      out[key] = REDACTED;
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = redactContext(value as LogContext);
    } else {
      out[key] = redactValue(key, value);
    }
  }
  return out;
}

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  child(context: LogContext): Logger;
  /**
   * Re-levels the whole logger tree in place: the next emit on this logger and
   * every child created from the same `createLogger` call honors `level`.
   */
  setLevel(level: LogLevel): void;
  /** Emits a warn at most once per `key` within `windowMs` (default 60s). */
  warnOnce(key: string, message: string, context?: LogContext): void;
  /** Returns true if an action keyed by `key` is allowed to run now (throttle). */
  throttle(key: string, windowMs?: number): boolean;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Sink for emitting a finished record line. Defaults to process.stdout. */
  sink?: (line: string) => void;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

const DEFAULT_WINDOW_MS = 60_000;

export function createLogger(options: LoggerOptions = {}): Logger {
  const level: LogLevel = options.level ?? 'info';
  // Mutable and captured by build() so a single setLevel re-levels every child.
  let threshold = LEVEL_ORDER[level];
  const now = options.now ?? (() => Date.now());
  const sink =
    options.sink ??
    ((line: string) => {
      process.stdout.write(line + '\n');
    });
  // Shared across child loggers so a repeated warn is throttled globally by key.
  const throttleState = new Map<string, number>();

  function emit(recordLevel: LogLevel, bound: LogContext, message: string, context?: LogContext): void {
    if (LEVEL_ORDER[recordLevel] < threshold) return;
    const merged: LogContext = { ...bound, ...(context ?? {}) };
    const record = {
      ts: new Date(now()).toISOString(),
      level: recordLevel,
      msg: message,
      ...redactContext(merged),
    };
    sink(JSON.stringify(record));
  }

  function build(bound: LogContext): Logger {
    const logger: Logger = {
      debug: (message, context) => emit('debug', bound, message, context),
      info: (message, context) => emit('info', bound, message, context),
      warn: (message, context) => emit('warn', bound, message, context),
      error: (message, context) => emit('error', bound, message, context),
      child: (context) => build({ ...bound, ...context }),
      setLevel: (next) => {
        threshold = LEVEL_ORDER[next];
      },
      throttle: (key, windowMs = DEFAULT_WINDOW_MS) => {
        const last = throttleState.get(key);
        const current = now();
        if (last !== undefined && current - last < windowMs) return false;
        throttleState.set(key, current);
        return true;
      },
      warnOnce: (key, message, context) => {
        if (logger.throttle(key)) {
          emit('warn', bound, message, context);
        }
      },
    };
    return logger;
  }

  return build({});
}
