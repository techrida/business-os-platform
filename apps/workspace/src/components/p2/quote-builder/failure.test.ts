import { describe, expect, it } from 'vitest';

import {
  describeQuoteFailure,
  isIdempotencyInProgress,
  STALE_FX_MESSAGE,
  STALE_VERSION_MESSAGE,
} from './failure';

const err = (status: number, code: string, message = 'm', details?: Record<string, unknown>) => ({
  status,
  body: { error: { code, message, correlationId: 'c', ...(details ? { details } : {}) } },
});

describe('describeQuoteFailure: approvers', () => {
  it('words NO_ELIGIBLE_APPROVER (422) instead of "check the highlighted fields"', () => {
    const f = describeQuoteFailure(err(422, 'NO_ELIGIBLE_APPROVER'), 'submit');
    expect(f.message).toBe(
      'No one can approve this right now. Ask an admin to check the approvers for this route.',
    );
    expect(f.kind).not.toBe('invalid');
  });

  it("says why a chosen approver was refused (422 APPROVER_NOT_ELIGIBLE), in the API's words", () => {
    const f = describeQuoteFailure(
      err(422, 'APPROVER_NOT_ELIGIBLE', 'You prepared this quotation, so you cannot approve it.'),
      'submit',
    );
    expect(f.message).toBe(
      'You prepared this quotation, so you cannot approve it. Nothing was submitted.',
    );
    expect(f.kind).toBe('error');
  });

  it('keeps the generic 422 wording for an uncoded 422', () => {
    const f = describeQuoteFailure(err(422, 'bad_request', 'nope'), 'submit');
    expect(f).toMatchObject({ kind: 'invalid' });
    expect(f.message).toMatch(/highlighted fields/);
  });
});

describe('describeQuoteFailure: exchange rate', () => {
  it('names the currency and the rate date from details', () => {
    const f = describeQuoteFailure(
      err(409, 'fx_rate_stale', 'x', { currency: 'USD', rateDate: '2026-10-01', maxAgeDays: 7 }),
      'preview',
    );
    expect(f.kind).toBe('stale_fx');
    expect(f.message).toContain('USD');
    expect(f.message).toContain('2026-10-01');
    expect(f.message).toContain('7 days');
    expect(f.message).toMatch(/Your changes are still here/);
  });

  it('falls back to the plain wording without details', () => {
    expect(describeQuoteFailure(err(409, 'fx_rate_stale'), 'submit')).toEqual({
      kind: 'stale_fx',
      message: STALE_FX_MESSAGE,
    });
  });

  it('ignores details that are not a currency code or a date', () => {
    const f = describeQuoteFailure(
      err(409, 'fx_rate_stale', 'x', { currency: 'click <b>here</b>', rateDate: 'soon' }),
      'submit',
    );
    expect(f.message).toBe(STALE_FX_MESSAGE);
  });

  it('says so when no rate exists at all (409 conflict "No NPR rate for USD ...")', () => {
    const f = describeQuoteFailure(
      err(409, 'conflict', 'No NPR rate for USD on or before 2026-11-01'),
      'preview',
    );
    expect(f.kind).toBe('stale_fx');
    expect(f.message).toContain('USD');
    expect(f.message).toMatch(/no .*rate/i);
  });
});

describe('describeQuoteFailure: conflicts that are not a stale version', () => {
  it('says approvals are not set up when no workflow is published (preview 409)', () => {
    const f = describeQuoteFailure(
      err(409, 'conflict', 'No published approval workflow for "quotation_version"'),
      'preview',
    );
    expect(f.message).toBe("Approvals for quotations aren't set up yet. Ask an admin.");
    expect(f.kind).not.toBe('stale');
  });

  it('says "still saving" for both idempotency 409s', () => {
    for (const message of [
      'This Idempotency-Key was released while it was being checked',
      'The first request with this Idempotency-Key did not finish',
    ]) {
      const f = describeQuoteFailure(err(409, 'conflict', message), 'save');
      expect(f.message).toBe('Still saving — wait a moment and try again.');
      expect(f.kind).not.toBe('stale');
    }
  });

  it('tells the in-progress 409s from other conflicts and from the 422', () => {
    for (const message of [
      'This Idempotency-Key was released while it was being checked',
      'The first request with this Idempotency-Key did not finish',
    ]) {
      expect(isIdempotencyInProgress(err(409, 'conflict', message))).toBe(true);
    }
    expect(isIdempotencyInProgress(err(409, 'conflict', 'stale'))).toBe(false);
    expect(
      isIdempotencyInProgress(
        err(422, 'bad_request', 'This Idempotency-Key was already used for a different request'),
      ),
    ).toBe(false);
    expect(isIdempotencyInProgress(new TypeError('fetch failed'))).toBe(false);
    expect(isIdempotencyInProgress(null)).toBe(false);
  });

  it('says it was already submitted with different content for the idempotency 422', () => {
    const f = describeQuoteFailure(
      err(422, 'bad_request', 'This Idempotency-Key was already used for a different request'),
      'submit',
    );
    expect(f.message).toBe(
      'This was already submitted with different content. Reload and try again.',
    );
    expect(f.kind).not.toBe('invalid');
  });

  it('keeps the stale-version wording for the row-version 409', () => {
    for (const message of [
      'This record was changed by someone else; reload it and try again',
      'm',
    ]) {
      expect(describeQuoteFailure(err(409, 'conflict', message), 'submit')).toEqual({
        kind: 'stale',
        message: STALE_VERSION_MESSAGE,
      });
    }
  });
});
