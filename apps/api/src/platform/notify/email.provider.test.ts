import { createTransport } from 'nodemailer';
import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_SMTP_TIMEOUTS_MS,
  EMAIL_PROVIDER,
  EmailSendError,
  SmtpEmailProvider,
  redactError,
} from './email.provider';
import { STALE_CLAIM_MIN } from './outbox.drainer';

const config = {
  SMTP_URL: 'smtp://mailer:s3cret-pw@smtp.example.com:587',
  MAIL_FROM: 'Business OS <noreply@bos.example.com>',
};

describe('SmtpEmailProvider', () => {
  it('sends from MAIL_FROM to the recipient and returns the message id', async () => {
    // jsonTransport builds the whole message but sends nothing; the message id comes from nodemailer itself.
    const transport = createTransport({ jsonTransport: true });
    const spy = vi.spyOn(transport, 'sendMail');
    const provider = new SmtpEmailProvider(config, transport);

    const result = await provider.send({
      to: 'sita@example.com',
      subject: 'Approval needed',
      text: 'plain body',
      html: '<p>html body</p>',
    });

    expect(result.providerMessageId).toMatch(/^<.+@.+>$/);
    const sent = spy.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent).toMatchObject({
      from: config.MAIL_FROM,
      to: 'sita@example.com',
      subject: 'Approval needed',
      text: 'plain body',
      html: '<p>html body</p>',
    });
    const info = (await spy.mock.results[0]!.value) as { message: string };
    const message = JSON.parse(info.message) as Record<string, unknown>;
    expect(message.from).toMatchObject({ address: 'noreply@bos.example.com' });
    expect(message.to).toMatchObject([{ address: 'sita@example.com' }]);
  });

  it('omits html when the caller gives none', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: '<abc@bos>' });
    const provider = new SmtpEmailProvider(config, { sendMail });
    const result = await provider.send({ to: 'a@example.com', subject: 's', text: 't' });
    expect(result).toEqual({ providerMessageId: '<abc@bos>' });
    expect(sendMail.mock.calls[0]![0]).not.toHaveProperty('html');
  });

  it('builds its own transport from SMTP_URL when none is injected', () => {
    expect(() => new SmtpEmailProvider(config)).not.toThrow();
  });

  it('throws an error with the credentials stripped and the original attached to nothing', async () => {
    const failure = new Error(
      'connect ECONNREFUSED while using smtp://mailer:s3cret-pw@smtp.example.com:587',
    );
    const sendMail = vi.fn().mockRejectedValue(failure);
    const provider = new SmtpEmailProvider(config, { sendMail });

    const caught: unknown = await provider
      .send({ to: 'a@example.com', subject: 's', text: 't' })
      .catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(EmailSendError);
    const error = caught as EmailSendError;
    expect(error.message).toContain('ECONNREFUSED');
    expect(error.message).not.toContain('s3cret-pw');
    expect(error.message).not.toContain('mailer:');
    expect(error.cause).toBeUndefined();
  });

  it('exports the injection token', () => {
    expect(typeof EMAIL_PROVIDER).toBe('symbol');
  });
});

describe('SMTP timeouts', () => {
  /** nodemailer keeps the options it built the SMTP transport with on `transporter.options`. */
  const optionsOf = (provider: SmtpEmailProvider) =>
    (provider as unknown as { transport: { transporter: { options: Record<string, unknown> } } })
      .transport.transporter.options;

  it('gives the built transport a connection, greeting and socket timeout by default', () => {
    const options = optionsOf(new SmtpEmailProvider(config));
    expect(options).toMatchObject({
      connectionTimeout: DEFAULT_SMTP_TIMEOUTS_MS.connection,
      greetingTimeout: DEFAULT_SMTP_TIMEOUTS_MS.greeting,
      socketTimeout: DEFAULT_SMTP_TIMEOUTS_MS.socket,
      // The URL still supplies the host and port.
      host: 'smtp.example.com',
      port: 587,
    });
    expect(DEFAULT_SMTP_TIMEOUTS_MS).toEqual({
      connection: 10_000,
      greeting: 10_000,
      socket: 30_000,
    });
  });

  it('reads the timeouts from config when it has them', () => {
    const options = optionsOf(
      new SmtpEmailProvider({
        ...config,
        SMTP_CONNECTION_TIMEOUT_MS: 1_000,
        SMTP_GREETING_TIMEOUT_MS: 2_000,
        SMTP_SOCKET_TIMEOUT_MS: 3_000,
      }),
    );
    expect(options).toMatchObject({
      connectionTimeout: 1_000,
      greetingTimeout: 2_000,
      socketTimeout: 3_000,
    });
  });

  it('keeps the default timeouts shorter than the outbox claim lease', () => {
    // A hung send must give up before the drainer treats its claim as stale and hands the row to another worker.
    const worstCaseMs =
      DEFAULT_SMTP_TIMEOUTS_MS.connection +
      DEFAULT_SMTP_TIMEOUTS_MS.greeting +
      DEFAULT_SMTP_TIMEOUTS_MS.socket;
    expect(worstCaseMs).toBeLessThan(STALE_CLAIM_MIN * 60_000);
  });
});

describe('redactError', () => {
  it('strips scheme://user:pass@ from any URL in the message', () => {
    const out = redactError(
      new Error('failed: smtp://user:p%40ss@host:25 and smtps://u2:pw2@other.example.com/x'),
    );
    expect(out).not.toContain('p%40ss');
    expect(out).not.toContain('pw2');
    expect(out).not.toContain('user:');
    expect(out).toContain('smtp://[redacted]@host:25');
    expect(out).toContain('smtps://[redacted]@other.example.com/x');
  });

  it('handles non-Error values and leaves a message without credentials alone', () => {
    expect(redactError('plain text failure')).toBe('plain text failure');
    expect(redactError({ toString: () => 'odd smtp://a:b@h' })).toBe('odd smtp://[redacted]@h');
    expect(redactError(undefined)).toBe('undefined');
  });

  it('caps the length so last_error stays small', () => {
    expect(redactError(new Error('x'.repeat(5000))).length).toBeLessThanOrEqual(500);
  });
});
