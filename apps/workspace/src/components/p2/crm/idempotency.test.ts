import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

import { nextKey } from './idempotency';

const KEY = '44444444-4444-4444-8444-444444444444';
const GUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What the API sends for the idempotency guard (platform/db/idempotency.ts): the header is named in the text. */
const apiError = (status: number, code: string, message: string) =>
  new ApiError(status, message, { error: { code, message, correlationId: 'c' } });

describe('nextKey', () => {
  it.each([
    'The first request with this Idempotency-Key did not finish',
    'This Idempotency-Key was released while it was being checked',
  ])('keeps the key after the in-progress 409 "%s"', (message) => {
    expect(nextKey(apiError(409, 'conflict', message), KEY)).toBe(KEY);
  });

  it('rotates the key after the 422 for a key reused with different content', () => {
    const err = apiError(
      422,
      'validation_failed',
      'This Idempotency-Key was already used for a different request',
    );
    const next = nextKey(err, KEY);
    expect(next).toMatch(GUID_SHAPE);
    expect(next).not.toBe(KEY);
  });

  it.each([
    [400, 'bad_request', 'Invalid body'],
    [403, 'forbidden', 'No permission'],
    [404, 'not_found', 'Not found'],
    [409, 'conflict', 'The row version moved'],
    [422, 'validation_failed', 'Refused'],
  ])('rotates the key after an ordinary %i', (status, code, message) => {
    const next = nextKey(apiError(status, code, message), KEY);
    expect(next).toMatch(GUID_SHAPE);
    expect(next).not.toBe(KEY);
  });

  it('rotates after a bare 4xx with no body', () => {
    expect(nextKey(new ApiError(400, 'x'), KEY)).not.toBe(KEY);
  });

  it('keeps the key after a 5xx or a network error', () => {
    expect(nextKey(new ApiError(503, 'down'), KEY)).toBe(KEY);
    expect(nextKey(new TypeError('fetch failed'), KEY)).toBe(KEY);
  });
});
