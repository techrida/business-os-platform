import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

vi.mock('server-only', () => ({}));

import { poFailure } from './failure';

const err = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  new ApiError(status, 'x', {
    error: { code, message: 'internal wording', correlationId: 'corr-12345678', ...extra },
  });

describe('poFailure: issue', () => {
  it('words the three 409 codes plainly and keeps the page', () => {
    const a = poFailure(err(409, 'VENDOR_NOT_APPROVED'), 'issue');
    expect(a.message).toMatch(/vendor is not approved/i);
    expect(a.reload).toBe(false);
    expect(a.definite).toBe(true);
    expect(poFailure(err(409, 'VENDOR_NOT_IN_ENTITY'), 'issue').message).toMatch(
      /no active account with your legal entity/i,
    );
    expect(poFailure(err(409, 'PO_HAS_NO_LINES'), 'issue').message).toMatch(/no lines/i);
  });

  it('asks for a reload when the order is no longer a draft', () => {
    const f = poFailure(err(409, 'invalid_transition'), 'issue');
    expect(f.reload).toBe(true);
  });
});

describe('poFailure: cancel and short-close', () => {
  it('says PO_HAS_RECEIPTS in plain words and points at short-close', () => {
    const f = poFailure(err(409, 'PO_HAS_RECEIPTS'), 'cancel');
    expect(f.message).toMatch(/already been received/i);
    expect(f.message).toMatch(/short-close/i);
    expect(f.message).toMatch(/discard/i);
    expect(f.reload).toBe(false);
  });

  it('a generic conflict mentions a draft receipt and asks for a reload', () => {
    const f = poFailure(err(409, 'conflict'), 'shortClose');
    expect(f.message).toMatch(/draft receipt/i);
    expect(f.reload).toBe(true);
  });
});

describe('poFailure: amend', () => {
  it('words an invalid amendment and an unapprovable one', () => {
    expect(poFailure(err(422, 'PO_AMENDMENT_INVALID'), 'amend').message).toMatch(
      /received plus cancelled/i,
    );
    const f = poFailure(err(422, 'NO_ELIGIBLE_APPROVER'), 'amend');
    expect(f.message).toMatch(/nobody can approve/i);
    expect(f.message).toMatch(/nothing was changed/i);
  });

  it('shows the API text only for a 400', () => {
    expect(
      poFailure(err(400, 'bad_request', { message: 'reason: required' }), 'amend').message,
    ).toContain('reason: required');
    expect(poFailure(err(500, 'internal'), 'amend').message).not.toContain('internal wording');
  });
});

describe('poFailure: the shared rules', () => {
  it('403 words the reason and never the API text', () => {
    expect(poFailure(err(403, 'forbidden', { reason: 'mfa_required' }), 'issue').message).toMatch(
      /second sign-in step/i,
    );
    expect(poFailure(err(403, 'forbidden', { reason: 'no_permission' }), 'issue').message).toMatch(
      /roles do not allow/i,
    );
  });

  it('404 is "not found"', () => {
    expect(poFailure(err(404, 'not_found'), 'load').message).toMatch(/could not find/i);
  });

  it('keeps the key after the in-progress 409, a timeout, a 5xx and a lost connection', () => {
    const inProgress = poFailure(
      err(409, 'conflict', { message: 'A request with this Idempotency-Key is still in progress' }),
      'issue',
    );
    expect(inProgress.definite).toBe(false);
    expect(poFailure(err(408, 'timeout'), 'issue').definite).toBe(false);
    expect(poFailure(err(429, 'rate_limited'), 'issue').definite).toBe(false);
    expect(poFailure(err(503, 'x'), 'issue').definite).toBe(false);
    const lost = poFailure(new Error('socket hang up'), 'issue');
    expect(lost.definite).toBe(false);
    expect(lost.message).toMatch(/did not respond/i);
  });

  it('rotates the key after any other 4xx', () => {
    expect(poFailure(err(409, 'PO_HAS_NO_LINES'), 'issue').definite).toBe(true);
    expect(poFailure(err(422, 'PO_AMENDMENT_INVALID'), 'amend').definite).toBe(true);
    expect(poFailure(err(403, 'forbidden'), 'issue').definite).toBe(true);
  });
});
