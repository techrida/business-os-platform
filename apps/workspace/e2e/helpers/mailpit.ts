import { getJson } from './api';

/**
 * A tiny client for Mailpit's REST API (`GET /api/v1/messages`), reached through Caddy at
 * `https://mail.localhost` (dev only). It lets the exit spec prove an email really left the outbox
 * and reached an SMTP server, not just that a row was queued.
 *
 * The messages are matched on the memo number, which is unique per run, so mail left over from
 * earlier runs never satisfies a wait.
 */

export interface MailpitAddress {
  Name: string;
  Address: string;
}

/** The fields of a message summary the specs read; Mailpit returns more. */
export interface MailpitMessage {
  ID: string;
  To: MailpitAddress[];
  Subject: string;
  Created: string;
}

export function mailOrigin(): string {
  return process.env.BOS_E2E_MAIL_ORIGIN ?? 'https://mail.localhost';
}

/** Every message Mailpit holds, newest first (up to 500). */
export async function listMessages(): Promise<MailpitMessage[]> {
  const body = await getJson<{ messages?: MailpitMessage[] }>(
    `${mailOrigin()}/api/v1/messages?limit=500`,
  );
  return body.messages ?? [];
}

export function sentTo(message: MailpitMessage, address: string): boolean {
  return message.To.some((to) => to.Address.toLowerCase() === address.toLowerCase());
}

/**
 * Polls until `match` finds a message. On timeout it throws with the subjects that WERE there, so
 * a failure says whether the mail is missing or only addressed or worded differently.
 */
export async function waitForMessage(
  match: (message: MailpitMessage) => boolean,
  what: string,
  timeoutMs = 45_000,
): Promise<MailpitMessage> {
  const deadline = Date.now() + timeoutMs;
  let last: MailpitMessage[] = [];
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      last = await listMessages();
      lastError = '';
      const found = last.find(match);
      if (found !== undefined) return found;
    } catch (error) {
      // Mailpit or Caddy blipped: keep trying until the deadline, but remember why.
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const seen = last
    .slice(0, 20)
    .map((m) => `${m.Subject} -> ${m.To.map((t) => t.Address).join(',')}`);
  throw new Error(
    `no Mailpit message for ${what} within ${timeoutMs} ms; ` +
      (lastError !== '' ? `last error: ${lastError}; ` : '') +
      `newest ${seen.length} messages: ${JSON.stringify(seen)}`,
  );
}
