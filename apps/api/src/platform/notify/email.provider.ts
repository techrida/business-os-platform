// Sends one email through SMTP. Serves the Reliability NFR (a failure becomes a retry, not a crash) and
// the Security NFR (the SMTP URL carries a password, and nodemailer errors can quote it, so every error
// is stripped of credentials before it is thrown, logged or saved as outbox.last_error).
import { createTransport, type Transporter } from 'nodemailer';

/** What the outbox drainer needs from a mail service. Tests and a future provider (SES, Resend) swap in here. */
export interface EmailProvider {
  send(m: {
    to: string;
    subject: string;
    text: string;
    html?: string;
  }): Promise<{ providerMessageId: string }>;
}

/** Nest injection token for the EmailProvider. */
export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER');

/** A stored or logged error is a hint for the operator, not a transcript. */
const MAX_ERROR_LENGTH = 500;

/** scheme://user:pass@ . The userinfo part is what carries the password. */
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s@]*@/gi;

/**
 * The error as a short string with any `scheme://user:pass@` credentials removed. Use it for every
 * place an email error goes: thrown messages, logs and outbox.last_error.
 */
export function redactError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const redacted = raw.replace(URL_CREDENTIALS, '$1[redacted]@');
  return redacted.length > MAX_ERROR_LENGTH
    ? `${redacted.slice(0, MAX_ERROR_LENGTH - 1)}…`
    : redacted;
}

/** The failure of a send. The message is already redacted and the original error is not attached (it may quote the URL). */
export class EmailSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailSendError';
  }
}

/** The part of nodemailer's Transporter this class uses; a test passes a fake with the same method. */
export type MailTransport = Pick<Transporter, 'sendMail'>;

export class SmtpEmailProvider implements EmailProvider {
  private readonly transport: MailTransport;

  /**
   * `config` is the two CoreConfig fields. `transport` is for tests; production leaves it out and the
   * transport is built from SMTP_URL (nodemailer reads host, port, TLS and login from the URL).
   */
  constructor(
    private readonly config: { SMTP_URL: string; MAIL_FROM: string },
    transport?: MailTransport,
  ) {
    this.transport = transport ?? createTransport(config.SMTP_URL);
  }

  async send(m: {
    to: string;
    subject: string;
    text: string;
    html?: string;
  }): Promise<{ providerMessageId: string }> {
    try {
      const info = await this.transport.sendMail({
        from: this.config.MAIL_FROM,
        to: m.to,
        subject: m.subject,
        text: m.text,
        ...(m.html === undefined ? {} : { html: m.html }),
      });
      return { providerMessageId: String(info.messageId) };
    } catch (err) {
      throw new EmailSendError(redactError(err));
    }
  }
}
