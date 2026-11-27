// Bounce handling: what happens after Postal tells us an email could not be delivered.
// Serves the Reliability NFR (Non-Functional Requirement: a measurable quality target): a customer
// address that bounces must stop receiving mail we keep trying to send, and the operator must be able to
// see why a quotation email never arrived.
//
// Two rules keep the public webhook safe:
//   - the signature is checked first (verifyPostalSignature), and with no secret configured nothing passes;
//   - the payload is trusted for two things only: the event name and the message id. The row to mark is
//     found by that message id across tenants (the same way the drainer reads the outbox), never by an
//     address, a tenant id or an organization id taken from the payload.
import { createHmac, timingSafeEqual } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { z } from 'zod';

/** hard = the address is bad (stop sending to it); soft = a temporary failure (Postal keeps retrying). */
export type BounceKind = 'hard' | 'soft';

export interface BounceMark {
  /** Message-ID header value without angle brackets, as the outbox stored it after the send. */
  messageId: string;
  kind: BounceKind;
}

/** Where a bounce is written. The SQL implementation is in bounce.store.ts; unit tests use a fake. */
export abstract class BounceStore {
  /**
   * Marks the outbox row sent with this message id as bounced and, for a hard bounce, stops the emails
   * still waiting for the same recipient. Returns how many rows matched the message id (0 = not ours).
   */
  abstract markBounced(mark: BounceMark): Promise<number>;
}

const SHA256_HEX = /^[0-9a-f]{64}$/i;

/**
 * True only when `header` is the hex HMAC-SHA256 of the raw body under `secret` (an optional `sha256=`
 * prefix is allowed). Never throws: every malformed input is just `false`, and an empty secret never matches.
 *
 * This is a shared-secret scheme chosen by us, not Postal's own: native Postal signs webhooks with an RSA
 * key pair (header X-Postal-Signature, verified with the install's public key). Until that is confirmed
 * and swapped in, the secret has to be put on the webhook by whatever relays or configures Postal's call.
 *
 * Replay (R7 U1-05): the signature covers the body only, in our own format, so a captured request verifies
 * again. No event-id guard is added: the format is not Postal's to extend, a guard needs a store (a table
 * or a Valkey key set), and a replay is harmless today because markBounced only rewrites the same outbox
 * row to the same state and a hard bounce re-stops only mail that is still pending.
 */
export function verifyPostalSignature(rawBody: Buffer, header: string, secret: string): boolean {
  if (secret.length === 0 || header.length === 0) return false;
  const given = header.trim().replace(/^sha256=/i, '');
  // Shape first: Buffer.from(hex) silently stops at a bad character, and timingSafeEqual throws on a length mismatch.
  if (!SHA256_HEX.test(given)) return false;
  const expected = createHmac('sha256', Buffer.from(secret, 'utf8')).update(rawBody).digest();
  return timingSafeEqual(Buffer.from(given, 'hex'), expected);
}

/** Only the fields we act on. Everything else in Postal's payload (addresses, subjects, output) is ignored. */
const PostalEvent = z.object({
  event: z.string().min(1).max(100),
  payload: z
    .object({
      status: z.string().max(50).optional(),
      message: z
        .object({ message_id: z.string().max(500).optional() })
        .partial()
        .optional(),
      original_message: z
        .object({ message_id: z.string().max(500).optional() })
        .partial()
        .optional(),
    })
    .partial()
    .optional(),
});

/** What the controller reports back: only for logs and tests, never in the HTTP answer. */
export type BounceOutcome = 'ignored' | 'no_message_id' | 'unknown_message' | 'recorded';

/** `<id@host>` and `id@host` are the same Message-ID; the outbox keeps whatever the SMTP library returned. */
function normalizeMessageId(raw: string | undefined): string | undefined {
  const id = raw?.trim().replace(/^<|>$/g, '').trim();
  return id === undefined || id === '' ? undefined : id;
}

@Injectable()
export class BounceService {
  constructor(private readonly store: BounceStore) {}

  /** Throws ZodError for a body that is not an event object; the controller turns that into 400. */
  async handle(body: unknown): Promise<BounceOutcome> {
    const event = PostalEvent.parse(body);
    const payload = event.payload ?? {};

    let kind: BounceKind;
    let rawId: string | undefined;
    if (event.event === 'MessageBounced') {
      // A bounce message came back for an email we sent: the address is bad or the mailbox is gone.
      kind = 'hard';
      rawId = payload.original_message?.message_id ?? payload.message?.message_id;
    } else if (event.event === 'MessageDeliveryFailed') {
      kind = payload.status === 'HardFail' ? 'hard' : 'soft';
      rawId = payload.message?.message_id ?? payload.original_message?.message_id;
    } else {
      return 'ignored';
    }

    const messageId = normalizeMessageId(rawId);
    if (messageId === undefined) return 'no_message_id';
    const matched = await this.store.markBounced({ messageId, kind });
    return matched > 0 ? 'recorded' : 'unknown_message';
  }
}
