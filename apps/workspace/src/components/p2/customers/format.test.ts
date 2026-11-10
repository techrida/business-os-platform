import { describe, expect, it } from 'vitest';

import {
  canApprove,
  canReject,
  checklistProgress,
  customerLabel,
  isGuid,
  parseDecision,
  parseStatusFilter,
} from './format';

const ID = '11111111-1111-4111-8111-111111111111';

const item = (
  key: string,
  required: boolean,
  status: 'missing' | 'provided' | 'accepted' | 'rejected',
) => ({
  key: key as 'other',
  required,
  status,
  documentId: status === 'missing' ? null : ID,
  expiresOn: null,
});

const verificationCase = (status: string, checklist = [item('other', true, 'accepted')]) => ({
  id: ID,
  partyId: ID,
  status: status as 'submitted',
  checklist,
  reviewedBy: null,
  decidedAt: null,
  decisionNote: null,
  version: 3,
});

describe('checklistProgress', () => {
  it('counts accepted required items and ignores optional ones', () => {
    const p = checklistProgress([
      item('registration_certificate', true, 'accepted'),
      item('pan_vat_certificate', true, 'provided'),
      item('other', false, 'accepted'),
    ]);
    expect(p).toEqual({ accepted: 1, required: 2, complete: false });
  });

  it('is not complete with no required item at all', () => {
    expect(checklistProgress([item('other', false, 'accepted')]).complete).toBe(false);
    expect(checklistProgress([]).complete).toBe(false);
  });
});

describe('who may decide', () => {
  it('approves only a submitted case whose required items are all accepted', () => {
    expect(canApprove(verificationCase('submitted'))).toBe(true);
    expect(canApprove(verificationCase('submitted', [item('other', true, 'provided')]))).toBe(
      false,
    );
    expect(canApprove(verificationCase('draft'))).toBe(false);
    expect(canApprove(verificationCase('approved'))).toBe(false);
  });

  it('rejects any submitted case, complete or not', () => {
    expect(canReject(verificationCase('submitted', [item('other', true, 'missing')]))).toBe(true);
    expect(canReject(verificationCase('rejected'))).toBe(false);
    expect(canReject(verificationCase('expired'))).toBe(false);
  });
});

describe('parseDecision', () => {
  it('needs a reason for approve as well as reject (stricter than the contract)', () => {
    const noReason = parseDecision({ decision: 'approve', comment: '   ', expectedVersion: '3' });
    expect(noReason).toEqual({
      ok: false,
      commentError: 'Say why you are approving. The reason is kept in the audit trail.',
    });
    const reject = parseDecision({ decision: 'reject', comment: '', expectedVersion: '3' });
    expect(reject).toEqual({
      ok: false,
      commentError: 'Say why you are rejecting. The reason is kept in the audit trail.',
    });
  });

  it('builds the body the contract accepts, with the comment trimmed', () => {
    expect(
      parseDecision({
        decision: 'reject',
        comment: '  PAN certificate is blurred. ',
        expectedVersion: '3',
      }),
    ).toEqual({
      ok: true,
      data: { decision: 'reject', comment: 'PAN certificate is blurred.', expectedVersion: 3 },
    });
  });

  it('refuses an unknown decision or a bad version as an incomplete form', () => {
    for (const bad of [
      { decision: 'return', comment: 'x', expectedVersion: '3' },
      { decision: 'approve', comment: 'x', expectedVersion: '0' },
      { decision: 'approve', comment: 'x', expectedVersion: 'abc' },
      { decision: '', comment: 'x', expectedVersion: '3' },
    ]) {
      expect(parseDecision(bad)).toEqual({ ok: false, formError: true });
    }
  });

  it('refuses a reason over 2000 characters', () => {
    const r = parseDecision({
      decision: 'approve',
      comment: 'x'.repeat(2001),
      expectedVersion: '3',
    });
    expect(r.ok).toBe(false);
  });
});

describe('small helpers', () => {
  it('reads the status filter from the query string and defaults to the review queue', () => {
    expect(parseStatusFilter(undefined)).toBe('submitted');
    expect(parseStatusFilter('approved')).toBe('approved');
    expect(parseStatusFilter('all')).toBe('all');
    expect(parseStatusFilter('nonsense')).toBe('submitted');
    expect(parseStatusFilter(['approved', 'rejected'])).toBe('submitted');
  });

  it('recognises a GUID before it goes into an API path', () => {
    expect(isGuid(ID)).toBe(true);
    expect(isGuid('../admin')).toBe(false);
    expect(isGuid('')).toBe(false);
  });

  it('names a customer, or falls back to an unavailable-name label when the name could not be read', () => {
    expect(customerLabel({ legalName: 'Himalayan Construction', number: 'CUS-0001' })).toBe(
      'Himalayan Construction',
    );
    expect(customerLabel(undefined, 'aaaabbbb-1111-4111-8111-1234567890ab')).toBe(
      'Customer name unavailable',
    );
  });
});
