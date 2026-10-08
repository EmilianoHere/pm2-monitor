/**
 * EmailChannel: a Nodemailer-backed channel. The transport is built once from
 * SMTP config and `verify()`-ed at startup; a failed verify disables the channel
 * with a warning rather than aborting boot. `send` delivers a single-process
 * alert as HTML+text; `sendRaw` delivers the multi-process daily digest.
 *
 * The HTML/text builders for an {@link AlertPayload} are pure, exported
 * functions so they are unit-testable without a transport.
 */

import nodemailer from 'nodemailer';
import { createLogger, type Logger } from '../../core/logger.js';
import type { AlertPayload, EmailChannel as EmailChannelType, RawMessage } from './types.js';

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  /** comma-separated recipient list (raw MAIL_TO). */
  to: string;
}

/** Minimal transport surface used here; satisfied by a Nodemailer transport. */
export interface MailTransport {
  verify(): Promise<unknown>;
  sendMail(message: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html: string;
  }): Promise<unknown>;
}

export interface EmailChannelOptions {
  /** SMTP config; when absent the channel is disabled (logged once). */
  smtp?: SmtpConfig;
  logger?: Logger;
  /** injectable transport factory (tests); defaults to Nodemailer. */
  createTransport?: (smtp: SmtpConfig) => MailTransport;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Pure: the plaintext body for a single-process alert. */
export function buildAlertText(payload: AlertPayload): string {
  const lines: string[] = [
    payload.title,
    '',
    `Process: ${payload.processName}`,
    `Rule: ${payload.ruleId}`,
    `Severity: ${payload.severity}`,
    `Time: ${new Date(payload.timestamp).toISOString()}`,
    '',
    payload.summary,
  ];
  for (const f of payload.facts) {
    lines.push(`${f.k}: ${f.v}`);
  }
  if (payload.suppressedCount > 0) {
    lines.push('', `+${payload.suppressedCount} more since last alert`);
  }
  return lines.join('\n');
}

/** Pure: the HTML body for a single-process alert. */
export function buildAlertHtml(payload: AlertPayload): string {
  const rows = [
    { k: 'Process', v: payload.processName },
    { k: 'Rule', v: payload.ruleId },
    { k: 'Severity', v: payload.severity },
    { k: 'Time', v: new Date(payload.timestamp).toISOString() },
    ...payload.facts,
  ]
    .map((f) => `<tr><td><strong>${escapeHtml(f.k)}</strong></td><td>${escapeHtml(f.v)}</td></tr>`)
    .join('');
  const suppressed =
    payload.suppressedCount > 0
      ? `<p>+${payload.suppressedCount} more since last alert</p>`
      : '';
  return [
    `<h2>${escapeHtml(payload.title)}</h2>`,
    `<p>${escapeHtml(payload.summary)}</p>`,
    `<table>${rows}</table>`,
    suppressed,
  ].join('');
}

export class EmailChannel implements EmailChannelType {
  readonly name = 'email' as const;
  private enabledFlag: boolean;

  private readonly smtp: SmtpConfig | undefined;
  private readonly logger: Logger;
  private readonly transport: MailTransport | null;

  constructor(options: EmailChannelOptions = {}) {
    this.smtp = options.smtp;
    this.logger = options.logger ?? createLogger();
    this.enabledFlag = this.smtp !== undefined;
    if (!this.enabledFlag || this.smtp === undefined) {
      this.transport = null;
      this.logger.warnOnce('email-disabled', 'Email channel disabled: SMTP config not set');
      return;
    }
    const factory =
      options.createTransport ??
      ((smtp: SmtpConfig): MailTransport =>
        nodemailer.createTransport({
          host: smtp.host,
          port: smtp.port,
          secure: smtp.secure,
          auth: { user: smtp.user, pass: smtp.pass },
        }) as unknown as MailTransport);
    this.transport = factory(this.smtp);
  }

  get enabled(): boolean {
    return this.enabledFlag;
  }

  /**
   * Verifies the SMTP transport. A failed verify disables the channel with a
   * logged warning and never throws, so boot continues.
   */
  async verify(): Promise<void> {
    if (!this.enabledFlag || this.transport === null) return;
    try {
      await this.transport.verify();
    } catch (err) {
      this.enabledFlag = false;
      this.logger.warn('Email channel disabled: SMTP verify failed', { error: errText(err) });
    }
  }

  /** Sends a single-process alert as HTML+text. Rejects on SMTP failure. */
  async send(payload: AlertPayload): Promise<void> {
    if (!this.enabledFlag || this.transport === null || this.smtp === undefined) {
      throw new Error('Email channel is not enabled');
    }
    await this.transport.sendMail({
      from: this.smtp.from,
      to: this.smtp.to,
      subject: `[${payload.severity}] ${payload.title}`,
      text: buildAlertText(payload),
      html: buildAlertHtml(payload),
    });
  }

  /** Sends a raw multi-recipient message (used by the digest). Rejects on failure. */
  async sendRaw(msg: RawMessage): Promise<void> {
    if (!this.enabledFlag || this.transport === null || this.smtp === undefined) {
      throw new Error('Email channel is not enabled');
    }
    await this.transport.sendMail({
      from: this.smtp.from,
      to: this.smtp.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
    });
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
