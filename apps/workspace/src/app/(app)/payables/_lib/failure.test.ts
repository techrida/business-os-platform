import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

import { billFailure } from './failure';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const apiError = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  new ApiError(status, 'x', {
    error: { code, message: 'internal wording', correlationId: 'corr-12345678', ...extra },
  });

describe('billFailure', () => {
  it('directs an unclean draft invoice back to its available replacement action', () => {
    const result = billFailure(apiError(409, 'BILL_DOCUMENT_NOT_CLEAN'), 'submit');
    expect(result.message).toContain('Upload a replacement file');
    expect(result.message).toContain('draft bill');
    expect(result.reload).toBe(true);
  });
  it('names each refusal the bill routes make and rotates the key after a definite answer', () => {
    const cases: [number, string, Parameters<typeof billFailure>[1], RegExp][] = [
      [409, 'DUPLICATE_BILL', 'convert', /already has a bill with this invoice number/i],
      [409, 'SUBMISSION_FILE_NOT_CLEAN', 'convert', /scan/i],
      [409, 'SUBMISSION_NOT_RECEIVED', 'reject', /already (been )?(converted|decided|handled)/i],
      [409, 'BILL_NOT_MATCHED', 'submit', /match/i],
      [409, 'BILL_HAS_ALLOCATIONS', 'void', /payment/i],
      [409, 'BILL_HAS_PAYMENT_REQUEST', 'void', /payment request/i],
      [409, 'BILL_NOT_POSTED', 'void', /payable/i],
      [409, 'MATCH_NOT_REQUIRED', 'match', /purchase order/i],
      [422, 'NO_ELIGIBLE_APPROVER', 'submit', /nobody can approve/i],
      [422, 'BILL_DATE_IN_FUTURE', 'create', /invoice date is after today/i],
      [422, 'PO_VENDOR_MISMATCH', 'convert', /another vendor/i],
      [422, 'SUBMISSION_MISMATCH', 'convert', /does not match the submission/i],
      [422, 'invalid_evidence_document', 'exception', /not evidence uploaded to this record/],
      [422, 'DOCUMENT_NOT_FOUND', 'exception', /not evidence uploaded to this record/],
      [422, 'DOCUMENT_NOT_FOUND', 'create', /invoice file could not be found/],
    ];
    for (const [status, code, op, re] of cases) {
      const f = billFailure(apiError(status, code), op);
      expect(f.message, code).toMatch(re);
      expect(f.definite, code).toBe(true);
    }
  });

  it('asks for a reload after an invalid transition', () => {
    const f = billFailure(apiError(409, 'invalid_transition'), 'void');
    expect(f.reload).toBe(true);
    expect(f.message).toMatch(/reload/i);
  });

  it('keeps the key for a timeout, a 5xx and the in-progress 409', () => {
    expect(billFailure(new Error('network'), 'submit').definite).toBe(false);
    expect(billFailure(new ApiError(503, 'x'), 'submit').definite).toBe(false);
    expect(billFailure(new ApiError(408, 'x'), 'submit').definite).toBe(false);
  });

  it('words 403 and 404 for what the person was doing, never with the API text', () => {
    expect(billFailure(apiError(403, 'forbidden'), 'void').message).toMatch(/roles/i);
    expect(billFailure(apiError(404, 'not_found'), 'load').message).toMatch(
      /another legal entity/i,
    );
    expect(billFailure(apiError(409, 'whatever'), 'void').message).not.toMatch(/internal wording/);
  });
});
