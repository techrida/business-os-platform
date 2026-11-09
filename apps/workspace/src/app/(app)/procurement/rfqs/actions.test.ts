import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));
const session = vi.hoisted(() => ({ roles: ['procurement'] as string[] }));
vi.mock('@/lib/bff', () => ({
  requireStaffSession: () => Promise.resolve({ roles: session.roles }),
}));
const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
vi.mock('next/cache', () => cache);
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
}));

const api = vi.hoisted(() => ({
  createRfq: vi.fn(),
  recordQuotation: vi.fn(),
  convertSubmission: vi.fn(),
}));
vi.mock('@/lib/api-rfqs', () => api);

const { createRfqAction, recordQuotationAction } = await import('./actions');

const RFQ = '11111111-1111-4111-8111-111111111111';
const PR = '22222222-2222-4222-8222-222222222222';
const V1 = '33333333-3333-4333-8333-333333333333';
const V2 = '44444444-4444-4444-8444-444444444444';
const TAX = '55555555-5555-4555-8555-555555555555';
const DOC = '66666666-6666-4666-8666-666666666666';
const SUB = '77777777-7777-4777-8777-777777777777';
const LINE = '88888888-8888-4888-8888-888888888888';
const KEY = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const apiError = (status: number, code: string, message = 'The API wording.') =>
  new ApiError(status, 'x', { error: { code, message, correlationId: 'corr-12345678' } });

function form(entries: [string, string][]): FormData {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
}

const start = { key: KEY, errors: {} };
const rfqEntries: [string, string][] = [
  ['idempotencyKey', KEY],
  ['purchaseRequestId', PR],
  ['deadline', '2026-12-01T17:30'],
  ['vendorIds', V1],
  ['vendorIds', V2],
];
const quoteEntries: [string, string][] = [
  ['idempotencyKey', KEY],
  ['rfqId', RFQ],
  ['mode', 'record'],
  ['vendorId', V1],
  ['documentId', DOC],
  ['currency', 'NPR'],
  ['lines.0.include', 'on'],
  ['lines.0.prLineId', LINE],
  ['lines.0.quantity', '10'],
  ['lines.0.unitPrice', '450000.00'],
  ['lines.0.taxCodeId', TAX],
];

beforeEach(() => {
  vi.clearAllMocks();
  session.roles = ['procurement'];
});

describe('createRfqAction', () => {
  it('sends the contract body in Kathmandu time with the form key, then opens the RFQ', async () => {
    api.createRfq.mockResolvedValue({ id: RFQ });
    await expect(createRfqAction(start, form(rfqEntries))).rejects.toThrow(
      `redirect /procurement/rfqs/${RFQ}?created=1`,
    );
    expect(api.createRfq).toHaveBeenCalledWith(
      expect.anything(),
      { purchaseRequestId: PR, deadline: '2026-12-01T17:30:00+05:45', vendorIds: [V1, V2] },
      KEY,
    );
  });

  it('refreshes the RFQ list and the purchase request, which moves to sourcing', async () => {
    api.createRfq.mockResolvedValue({ id: RFQ });
    await createRfqAction(start, form(rfqEntries)).catch(() => undefined);
    const paths = cache.revalidatePath.mock.calls.map((c) => String(c[0]));
    expect(paths).toContain('/procurement/rfqs');
    expect(paths).toContain(`/procurement/requests/${PR}`);
  });

  it('does not call the API when the form is incomplete, and says what is missing', async () => {
    const r = await createRfqAction(start, form([['idempotencyKey', KEY]]));
    expect(api.createRfq).not.toHaveBeenCalled();
    expect(r.errors.vendorIds).toBeDefined();
    expect(r.key).toBe(KEY);
  });

  it('refuses a person without the sourcing grant before any call', async () => {
    session.roles = ['sales'];
    const r = await createRfqAction(start, form(rfqEntries));
    expect(api.createRfq).not.toHaveBeenCalled();
    expect(r.error).toMatch(/roles do not include/);
  });

  it('shows the API reason for an unapproved vendor and rotates the key', async () => {
    api.createRfq.mockRejectedValue(
      apiError(409, 'VENDOR_NOT_APPROVED', 'Vendor 3333 is not approved'),
    );
    const r = await createRfqAction(start, form(rfqEntries));
    expect(r.error).toContain('Vendor 3333 is not approved');
    expect(r.key).not.toBe(KEY);
  });

  it('a timeout, a 5xx and the in-progress 409 keep the key', async () => {
    api.createRfq.mockRejectedValue(new ApiError(503, 'x'));
    expect((await createRfqAction(start, form(rfqEntries))).key).toBe(KEY);
    api.createRfq.mockRejectedValue(
      apiError(409, 'conflict', 'A request with this Idempotency-Key is still in progress'),
    );
    const r = await createRfqAction(start, form(rfqEntries));
    expect(r.key).toBe(KEY);
    expect(r.reload).toBeFalsy();
  });
});

describe('recordQuotationAction', () => {
  it('records the quotation for the RFQ, sending no expectedVersion', async () => {
    api.recordQuotation.mockResolvedValue({ id: SUB });
    await expect(recordQuotationAction(start, form(quoteEntries))).rejects.toThrow(
      `redirect /procurement/rfqs/${RFQ}?quoted=1`,
    );
    const [, id, body, key] = api.recordQuotation.mock.calls[0] as unknown[];
    expect(id).toBe(RFQ);
    expect(key).toBe(KEY);
    expect(body).toEqual({
      vendorId: V1,
      documentId: DOC,
      currency: 'NPR',
      lines: [{ prLineId: LINE, quantity: '10', unitPrice: '450000.00', taxCodeId: TAX }],
    });
    expect(api.convertSubmission).not.toHaveBeenCalled();
  });

  it('converts a submission with the submission id and no vendor or document', async () => {
    api.convertSubmission.mockResolvedValue({ id: SUB });
    const entries = quoteEntries
      .filter(([k]) => k !== 'vendorId' && k !== 'documentId' && k !== 'mode')
      .concat([
        ['mode', 'convert'],
        ['submissionId', SUB],
      ]);
    await recordQuotationAction(start, form(entries)).catch(() => undefined);
    const [, id, body] = api.convertSubmission.mock.calls[0] as unknown[];
    expect(id).toBe(RFQ);
    expect(body).toHaveProperty('submissionId', SUB);
    expect(body).not.toHaveProperty('vendorId');
    expect(api.recordQuotation).not.toHaveBeenCalled();
  });

  it('an unscanned file (409) shows the API sentence and rotates the key', async () => {
    api.convertSubmission.mockRejectedValue(
      apiError(409, 'conflict', 'The submitted file has not scanned clean'),
    );
    const entries = quoteEntries
      .concat([['submissionId', SUB]])
      .map(([k, v]) =>
        k === 'mode' ? ([k, 'convert'] as [string, string]) : ([k, v] as [string, string]),
      );
    const r = await recordQuotationAction(start, form(entries));
    expect(r.error).toContain('has not scanned clean');
    expect(r.key).not.toBe(KEY);
  });

  it('keeps the key on a 5xx', async () => {
    api.recordQuotation.mockRejectedValue(new ApiError(502, 'x'));
    expect((await recordQuotationAction(start, form(quoteEntries))).key).toBe(KEY);
  });

  it('refuses a form without a real RFQ id and a person without the grant', async () => {
    const bad = quoteEntries.map(([k, v]) =>
      k === 'rfqId' ? ([k, 'nope'] as [string, string]) : ([k, v] as [string, string]),
    );
    const r = await recordQuotationAction(start, form(bad));
    expect(r.reload).toBe(true);
    session.roles = ['sales'];
    const r2 = await recordQuotationAction(start, form(quoteEntries));
    expect(r2.error).toMatch(/roles do not include/);
    expect(api.recordQuotation).not.toHaveBeenCalled();
  });

  it('shows field errors without calling the API', async () => {
    const entries = quoteEntries.map(([k, v]) =>
      k === 'lines.0.unitPrice' ? ([k, '1.234'] as [string, string]) : ([k, v] as [string, string]),
    );
    const r = await recordQuotationAction(start, form(entries));
    expect(r.errors['lines.0.unitPrice']).toMatch(/2 decimal places/);
    expect(api.recordQuotation).not.toHaveBeenCalled();
  });
});
