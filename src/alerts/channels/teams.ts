/**
 * TeamsChannel: builds a MessageCard and POSTs it to an incoming-webhook URL
 * via the Node 20 global `fetch` (no HTTP-client dependency). The MessageCard
 * builder is a pure, exported function so it is unit-testable with no network.
 */

import { createLogger, type Logger } from '../../core/logger.js';
import type { AlertChannel, AlertPayload, AlertSeverity } from './types.js';

/** Hex theme colors (no leading '#') per severity. */
const THEME_COLOR: Record<AlertSeverity, string> = {
  info: '2EB886', // green
  warning: 'E3B341', // amber
  critical: 'D23F31', // red
};

/** The MessageCard shape posted to the Teams webhook. */
export interface TeamsMessageCard {
  '@type': 'MessageCard';
  '@context': 'http://schema.org/extensions';
  themeColor: string;
  summary: string;
  title: string;
  sections: Array<{
    activityTitle: string;
    activitySubtitle: string;
    facts: Array<{ name: string; value: string }>;
    text: string;
  }>;
}

/**
 * Builds the MessageCard JSON for an alert. Pure: no I/O, deterministic given
 * the payload. The themeColor is chosen by severity, the facts section mirrors
 * the payload facts, and the process name + ISO timestamp are included.
 */
export function buildTeamsCard(payload: AlertPayload): TeamsMessageCard {
  const iso = new Date(payload.timestamp).toISOString();
  const facts: Array<{ name: string; value: string }> = [
    { name: 'Process', value: payload.processName },
    { name: 'Rule', value: payload.ruleId },
    { name: 'Severity', value: payload.severity },
    { name: 'Time', value: iso },
    ...payload.facts.map((f) => ({ name: f.k, value: f.v })),
  ];
  if (payload.suppressedCount > 0) {
    facts.push({ name: 'Suppressed', value: `+${payload.suppressedCount} more since last alert` });
  }
  return {
    '@type': 'MessageCard',
    '@context': 'http://schema.org/extensions',
    themeColor: THEME_COLOR[payload.severity],
    summary: payload.title,
    title: payload.title,
    sections: [
      {
        activityTitle: payload.processName,
        activitySubtitle: iso,
        facts,
        text: payload.summary,
      },
    ],
  };
}

export interface TeamsChannelOptions {
  /** TEAMS_WEBHOOK_URL; when absent the channel is disabled (logged once). */
  webhookUrl?: string;
  logger?: Logger;
  /** injectable fetch (tests); defaults to the global fetch. */
  fetchFn?: typeof fetch;
  /** request timeout in ms (default 10s). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class TeamsChannel implements AlertChannel {
  readonly name = 'teams' as const;
  enabled: boolean;

  private webhookUrl: string | undefined;
  private readonly logger: Logger;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: TeamsChannelOptions = {}) {
    this.webhookUrl = options.webhookUrl;
    this.logger = options.logger ?? createLogger();
    this.fetchFn = options.fetchFn ?? ((...args) => fetch(...args));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.enabled = typeof this.webhookUrl === 'string' && this.webhookUrl.length > 0;
    if (!this.enabled) {
      this.logger.warnOnce('teams-disabled', 'Teams channel disabled: TEAMS_WEBHOOK_URL not set');
    }
  }

  /**
   * Live-applies a new webhook URL: updates the target and recomputes `enabled`.
   * The `send` path reads both per call, so no further wiring is needed.
   */
  reconfigure(webhookUrl?: string): void {
    this.webhookUrl = webhookUrl;
    this.enabled = typeof webhookUrl === 'string' && webhookUrl.length > 0;
  }

  /** POSTs the MessageCard; a non-2xx, network error, or timeout rejects. */
  async send(payload: AlertPayload): Promise<void> {
    if (!this.enabled || this.webhookUrl === undefined) {
      throw new Error('Teams channel is not enabled');
    }
    const card = buildTeamsCard(payload);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(card),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`Teams webhook returned HTTP ${res.status}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
