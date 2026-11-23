import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const { vendorFailure } = await import('./failure');

const err = (status: number, code?: string, extra: Record<string, unknown> = {}) =>
  new ApiError(status, 'x', {
    error: { code, message: 'internal wording', correlationId: 'corr-12345678', ...extra },
  });

describe('vendorFailure: the 403 for the creator and the proposer', () => {
  const sod = err(403, 'forbidden', { reason: 'separation_of_duties' });

  it('says "you created this vendor" when activating, never "this document"', () => {
    const f = vendorFailure(sod, 'activate');
    expect(f.message).toMatch(/You created this vendor/);
    expect(f.message).toMatch(/someone else/i);
    expect(f.message).not.toMatch(/document/i);
    expect(f.definite).toBe(true);
  });

  it('says "you proposed this bank account" when verifying', () => {
    const f = vendorFailure(sod, 'verify');
    expect(f.message).toMatch(/You proposed this bank account/);
    expect(f.message).toMatch(/someone else/i);
  });

  it('words a plain permission refusal without a role dump', () => {
    const f = vendorFailure(err(403, 'forbidden', { reason: 'no_permission' }), 'create');
    expect(f.message).toMatch(/do not allow|don't allow/i);
  });
});

describe('vendorFailure: the 409 refusals', () => {
  it('activate without an approved KYB case names the KYB case, not a customer', () => {
    const f = vendorFailure(err(409, 'kyb_not_verified'), 'activate');
    expect(f.message).toMatch(/approved KYB case/);
    expect(f.message).not.toMatch(/customer/i);
    expect(f.reload).toBe(false);
    expect(f.definite).toBe(true);
  });

  it('names an expired KYC document', () => {
    expect(vendorFailure(err(409, 'kyc_expired'), 'activate').message).toMatch(/expired/);
  });

  it('says the KYB case must be submitted before review', () => {
    expect(vendorFailure(err(409, 'kyb_not_submitted'), 'submitKyc').message).toMatch(
      /KYB case.*submitted/i,
    );
  });

  it('a duplicate PAN names vendors, not customers', () => {
    const f = vendorFailure(err(409, 'duplicate_pan_vat'), 'create');
    expect(f.message).toMatch(/Another vendor already has this PAN/);
  });

  it('a locked identity and a frozen vendor have their own sentences', () => {
    expect(vendorFailure(err(409, 'vendor_identity_locked'), 'edit').message).toMatch(
      /cannot be edited/,
    );
    expect(vendorFailure(err(409, 'vendor_not_editable'), 'edit').message).toMatch(
      /blocked or archived/,
    );
  });

  it('an invalid transition reads by operation and asks for a reload, since the status moved', () => {
    const grant = vendorFailure(err(409, 'invalid_transition'), 'grant');
    expect(grant.message).toMatch(/approved|waiting for KYC/);
    expect(grant.reload).toBe(true);
    const decided = vendorFailure(err(409, 'invalid_transition'), 'verify');
    expect(decided.message).toMatch(/already been decided/);
    const status = vendorFailure(err(409, 'invalid_transition'), 'activate');
    expect(status.reload).toBe(true);
  });

  it('unevidenced call-back documents ask for a clean upload', () => {
    expect(vendorFailure(err(409, 'callback_evidence_not_clean'), 'verify').message).toMatch(
      /virus scan/,
    );
  });

  it('a version conflict on edit asks for a reload', () => {
    const f = vendorFailure(err(409, 'conflict'), 'edit');
    expect(f.reload).toBe(true);
    expect(f.message).toMatch(/changed/);
  });

  it('the in-progress 409 is not definite, so the same key is sent again', () => {
    const f = vendorFailure(
      err(409, 'conflict', { message: 'A request with this Idempotency-Key is still in progress' }),
      'create',
    );
    expect(f.definite).toBe(false);
    expect(f.message).toMatch(/still being processed/);
  });
});

describe('vendorFailure: other answers', () => {
  it('a contact without an email says what to do', () => {
    expect(vendorFailure(err(400, 'contact_email_missing'), 'grant').message).toMatch(
      /no email address/,
    );
  });

  it('a 400 shows the API field text', () => {
    const f = vendorFailure(
      err(400, 'bad_request', { message: 'pan: a PAN is 9 digits' }),
      'create',
    );
    expect(f.message).toContain('pan: a PAN is 9 digits');
  });

  it('an unconfigured sign-in service is worded, and is not definite', () => {
    const f = vendorFailure(err(503, 'idp_not_configured'), 'grant');
    expect(f.message).toMatch(/sign-in service/);
    expect(f.definite).toBe(false);
  });

  it('a 5xx and a lost connection are not definite and never blame the person', () => {
    expect(vendorFailure(err(500, 'internal'), 'create').definite).toBe(false);
    const lost = vendorFailure(new Error('fetch failed'), 'create');
    expect(lost.definite).toBe(false);
    expect(lost.status).toBe(0);
    expect(lost.message).toMatch(/Nothing was lost/);
  });

  it('a 404 names the vendor or the account', () => {
    expect(vendorFailure(err(404, 'not_found'), 'load').message).toMatch(/vendor/);
    expect(vendorFailure(err(404, 'not_found'), 'verify').message).toMatch(/bank account/);
  });

  it('never repeats the API text for a 5xx', () => {
    expect(vendorFailure(err(500, 'internal'), 'create').message).not.toContain('internal wording');
  });
});
