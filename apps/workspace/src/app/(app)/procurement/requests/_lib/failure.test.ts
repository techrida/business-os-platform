import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

vi.mock('server-only', () => ({}));

import { prFailure } from './failure';

const apiError = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  new ApiError(status, 'x', {
    error: { code, message: 'The API wording.', correlationId: 'corr-12345678', ...extra },
  });

describe('prFailure', () => {
  it('shows a 422 NO_ELIGIBLE_APPROVER plainly, with the API reason, and rotates the key', () => {
    const f = prFailure(
      apiError(422, 'NO_ELIGIBLE_APPROVER', {
        message:
          'This purchase request cannot be submitted: no head. An administrator has been told.',
      }),
      'submit',
    );
    expect(f.message).toContain('cannot be submitted: no head');
    expect(f.message).toContain('Nothing was submitted');
    expect(f.definite).toBe(true);
    expect(f.reload).toBe(false);
  });

  it('never calls a 422 "the platform did not respond"', () => {
    const f = prFailure(apiError(422, 'other'), 'submit');
    expect(f.message).not.toMatch(/did not respond/);
    expect(f.definite).toBe(true);
  });

  it('a 409 on submit, cancel or edit says the status changed and offers a reload', () => {
    expect(prFailure(apiError(409, 'conflict'), 'submit')).toMatchObject({ reload: true });
    expect(prFailure(apiError(409, 'conflict'), 'cancel').message).toMatch(/draft/);
    expect(prFailure(apiError(409, 'conflict'), 'edit').message).toMatch(/submitted or changed/);
  });

  it('keeps the key on the in-progress 409', () => {
    const f = prFailure(
      apiError(409, 'conflict', {
        message: 'A request with this Idempotency-Key is still in progress',
      }),
      'submit',
    );
    expect(f.definite).toBe(false);
    expect(f.reload).toBe(false);
    expect(f.message).toMatch(/still being processed/);
  });

  it('keeps the key on a 5xx and on a lost connection', () => {
    expect(prFailure(new ApiError(503, 'x'), 'create')).toMatchObject({ definite: false });
    expect(prFailure(new Error('fetch failed'), 'create')).toMatchObject({
      definite: false,
      status: 0,
    });
  });

  it('a 404 says the request may belong to another requester', () => {
    expect(prFailure(apiError(404, 'not_found'), 'load').message).toMatch(/another requester/);
  });

  it('a 403 scope refusal is worded for a person', () => {
    expect(
      prFailure(apiError(403, 'forbidden', { reason: 'out_of_scope' }), 'load').message,
    ).toMatch(/cannot access/);
    expect(prFailure(apiError(403, 'forbidden'), 'create').message).toMatch(/roles do not allow/);
  });

  it('shows the API text of a 400 (it names fields, never values)', () => {
    const f = prFailure(apiError(400, 'bad_request', { message: 'Unknown department' }), 'create');
    expect(f.message).toContain('Unknown department');
  });
});

describe('a currency switched off (U16-Q14, D44)', () => {
  it.each(['create', 'edit'] as const)(
    'shows the agreed wording on %s, not the API sentence',
    (op) => {
      const f = prFailure(
        apiError(422, 'CURRENCY_NOT_ENABLED', {
          message: 'Currency USD is not enabled for this company',
          details: { currency: 'USD' },
        }),
        op,
      );
      expect(f.message).toBe(
        'USD is switched off for your company. Choose another currency, or ask an administrator to switch it on in Settings.',
      );
      expect(f.definite).toBe(true);
      expect(f.reload).toBe(false);
    },
  );

  it('reads the uncoded 422 the error filter sends today', () => {
    const f = prFailure(
      apiError(422, 'bad_request', { message: 'Currency USD is not enabled for this company' }),
      'create',
    );
    expect(f.message).toContain('USD is switched off for your company.');
  });
});
