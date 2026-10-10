import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EmailChannel, type MailTransport, type SmtpConfig } from './email.js';
import { createLogger } from '../../core/logger.js';

const silent = createLogger({ level: 'error', sink: () => {} });

function smtp(partial: Partial<SmtpConfig> = {}): SmtpConfig {
  return {
    host: 'mail.example',
    port: 587,
    secure: false,
    user: 'u',
    pass: 'p',
    from: 'from@example',
    to: 'to@example',
    ...partial,
  };
}

/** A fake transport whose verify resolves; records how many were built. */
function fakeFactory() {
  const built: SmtpConfig[] = [];
  const factory = (cfg: SmtpConfig): MailTransport => {
    built.push(cfg);
    return {
      async verify() {
        return true;
      },
      async sendMail() {
        return {};
      },
    };
  };
  return { factory, built };
}

test('reconfigure with full SMTP enables the channel via the injected factory', () => {
  const { factory, built } = fakeFactory();
  const channel = new EmailChannel({ logger: silent, createTransport: factory });
  assert.equal(channel.enabled, false);
  assert.equal(built.length, 0, 'no transport built while disabled');

  channel.reconfigure(smtp());
  assert.equal(channel.enabled, true);
  assert.equal(built.length, 1, 'rebuilt through the injected factory');
});

test('reconfigure with incomplete SMTP disables without throwing and without opening a socket', () => {
  const { factory, built } = fakeFactory();
  const channel = new EmailChannel({ logger: silent, smtp: smtp(), createTransport: factory });
  assert.equal(channel.enabled, true);
  assert.equal(built.length, 1);

  // Incomplete SMTP -> undefined group -> disable, no new transport built.
  assert.doesNotThrow(() => channel.reconfigure(undefined));
  assert.equal(channel.enabled, false);
  assert.equal(built.length, 1, 'no socket opened on disable');
});
