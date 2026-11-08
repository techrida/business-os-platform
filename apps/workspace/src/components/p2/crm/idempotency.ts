import 'server-only';

import { randomUUID } from 'node:crypto';

import { ApiError } from '@/lib/api';

import { isIdempotencyInProgress } from '../quote-builder/failure';

import { IDEMPOTENCY_KEY } from './action-helpers';

/**
 * The key the form submitted, or a fresh one when it is missing or was tampered with. A key that
 * is not ours would let two different requests collide, so it is never forwarded.
 */
export function keyOf(form: FormData): string {
  const value = form.get('idempotencyKey');
  return typeof value === 'string' && IDEMPOTENCY_KEY.test(value) ? value : randomUUID();
}

/**
 * The key the next try sends after a failed call. A 4xx is a final answer, so the next click is a
 * new request and gets a new key. Anything else (timeout, network, 5xx) may have landed, so the
 * same key goes again and the API returns the first result instead of creating a second record.
 * One 4xx is not final: the 409 saying the first request with this key is still being processed.
 * A new key there would turn the retry into a second request and could create a duplicate.
 */
export function nextKey(err: unknown, key: string): string {
  return err instanceof ApiError &&
    err.status >= 400 &&
    err.status < 500 &&
    !isIdempotencyInProgress(err)
    ? randomUUID()
    : key;
}
