import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

vi.mock('server-only', () => ({}));

import { rfqFailure } from './failure';

const err = (status: number, code = 'x', message = 'The API wording.', reason?: string) =>
  new ApiError(status, 'x', {
    error: { code, message, correlationId: 'corr-12345678', ...(reason ? { reason } : {}) },
  });

describe('rfqFailure', () => {
  it('shows the infected-file refusal of a recorded quotation with the file name (TR-Q12e)', () => {
    const f = rfqFailure(
      err(
        409,
        'document_infected',
        'A virus was found in “eicar.pdf”. Remove it or upload a clean copy, then try again.',
      ),
      'record',
    );
    expect(f.message).toBe(
      'A virus was found in “eicar.pdf”. Remove it or upload a clean copy, then try again.',
    );
    expect(f.reload).toBe(false);
  });

  it('keeps the key on the in-progress 409, a 5xx and a lost connection', () => {
    const inProgress = rfqFailure(
      new ApiError(409, 'x', {
        error: {
          code: 'conflict',
          message: 'A request with this Idempotency-Key is still in progress',
          correlationId: 'corr-12345678',
        },
      }),
      'create',
    );
    expect(inProgress.definite).toBe(false);
    expect(inProgress.message).toMatch(/still being processed/);
    expect(rfqFailure(err(503), 'record').definite).toBe(false);
    expect(rfqFailure(new Error('network'), 'record').definite).toBe(false);
  });

  it('rotates the key on a final 4xx answer', () => {
    for (const status of [400, 403, 404, 409, 422]) {
      expect(rfqFailure(err(status), 'record').definite).toBe(true);
    }
    expect(rfqFailure(err(408), 'record').definite).toBe(false);
    expect(rfqFailure(err(429), 'record').definite).toBe(false);
  });

  it('says RFQ, not purchase request, on a 404', () => {
    const f = rfqFailure(err(404), 'load');
    expect(f.message).toMatch(/RFQ/);
    expect(f.message).not.toMatch(/purchase request\b.*requester/);
  });

  it('shows the API reason for a domain 409 and offers a reload', () => {
    const f = rfqFailure(err(409, 'VENDOR_NOT_APPROVED', 'Vendor 2222 is not approved'), 'create');
    expect(f.message).toContain('Vendor 2222 is not approved');
    expect(f.reload).toBe(true);
  });

  it('words a scan refusal and an already-quoted vendor from the API text', () => {
    expect(
      rfqFailure(err(409, 'conflict', 'The submitted file has not scanned clean'), 'convert')
        .message,
    ).toContain('has not scanned clean');
    expect(
      rfqFailure(err(409, 'conflict', 'This vendor already quoted on this RFQ'), 'record').message,
    ).toContain('already quoted');
  });

  it('explains FEWER_THAN_MIN_QUOTES without the field name', () => {
    const f = rfqFailure(
      err(409, 'FEWER_THAN_MIN_QUOTES', 'Only 2 of 3 quotations: fewerThanThreeReason is required'),
      'recommend',
    );
    expect(f.message).not.toMatch(/fewerThanThreeReason/);
    expect(f.message).toMatch(/fewer quotations than the minimum/i);
  });

  it('says nothing was submitted on NO_ELIGIBLE_APPROVER', () => {
    const f = rfqFailure(
      err(422, 'NO_ELIGIBLE_APPROVER', 'No Finance user can approve.'),
      'commit',
    );
    expect(f.message).toContain('No Finance user can approve.');
    expect(f.message).toMatch(/Nothing was submitted/);
  });

  it('words 403 reasons', () => {
    expect(rfqFailure(err(403, 'forbidden', 'x', 'mfa_required'), 'create').message).toMatch(/MFA/);
    expect(rfqFailure(err(403), 'create').message).toMatch(/roles do not allow/);
  });
});
