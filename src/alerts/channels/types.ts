/**
 * Alert channel contract and the single-process {@link AlertPayload} every
 * channel delivers. The daily digest is a multi-process report that does not
 * fit {@link AlertPayload}, so {@link EmailChannel} additionally exposes
 * {@link EmailChannel.sendRaw}.
 */

export type AlertSeverity = 'info' | 'warning' | 'critical';

/** One single-process alert as delivered to a channel. */
export interface AlertPayload {
  title: string;
  severity: AlertSeverity;
  processName: string;
  ruleId: string;
  summary: string;
  facts: Array<{ k: string; v: string }>;
  /** epoch ms */
  timestamp: number;
  /** matches suppressed since the last delivered alert for this (rule, process) */
  suppressedCount: number;
  /**
   * Originating agent id (server mode only). Absent in standalone, where the
   * identity resolver leaves it undefined so payloads stay byte-identical.
   */
  agentId?: string;
  /** Originating agent's cosmetic alias (server mode only); absent in standalone. */
  agentAlias?: string;
}

/**
 * A delivery channel. `send` rejects on a delivery failure so the engine's
 * `Promise.allSettled` dispatch can log the failure without crashing or
 * blocking the other channel.
 */
export interface AlertChannel {
  readonly name: 'teams' | 'email';
  readonly enabled: boolean;
  send(payload: AlertPayload): Promise<void>;
}

/** A raw multi-recipient message used by the daily digest (email-only). */
export interface RawMessage {
  subject: string;
  html: string;
  text: string;
}

/**
 * The email channel adds `sendRaw` for the daily digest, which is a
 * multi-process report that builds no single-process {@link AlertPayload}.
 */
export interface EmailChannel extends AlertChannel {
  readonly name: 'email';
  sendRaw(msg: RawMessage): Promise<void>;
}
