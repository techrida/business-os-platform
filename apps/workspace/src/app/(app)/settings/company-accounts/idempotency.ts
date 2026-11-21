import { randomUUID } from 'node:crypto';

/** A form's key is a UUID; anything else in the hidden field was tampered with or lost. */
const KEY = /^[A-Za-z0-9-]{8,64}$/;

/**
 * The Idempotency-Key a form submitted, or a fresh one when it sent none or a malformed one. A form holds one
 * stable key from the moment it opens until a save succeeds, so a double click or a retry after a lost answer
 * reaches the API under the same key and writes once; the API frees the key when a write is refused.
 */
export function keyOf(submitted: unknown): string {
  return typeof submitted === 'string' && KEY.test(submitted) ? submitted : randomUUID();
}
