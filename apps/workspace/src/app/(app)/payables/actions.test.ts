import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));
const session = vi.hoisted(() => ({ roles: ['accountant'] as string[] }));
vi.mock('@/lib/bff', () => ({
  requireStaffSession: () => Promise.resolve({ roles: session.roles }),
}));
// GET /v1/me for an unedited role answers the role's default grants; a test sets `live` for an edited one.
const grants = vi.hoisted(() => ({ live: undefined as Map<string, string> | undefined }));
vi.mock('@/lib/grants', async () => {
  const { DEFAULT_ROLE_PERMISSIONS } = await import('@bos/contracts');
  return {
    getGrants: () =>
      Promise.resolve(
        grants.live ??
          new Map(
            session.roles.flatMap((r) =>
              Object.entries(DEFAULT_ROLE_PERMISSIONS[r as keyof typeof DEFAULT_ROLE_PERMISSIONS]),
            ),
          ),
      ),
    hasGrant: (g: Map<string, string>, p: string) => g.has(p),
  };
});
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));

const api = vi.hoisted(() => ({
  matchBill: vi.fn(),
  submitBill: vi.fn(),
  voidBill: vi.fn(),
  discardBill: vi.fn(),
  convertBillSubmission: vi.fn(),
  rejectBillSubmission: vi.fn(),
  requestBillException: vi.fn(),
  createBill: vi.fn(),
}));
vi.mock('@/lib/api-payables', () => api);

const {
  convertSubmissionAction,
  matchBillAction,
  rejectSubmissionAction,
  submitBillAction,
  voidBillAction,
  discardBillAction,
  requestExceptionAction,
  createBillAction,
} = await import('./actions');

import { EXPENSE_ACCOUNT_REFUSED } from './_lib/forms';

const BILL = '11111111-1111-4111-8111-111111111111';
const SUB = '22222222-2222-4222-8222-222222222222';
const ACCOUNT = '33333333-3333-4333-8333-333333333333';
const TAX = '44444444-4444-4444-8444-444444444444';
const POLINE = '55555555-5555-4555-8555-555555555555';
const KEY = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const prev = { key: KEY };

describe('discard draft bill', () => {
  it('sends the form key and revalidates on success', async () => {
    api.discardBill.mockResolvedValue({ status: 'discarded' });
    const out = await discardBillAction(prev, form({ billId: BILL, idempotencyKey: KEY }));
    expect(api.discardBill).toHaveBeenCalledWith(expect.anything(), BILL, KEY);
    expect(out.done).toMatch(/discarded/i);
  });
  it('denies finance and retains the key after an uncertain result', async () => {
    session.roles = ['finance'];
    expect(
      (await discardBillAction(prev, form({ billId: BILL, idempotencyKey: KEY }))).error,
    ).toMatch(/roles/i);
    expect(api.discardBill).not.toHaveBeenCalled();
    session.roles = ['accountant'];
    api.discardBill.mockRejectedValue(new ApiError(503, 'unavailable'));
    expect((await discardBillAction(prev, form({ billId: BILL, idempotencyKey: KEY }))).key).toBe(
      KEY,
    );
  });
});

describe('request a match exception', () => {
  it('sends the reason and preserves the approval link', async () => {
    api.requestBillException.mockResolvedValue({ approvalRequestId: SUB });
    const out = await requestExceptionAction(
      prev,
      form({
        billId: BILL,
        idempotencyKey: KEY,
        reason: ' Agreed price ',
        evidenceDocumentId: ACCOUNT,
      }),
    );
    expect(api.requestBillException).toHaveBeenCalledWith(
      expect.anything(),
      BILL,
      { reason: 'Agreed price', evidenceDocumentId: ACCOUNT },
      KEY,
    );
    expect(out.done).toMatch(/finance/i);
  });

  it('rejects malformed evidence and a blank reason before writing', async () => {
    const out = await requestExceptionAction(
      prev,
      form({ billId: BILL, idempotencyKey: KEY, reason: ' ', evidenceDocumentId: 'wrong' }),
    );
    expect(out.errors?.['reason']).toBeTruthy();
    expect(out.errors?.['evidenceDocumentId']).toBe(
      'That file could not be used. Upload it again, or remove it.',
    );
    expect(api.requestBillException).not.toHaveBeenCalled();
  });

  it('sends no evidence when none was uploaded, and words a file that is not this bill’s evidence', async () => {
    api.requestBillException.mockResolvedValue({ approvalRequestId: SUB });
    await requestExceptionAction(
      prev,
      form({ billId: BILL, idempotencyKey: KEY, reason: 'Agreed', evidenceDocumentId: '' }),
    );
    expect(api.requestBillException).toHaveBeenCalledWith(
      expect.anything(),
      BILL,
      { reason: 'Agreed' },
      KEY,
    );
    api.requestBillException.mockRejectedValue(
      new ApiError(422, 'x', {
        error: { code: 'invalid_evidence_document', message: 'm', correlationId: 'c' },
      }),
    );
    const out = await requestExceptionAction(
      prev,
      form({ billId: BILL, idempotencyKey: KEY, reason: 'Agreed', evidenceDocumentId: ACCOUNT }),
    );
    expect(out.error).toMatch(/not evidence uploaded to this record/);
  });

  it('checks the bill-enter permission and keeps the key after an uncertain result', async () => {
    session.roles = ['finance'];
    expect(
      (
        await requestExceptionAction(
          prev,
          form({ billId: BILL, idempotencyKey: KEY, reason: 'Agreed' }),
        )
      ).error,
    ).toMatch(/roles/i);
    expect(api.requestBillException).not.toHaveBeenCalled();
    session.roles = ['accountant'];
    api.requestBillException.mockRejectedValue(new ApiError(503, 'unavailable'));
    expect(
      (
        await requestExceptionAction(
          prev,
          form({ billId: BILL, idempotencyKey: KEY, reason: 'Agreed' }),
        )
      ).key,
    ).toBe(KEY);
  });
});

describe('create a standalone bill', () => {
  const fields = {
    vendorPartyId: SUB,
    vendorInvoiceNo: ' INV-101 ',
    invoiceDate: '2026-11-09',
    documentId: ACCOUNT,
    purchaseOrderId: '',
    idempotencyKey: KEY,
    lineCount: '1',
    'line:0:accountId': ACCOUNT,
    'line:0:taxCodeId': TAX,
    'line:0:quantity': '2',
    'line:0:unitPrice': '1000.00',
  };
  it('sends validated header and lines and redirects to the new bill', async () => {
    api.createBill.mockResolvedValue({ id: BILL });
    await expect(createBillAction(prev, form(fields))).rejects.toThrow(
      `REDIRECT /payables/bills/${BILL}?created=1`,
    );
    expect(api.createBill).toHaveBeenCalledWith(
      expect.anything(),
      {
        vendorPartyId: SUB,
        vendorInvoiceNo: 'INV-101',
        invoiceDate: '2026-11-09',
        documentId: ACCOUNT,
        currency: 'NPR',
        kind: 'bill',
        lines: [{ accountId: ACCOUNT, taxCodeId: TAX, quantity: '2', unitPrice: '1000' }],
      },
      KEY,
    );
  });
  it('requires the invoice file, valid date and bill-entry permission before writes', async () => {
    const out = await createBillAction(
      prev,
      form({ ...fields, documentId: '', invoiceDate: '2026-02-30' }),
    );
    expect(out.errors?.['documentId']).toBeTruthy();
    expect(out.errors?.['invoiceDate']).toBeTruthy();
    expect(api.createBill).not.toHaveBeenCalled();
    session.roles = ['finance'];
    expect((await createBillAction(prev, form(fields))).error).toMatch(/roles/i);
    expect(api.createBill).not.toHaveBeenCalled();
  });

  // The new-bill page opens on the live grants; its create action agrees (U18 #12).
  it('lets Procurement create the bill once an admin granted payables.bill.enter', async () => {
    session.roles = ['procurement'];
    grants.live = new Map([['payables.bill.enter', 'all']]);
    api.createBill.mockResolvedValue({ id: BILL });
    await expect(createBillAction(prev, form(fields))).rejects.toThrow(
      `REDIRECT /payables/bills/${BILL}?created=1`,
    );
    expect(api.createBill).toHaveBeenCalledOnce();
  });

  it('refuses an accountant whose payables.bill.enter was removed, before any write', async () => {
    grants.live = new Map([['payables.bill.read', 'all']]);
    expect((await createBillAction(prev, form(fields))).error).toMatch(/roles/i);
    expect(api.createBill).not.toHaveBeenCalled();
  });

  // TR-Q12e: the API refuses an invoice the scan found infected; the form says so with the file's name.
  it('shows the infected-file refusal in the form and closes the attempt', async () => {
    const message =
      'A virus was found in this file. Remove it or upload a clean copy, then try again.';
    api.createBill.mockRejectedValue(
      new ApiError(409, 'x', {
        error: { code: 'document_infected', message, correlationId: 'corr-12345678' },
      }),
    );
    const out = await createBillAction(prev, form(fields));
    expect(out.error).toBe(message);
    expect(out.reload).toBeUndefined();
    expect(out.key).not.toBe(KEY);
  });

  it('puts an EXPENSE_ACCOUNT_INVALID refusal on the line account field and closes the attempt', async () => {
    api.createBill.mockRejectedValue(apiError(422, 'EXPENSE_ACCOUNT_INVALID'));
    const out = await createBillAction(prev, form(fields));
    expect(out.errors).toEqual({ '0.accountId': EXPENSE_ACCOUNT_REFUSED });
    expect(out.error).toBeUndefined();
    expect(out.key).not.toBe(KEY);
  });

  it('marks only the line whose account is not among the active ones the page loaded', async () => {
    api.createBill.mockRejectedValue(apiError(422, 'EXPENSE_ACCOUNT_INVALID'));
    const out = await createBillAction(
      prev,
      form({
        ...fields,
        lineCount: '2',
        'line:1:accountId': BILL,
        'line:1:taxCodeId': TAX,
        'line:1:quantity': '1',
        'line:1:unitPrice': '10.00',
        activeAccountIds: ACCOUNT,
      }),
    );
    // Fails on the old code: it marked the active line 0 too.
    expect(out.errors).toEqual({ '1.accountId': EXPENSE_ACCOUNT_REFUSED });
  });

  it('keeps the general wording for another 422', async () => {
    api.createBill.mockRejectedValue(apiError(422, 'TAX_CODE_NOT_FOUND'));
    const out = await createBillAction(prev, form(fields));
    expect(out.errors).toBeUndefined();
    expect(out.error).toContain('VAT code');
  });
});

const apiError = (status: number, code: string) =>
  new ApiError(status, 'x', {
    error: { code, message: 'internal wording', correlationId: 'corr-12345678' },
  });

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

beforeEach(() => {
  session.roles = ['accountant'];
  grants.live = undefined;
  for (const fn of Object.values(api)) fn.mockReset();
});

describe.each([
  ['match', matchBillAction, api.matchBill],
  ['submit', submitBillAction, api.submitBill],
] as const)('%s a bill', (_name, action, call) => {
  it('sends the form key and says what happened, with a fresh key for the next decision', async () => {
    call.mockResolvedValue({ id: BILL, matchStatus: 'matched' });
    const out = await action(prev, form({ billId: BILL, idempotencyKey: KEY }));
    expect(call).toHaveBeenCalledWith(expect.anything(), BILL, KEY);
    expect(out.done).toBeTruthy();
    expect(out.key).not.toBe(KEY);
  });

  it('refuses a person without payables.bill.enter before any call', async () => {
    session.roles = ['finance'];
    const out = await action(prev, form({ billId: BILL, idempotencyKey: KEY }));
    expect(out.error).toMatch(/roles/i);
    expect(call).not.toHaveBeenCalled();
  });

  it('refuses an id that is not a GUID without calling the API', async () => {
    const out = await action(prev, form({ billId: '../x', idempotencyKey: KEY }));
    expect(out.reload).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });

  it('keeps the key after a timeout or a 5xx, and rotates it after a 4xx', async () => {
    call.mockRejectedValueOnce(new ApiError(503, 'x'));
    expect((await action(prev, form({ billId: BILL, idempotencyKey: KEY }))).key).toBe(KEY);
    call.mockRejectedValueOnce(apiError(409, 'BILL_NOT_MATCHED'));
    const out = await action(prev, form({ billId: BILL, idempotencyKey: KEY }));
    expect(out.key).not.toBe(KEY);
    expect(out.error).toMatch(/match/i);
  });

  it('keeps the key for the in-progress 409', async () => {
    call.mockRejectedValueOnce(
      new ApiError(409, 'x', {
        error: {
          code: 'conflict',
          message: 'A request with this Idempotency-Key is still in progress',
        },
      }),
    );
    const out = await action(prev, form({ billId: BILL, idempotencyKey: KEY }));
    expect(out.key).toBe(KEY);
  });
});

describe('void a bill', () => {
  it('needs a reason and does not call the API without one', async () => {
    const out = await voidBillAction(
      prev,
      form({ billId: BILL, idempotencyKey: KEY, reason: '  ' }),
    );
    expect(out.errors?.['reason']).toBeTruthy();
    expect(out.key).toBe(KEY);
    expect(api.voidBill).not.toHaveBeenCalled();
  });

  it('sends the trimmed reason', async () => {
    api.voidBill.mockResolvedValue({ id: BILL });
    const out = await voidBillAction(
      prev,
      form({ billId: BILL, idempotencyKey: KEY, reason: ' Wrong vendor ' }),
    );
    expect(api.voidBill).toHaveBeenCalledWith(expect.anything(), BILL, 'Wrong vendor', KEY);
    expect(out.done).toMatch(/voided/i);
  });

  it('words a bill that already has a payment', async () => {
    api.voidBill.mockRejectedValue(apiError(409, 'BILL_HAS_ALLOCATIONS'));
    const out = await voidBillAction(
      prev,
      form({ billId: BILL, idempotencyKey: KEY, reason: 'x' }),
    );
    expect(out.error).toMatch(/payment/i);
  });
});

describe('convert a submission', () => {
  const lineFields = (over: Record<string, string> = {}) => ({
    submissionId: SUB,
    idempotencyKey: KEY,
    lineCount: '2',
    'line:0:poLineId': POLINE,
    'line:0:accountId': ACCOUNT,
    'line:0:quantity': '2',
    'line:0:unitPrice': '1000.50',
    'line:0:taxCodeId': TAX,
    // a second row nobody filled in
    'line:1:poLineId': '',
    ...over,
  });

  it('marks only the sent line when the API refuses its expense account', async () => {
    api.convertBillSubmission.mockRejectedValue(apiError(422, 'EXPENSE_ACCOUNT_INVALID'));
    const out = await convertSubmissionAction(prev, form(lineFields()));
    expect(out.errors).toEqual({ '0.accountId': EXPENSE_ACCOUNT_REFUSED });
    expect(out.key).not.toBe(KEY);
  });

  it('still marks the sent line when its account looked active on the page (retired since)', async () => {
    api.convertBillSubmission.mockRejectedValue(apiError(422, 'EXPENSE_ACCOUNT_INVALID'));
    const out = await convertSubmissionAction(
      prev,
      form(lineFields({ activeAccountIds: ACCOUNT })),
    );
    expect(out.errors).toEqual({ '0.accountId': EXPENSE_ACCOUNT_REFUSED });
  });

  it('sends only the lines, as typed, and goes to the new bill', async () => {
    api.convertBillSubmission.mockResolvedValue({ id: BILL });
    await expect(convertSubmissionAction(prev, form(lineFields()))).rejects.toThrow(
      `REDIRECT /payables/bills/${BILL}?created=1`,
    );
    expect(api.convertBillSubmission).toHaveBeenCalledWith(
      expect.anything(),
      SUB,
      [
        {
          poLineId: POLINE,
          accountId: ACCOUNT,
          quantity: '2',
          unitPrice: '1000.5',
          taxCodeId: TAX,
        },
      ],
      KEY,
    );
  });

  it('keeps the key and the typing when a field is wrong, and never calls the API', async () => {
    const out = await convertSubmissionAction(prev, form(lineFields({ 'line:0:quantity': '0' })));
    expect(out.key).toBe(KEY);
    expect(out.errors?.['0.quantity']).toBeTruthy();
    expect(api.convertBillSubmission).not.toHaveBeenCalled();
  });

  it('refuses a form with no usable line count', async () => {
    const out = await convertSubmissionAction(prev, form(lineFields({ lineCount: 'many' })));
    expect(out.reload).toBe(true);
    expect(api.convertBillSubmission).not.toHaveBeenCalled();
  });

  it('words a duplicate invoice number and rotates the key', async () => {
    api.convertBillSubmission.mockRejectedValue(apiError(409, 'DUPLICATE_BILL'));
    const out = await convertSubmissionAction(prev, form(lineFields()));
    expect(out.error).toMatch(/already has a bill/i);
    expect(out.key).not.toBe(KEY);
  });

  it('follows the live grants: Procurement granted bill entry converts, an accountant without it cannot', async () => {
    session.roles = ['procurement'];
    grants.live = new Map([['payables.bill.enter', 'all']]);
    api.convertBillSubmission.mockResolvedValue({ id: BILL });
    await expect(convertSubmissionAction(prev, form(lineFields()))).rejects.toThrow(
      `REDIRECT /payables/bills/${BILL}?created=1`,
    );
    api.convertBillSubmission.mockClear();
    session.roles = ['accountant'];
    grants.live = new Map([['payables.bill.read', 'all']]);
    expect((await convertSubmissionAction(prev, form(lineFields()))).error).toMatch(/roles/i);
    expect(api.convertBillSubmission).not.toHaveBeenCalled();
  });
});

describe('reject a submission', () => {
  it('needs a reason', async () => {
    const out = await rejectSubmissionAction(
      prev,
      form({ submissionId: SUB, idempotencyKey: KEY }),
    );
    expect(out.errors?.['reason']).toBeTruthy();
    expect(api.rejectBillSubmission).not.toHaveBeenCalled();
  });

  it('sends the reason and says it was rejected', async () => {
    api.rejectBillSubmission.mockResolvedValue({
      id: SUB,
      status: 'rejected',
      rejectionReason: 'x',
    });
    const out = await rejectSubmissionAction(
      prev,
      form({ submissionId: SUB, idempotencyKey: KEY, reason: 'Not ours' }),
    );
    expect(api.rejectBillSubmission).toHaveBeenCalledWith(expect.anything(), SUB, 'Not ours', KEY);
    expect(out.done).toMatch(/rejected/i);
  });

  it('says a submission someone already handled is handled', async () => {
    api.rejectBillSubmission.mockRejectedValue(apiError(409, 'SUBMISSION_NOT_RECEIVED'));
    const out = await rejectSubmissionAction(
      prev,
      form({ submissionId: SUB, idempotencyKey: KEY, reason: 'x' }),
    );
    expect(out.error).toMatch(/already handled/i);
    expect(out.reload).toBe(true);
  });
});

// Every bill and submission action decides on the live grants (GET /v1/me), not role defaults.
describe.each([
  ['match', matchBillAction, api.matchBill, { billId: BILL }],
  ['submit', submitBillAction, api.submitBill, { billId: BILL }],
  ['void', voidBillAction, api.voidBill, { billId: BILL, reason: 'Wrong vendor' }],
  ['discard', discardBillAction, api.discardBill, { billId: BILL }],
  [
    'exception',
    requestExceptionAction,
    api.requestBillException,
    { billId: BILL, reason: 'Agreed' },
  ],
  ['reject', rejectSubmissionAction, api.rejectBillSubmission, { submissionId: SUB, reason: 'x' }],
] as const)('%s follows the live grants', (_name, action, call, fields) => {
  it('lets Procurement act once an admin granted payables.bill.enter', async () => {
    session.roles = ['procurement'];
    grants.live = new Map([['payables.bill.enter', 'all']]);
    call.mockResolvedValue({ id: BILL, matchStatus: 'matched', approvalRequestId: SUB });
    const out = await action(prev, form({ ...fields, idempotencyKey: KEY }));
    expect(out.error).toBeUndefined();
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('refuses an accountant whose payables.bill.enter was removed, before any call', async () => {
    grants.live = new Map([['payables.bill.read', 'all']]);
    const out = await action(prev, form({ ...fields, idempotencyKey: KEY }));
    expect(out.error).toMatch(/roles/i);
    expect(call).not.toHaveBeenCalled();
  });
});
