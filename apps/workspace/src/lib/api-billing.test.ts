import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from './api';
import {
  confirmSalesOrder,
  createCreditNote,
  createDebitNote,
  createManualInvoice,
  describeBillingFailure,
  discardInvoice,
  draftInvoiceFromSchedule,
  getInvoice,
  getSalesOrder,
  getSalesOrdersSummary,
  invoiceDocumentPath,
  issueInvoice,
  issueOutcomeMessage,
  keyAfterFailure,
  getInvoicesSummary,
  listInvoices,
  listInvoicesPage,
  listSalesOrders,
  listSalesOrdersPage,
  markScheduleLineBillable,
  submitInvoice,
} from './api-billing';
import type { Session } from './session';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  apiFetch: mocks.apiFetch,
}));

const session = { accessToken: 't' } as Session;
const ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER = '33333333-3333-4333-8333-333333333333';
const LINE = '55555555-5555-4555-8555-555555555555';
const TAX = '66666666-6666-4666-8666-666666666666';
const KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = '2026-11-08T05:45:00.000Z';

function answer(status: number, body: unknown): Promise<Response> {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return Promise.resolve(new Response(status === 204 ? null : text, { status }));
}

const lastCall = () => mocks.apiFetch.mock.calls.at(-1) as [unknown, string, RequestInit];

function invoiceDetail(over: Record<string, unknown> = {}) {
  return {
    invoice: {
      id: ID,
      kind: 'tax_invoice',
      status: 'draft',
      number: null,
      fiscalYear: null,
      customerId: CUSTOMER,
      salesOrderId: ID,
      scheduleLineId: LINE,
      originalInvoiceId: null,
      manualReason: null,
      noteReason: null,
      currency: 'NPR',
      totals: {
        subtotal: '1880000.00',
        discountAmount: '94000.00',
        taxableAmount: '1786000.00',
        exemptAmount: '0.00',
        zeroRatedAmount: '0.00',
        taxAmount: '232180.00',
        total: '2018180.00',
      },
      npr: null,
      issueDate: null,
      issueDateBs: null,
      dueDate: null,
      seller: null,
      buyer: null,
      calcVersion: 1,
      contentHash: null,
      approvalRequestId: null,
      version: 1,
      createdAt: NOW,
      updatedAt: NOW,
      ...over,
    },
    lines: [],
    taxSummary: [],
    prints: [],
  };
}

function salesOrderDetail() {
  return {
    order: {
      id: ID,
      number: 'SO-2083/84-00001',
      fiscalYear: '2083/84',
      customerId: CUSTOMER,
      quotationId: ID,
      quotationVersionId: ID,
      status: 'confirmed',
      currency: 'NPR',
      totals: {
        subtotal: '5045450.00',
        discountAmount: '0.00',
        taxableAmount: '5045450.00',
        taxAmount: '0.00',
        total: '5045450.00',
      },
      npr: { amountNpr: '5045450.00', rate: '1', rateSource: 'base', rateDate: '2026-11-08' },
      creditDays: 30,
      confirmedAt: NOW,
      version: 3,
      createdAt: NOW,
      updatedAt: NOW,
    },
    lines: [],
    schedule: [],
    evidence: [],
    deliveryReleased: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.apiFetch.mockImplementation(() => answer(200, []));
});

describe('reads', () => {
  it('lists sales orders with the filters the contract allows and drops everything else', async () => {
    await listSalesOrders(session, { status: 'confirmed', customerId: CUSTOMER });
    expect(lastCall()[1]).toBe(`/v1/sales-orders?status=confirmed&customerId=${CUSTOMER}`);

    await listSalesOrders(session, { status: 'bogus' as never, customerId: 'not-a-guid' });
    expect(lastCall()[1]).toBe('/v1/sales-orders');
  });

  it('pages sales orders: repeated filters, search and paging in the query, the total from the header', async () => {
    const other = '44444444-4444-4444-8444-444444444444';
    mocks.apiFetch.mockImplementation(() =>
      Promise.resolve(new Response('[]', { status: 200, headers: { 'X-Total-Count': '134' } })),
    );
    const page = await listSalesOrdersPage(session, {
      status: ['draft', 'confirmed', 'draft', 'bogus'],
      customerId: [CUSTOMER, other, 'not-a-guid'],
      q: '  acme ',
      limit: 25,
      offset: 50,
    });
    expect(page).toEqual({ items: [], total: 134 });
    expect(lastCall()[1]).toBe(
      `/v1/sales-orders?status=draft&status=confirmed&customerId=${CUSTOMER}&customerId=${other}&q=acme&limit=25&offset=50`,
    );

    await listSalesOrdersPage(session, {});
    expect(lastCall()[1]).toBe('/v1/sales-orders');
  });

  it('fails with 502 when the total header is missing or not a count', async () => {
    for (const headers of [{}, { 'X-Total-Count': 'many' }, { 'X-Total-Count': '-1' }]) {
      mocks.apiFetch.mockImplementation(() =>
        Promise.resolve(new Response('[]', { status: 200, headers })),
      );
      await expect(listSalesOrdersPage(session, {})).rejects.toMatchObject({ status: 502 });
    }
  });

  it('reads the sales order summary for the search and customers, and refuses a partial body', async () => {
    const byStatus = { draft: 1, confirmed: 2, completed: 3, cancelled: 4 };
    mocks.apiFetch.mockImplementation(() => answer(200, { total: 10, byStatus }));
    await expect(
      getSalesOrdersSummary(session, { q: 'acme', customerId: [CUSTOMER] }),
    ).resolves.toEqual({
      total: 10,
      byStatus,
    });
    expect(lastCall()[1]).toBe(`/v1/sales-orders/summary?customerId=${CUSTOMER}&q=acme`);
    mocks.apiFetch.mockImplementation(() => answer(200, { total: 1, byStatus: { draft: 1 } }));
    await expect(getSalesOrdersSummary(session)).rejects.toMatchObject({ status: 502 });
  });

  it('lists invoices by kind, status and customer', async () => {
    await listInvoices(session, { kind: 'credit_note', status: 'issued' });
    expect(lastCall()[1]).toBe('/v1/invoices?kind=credit_note&status=issued');

    await listInvoices(session, { kind: 'receipt' as never });
    expect(lastCall()[1]).toBe('/v1/invoices');
  });

  it('sends repeated filters, a search and a page, and reads the total from the header', async () => {
    const row = {
      id: ID,
      kind: 'tax_invoice',
      status: 'issued',
      number: 'INV-1',
      customerId: CUSTOMER,
      customerName: 'Acme',
      currency: 'NPR',
      total: '10.00',
      issueDate: '2026-11-08',
      dueDate: '2026-12-08',
    };
    mocks.apiFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify([row]), { status: 200, headers: { 'X-Total-Count': '41' } }),
      ),
    );
    const page = await listInvoicesPage(session, {
      status: ['issued', 'draft', 'issued', 'paid'],
      kind: ['proforma'],
      settlement: ['overdue', 'nope'],
      customerId: [CUSTOMER, 'not-an-id'],
      issuedFrom: '2026-11-01',
      issuedTo: 'soon',
      q: ' acme ',
      limit: 25,
      offset: 50,
    });
    expect(page.total).toBe(41);
    expect(page.items).toHaveLength(1);
    const url = new URL(lastCall()[1], 'http://x');
    expect(url.pathname).toBe('/v1/invoices');
    expect(url.searchParams.getAll('status')).toEqual(['issued', 'draft']);
    expect(url.searchParams.getAll('kind')).toEqual(['proforma']);
    expect(url.searchParams.getAll('settlement')).toEqual(['overdue']);
    expect(url.searchParams.getAll('customerId')).toEqual([CUSTOMER]);
    expect(url.searchParams.get('issuedFrom')).toBe('2026-11-01');
    expect(url.searchParams.has('issuedTo')).toBe(false);
    expect(url.searchParams.get('q')).toBe('acme');
    expect(url.searchParams.get('limit')).toBe('25');
    expect(url.searchParams.get('offset')).toBe('50');
  });

  it('passes on the money totals of every match from X-Money-Totals, or null without them', async () => {
    mocks.apiFetch.mockImplementation(() =>
      Promise.resolve(
        new Response('[]', {
          status: 200,
          headers: {
            'X-Total-Count': '0',
            'X-Money-Totals': '[{"currency":"NPR","amount":"150.00"}]',
          },
        }),
      ),
    );
    expect((await listInvoicesPage(session)).totals).toEqual([
      { currency: 'NPR', amount: '150.00' },
    ]);
    mocks.apiFetch.mockImplementation(() =>
      Promise.resolve(new Response('[]', { status: 200, headers: { 'X-Total-Count': '0' } })),
    );
    expect((await listInvoicesPage(session)).totals).toBeNull();
  });

  it('fails like a contract drift when the total header is missing or malformed', async () => {
    for (const headers of [{}, { 'X-Total-Count': 'many' }]) {
      mocks.apiFetch.mockImplementation(() =>
        Promise.resolve(new Response('[]', { status: 200, headers })),
      );
      await expect(listInvoicesPage(session)).rejects.toMatchObject({ status: 502 });
    }
  });

  it('reads the summary with the same filters but never the status or the paging', async () => {
    const body = {
      total: 3,
      byStatus: { draft: 1, submitted: 0, returned: 0, approved: 0, issued: 2, discarded: 0 },
      customers: [{ id: CUSTOMER, name: 'Acme' }],
    };
    mocks.apiFetch.mockImplementation(() => answer(200, body));
    const summary = await getInvoicesSummary(session, {
      q: 'acme',
      kind: ['proforma'],
      status: ['issued'],
      limit: 5,
    } as never);
    expect(summary.byStatus.issued).toBe(2);
    const url = new URL(lastCall()[1], 'http://x');
    expect(url.pathname).toBe('/v1/invoices/summary');
    expect(url.searchParams.get('q')).toBe('acme');
    expect(url.searchParams.getAll('kind')).toEqual(['proforma']);
    expect(url.searchParams.has('status')).toBe(false);
    expect(url.searchParams.has('limit')).toBe(false);
    mocks.apiFetch.mockImplementation(() => answer(200, { total: 1 }));
    await expect(getInvoicesSummary(session)).rejects.toMatchObject({ status: 502 });
  });

  it('encodes the id so ../ cannot climb out of the route', async () => {
    mocks.apiFetch.mockImplementation(() => answer(404, ''));
    await expect(getInvoice(session, '../x')).rejects.toBeInstanceOf(ApiError);
    expect(lastCall()[1]).toBe('/v1/invoices/..%2Fx');
    expect(invoiceDocumentPath('a/b')).toBe('/v1/invoices/a%2Fb/document');
  });

  it('parses a detail with the contract schema', async () => {
    mocks.apiFetch.mockImplementation(() => answer(200, invoiceDetail()));
    const detail = await getInvoice(session, ID);
    expect(detail.invoice.totals.total).toBe('2018180.00');
    mocks.apiFetch.mockImplementation(() => answer(200, salesOrderDetail()));
    expect((await getSalesOrder(session, ID)).order.number).toBe('SO-2083/84-00001');
  });

  it('answers 502 when the API drifts from the contract', async () => {
    mocks.apiFetch.mockImplementation(() => answer(200, { invoice: {} }));
    await expect(getInvoice(session, ID)).rejects.toMatchObject({ status: 502 });
  });

  it('keeps the status and the body of a refusal', async () => {
    const body = { error: { code: 'x', message: 'm', correlationId: 'c' } };
    mocks.apiFetch.mockImplementation(() => answer(403, body));
    await expect(listInvoices(session, {})).rejects.toMatchObject({ status: 403, body });
  });
});

describe('commands', () => {
  it('sends the key and a JSON body, and reads the created invoice', async () => {
    mocks.apiFetch.mockImplementation(() => answer(201, invoiceDetail()));
    const created = await createManualInvoice(
      session,
      {
        customerId: CUSTOMER,
        currency: 'NPR',
        manualReason: 'Legacy contract',
        lines: [
          { description: 'Setup', uom: 'job', quantity: '1', unitPrice: '1000.00', taxCodeId: TAX },
        ],
      },
      KEY,
    );
    expect(created.invoice.id).toBe(ID);
    const [, path, init] = lastCall();
    expect(path).toBe('/v1/invoices');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['idempotency-key']).toBe(KEY);
    expect(headers['content-type']).toBe('application/json');
    // The form sends no number, no date and no totals: the server owns them.
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(['currency', 'customerId', 'lines', 'manualReason']);
  });

  it('refuses a key that is not ours without calling the API', async () => {
    await expect(submitInvoice(session, ID, { expectedVersion: 1 }, 'x')).rejects.toThrow(/key/i);
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it('uses the documented path for each command', async () => {
    mocks.apiFetch.mockImplementation(() => answer(200, {}));
    await submitInvoice(session, ID, { expectedVersion: 2 }, KEY);
    expect(lastCall()[1]).toBe(`/v1/invoices/${ID}/submit`);
    await discardInvoice(session, ID, { expectedVersion: 2, reason: 'wrong customer' }, KEY);
    expect(lastCall()[1]).toBe(`/v1/invoices/${ID}/discard`);
    await markScheduleLineBillable(session, ID, LINE, { expectedVersion: 3 }, KEY);
    expect(lastCall()[1]).toBe(`/v1/sales-orders/${ID}/schedule-lines/${LINE}/mark-billable`);

    mocks.apiFetch.mockImplementation(() => answer(201, invoiceDetail()));
    await draftInvoiceFromSchedule(session, { scheduleLineId: LINE }, KEY);
    expect(lastCall()[1]).toBe('/v1/invoices/from-schedule');
    await createCreditNote(
      session,
      {
        originalInvoiceId: ID,
        reason: 'returned goods',
        lines: [{ originalLineNo: 1, quantity: '1' }],
      },
      KEY,
    );
    expect(lastCall()[1]).toBe('/v1/credit-notes');
    await createDebitNote(
      session,
      {
        originalInvoiceId: ID,
        reason: 'extra work',
        lines: [
          { description: 'Extra', uom: 'h', quantity: '2', unitPrice: '10.00', taxCodeId: TAX },
        ],
      },
      KEY,
    );
    expect(lastCall()[1]).toBe('/v1/debit-notes');
    mocks.apiFetch.mockImplementation(() => answer(200, salesOrderDetail()));
    await confirmSalesOrder(session, { quotationVersionId: ID, evidenceDocumentIds: [] }, KEY);
    expect(lastCall()[1]).toBe('/v1/sales-orders');
  });

  it('returns issued and already_issued as results, never as errors', async () => {
    mocks.apiFetch.mockImplementation(() =>
      answer(200, { kind: 'issued', invoiceId: ID, number: 'INV-2083/84-00001' }),
    );
    const first = await issueInvoice(session, ID, { expectedVersion: 4 }, KEY);
    expect(first.kind).toBe('issued');
    expect(lastCall()[1]).toBe(`/v1/invoices/${ID}/issue`);

    mocks.apiFetch.mockImplementation(() =>
      answer(200, { kind: 'already_issued', invoiceId: ID, number: 'INV-2083/84-00001' }),
    );
    const again = await issueInvoice(session, ID, { expectedVersion: 4 }, KEY);
    expect(again).toEqual({ kind: 'already_issued', invoiceId: ID, number: 'INV-2083/84-00001' });
    expect(issueOutcomeMessage(again)).toBe(
      'Already issued as INV-2083/84-00001. Nothing changed.',
    );
    expect(issueOutcomeMessage(first)).toBe('Issued as INV-2083/84-00001.');
  });

  it('answers 502 when issue returns something else', async () => {
    mocks.apiFetch.mockImplementation(() => answer(200, { kind: 'maybe' }));
    await expect(issueInvoice(session, ID, { expectedVersion: 4 }, KEY)).rejects.toMatchObject({
      status: 502,
    });
  });
});

function refusal(status: number, code: string, extra: Record<string, unknown> = {}): ApiError {
  return new ApiError(status, 'x', { error: { code, message: 'm', correlationId: 'c', ...extra } });
}

describe('describeBillingFailure', () => {
  it('shows an infected evidence file refusal in the API words (TR-Q12e)', () => {
    const message =
      'A virus was found in this file. Remove it or upload a clean copy, then try again.';
    const f = describeBillingFailure(refusal(409, 'document_infected', { message }));
    expect(f).toMatchObject({ kind: 'infected', message, reload: false, definite: true });
  });

  it('says plainly that the schedule line already has a draft, and does not ask for a reload', () => {
    const f = describeBillingFailure(refusal(409, 'SCHEDULE_LINE_TAKEN'));
    expect(f.kind).toBe('line_taken');
    expect(f.message).toMatch(/already has an invoice/i);
    expect(f.reload).toBe(false);
  });

  it('names a currency the company switched off (422), with the body the API sends today', () => {
    // Fails on the old code: every 422 read "The platform did not accept this".
    const f = describeBillingFailure(
      new ApiError(422, 'x', {
        error: {
          code: 'bad_request',
          message: 'Currency INR is not enabled for this company',
          correlationId: 'c',
        },
      }),
    );
    expect(f.kind).toBe('invalid');
    expect(f.definite).toBe(true);
    expect(f.message).toBe(
      'INR is switched off for your company. Choose another currency, or ask an administrator to switch it on in Settings.',
    );
  });

  it('names the currency and the rate date of a stale exchange rate', () => {
    const f = describeBillingFailure(
      refusal(409, 'fx_rate_stale', {
        details: { currency: 'USD', rateDate: '2026-10-01', maxAgeDays: 7 },
      }),
    );
    expect(f.kind).toBe('stale_fx');
    expect(f.message).toContain('USD');
    expect(f.message).toContain('2026-10-01');
    expect(f.message).toContain('7 days');
    expect(f.reload).toBe(false);
  });

  it('echoes nothing from details except a currency code, a date and a day count', () => {
    const f = describeBillingFailure(
      refusal(409, 'fx_rate_stale', { details: { currency: '<b>', rateDate: 'later' } }),
    );
    expect(f.message).not.toContain('<b>');
    expect(f.message).not.toContain('later');
    expect(f.message).toMatch(/exchange rate/i);
  });

  it('words NOT_APPROVED, PERIOD_FY_MISMATCH and evidence_policy_unmet', () => {
    expect(describeBillingFailure(refusal(409, 'NOT_APPROVED'))).toMatchObject({
      kind: 'not_approved',
      reload: true,
    });
    expect(describeBillingFailure(refusal(409, 'PERIOD_FY_MISMATCH')).message).toMatch(
      /fiscal year/i,
    );
    const evidence = describeBillingFailure(refusal(422, 'evidence_policy_unmet'));
    expect(evidence.kind).toBe('evidence');
    expect(evidence.message).toMatch(/evidence/i);
  });

  it('words a file that is not evidence of this order, and a missing one, without a reload (round 5 P2)', () => {
    // Fails on the old code: both read as the generic "The platform did not accept this".
    expect(describeBillingFailure(refusal(422, 'invalid_evidence_document'))).toMatchObject({
      kind: 'evidence',
      message: expect.stringMatching(/not evidence uploaded to this record/) as string,
      reload: false,
    });
    expect(describeBillingFailure(refusal(422, 'evidence_required')).message).toBe(
      'Upload the document that shows this step was done.',
    );
  });

  it('words a credit hold without a reload (F1-Q20/F1-Q26)', () => {
    // Fails on the old code: an unnamed 409 read as "the page is out of date".
    expect(describeBillingFailure(refusal(409, 'credit_hold'))).toMatchObject({
      kind: 'credit_hold',
      reload: false,
      definite: true,
    });
  });

  it('treats a stale row version as a reload, and an unnamed 409 the same way', () => {
    const f = describeBillingFailure(refusal(409, 'conflict'));
    expect(f).toMatchObject({ kind: 'stale', reload: true, definite: true });
  });

  it('keeps the kernel wording for 403 and 404, and treats a network failure as unknown', () => {
    expect(
      describeBillingFailure(refusal(403, 'forbidden', { reason: 'separation_of_duties' })).message,
    ).toMatch(/prepared this document/);
    expect(describeBillingFailure(refusal(404, 'not_found')).kind).toBe('not_found');
    const down = describeBillingFailure(new TypeError('fetch failed'));
    expect(down.definite).toBe(false);
    expect(down.kind).toBe('error');
  });
});

describe('keyAfterFailure (the Idempotency-Key the next try sends)', () => {
  it('keeps the key while the first request is still being processed', () => {
    const inProgress = new ApiError(409, 'x', {
      error: {
        code: 'conflict',
        message: 'A request with this Idempotency-Key is still being processed',
        correlationId: 'c',
      },
    });
    expect(keyAfterFailure(inProgress, KEY)).toBe(KEY);
  });

  it('keeps the key after a 5xx or a network failure, because the first call may have landed', () => {
    expect(keyAfterFailure(new ApiError(502, 'x'), KEY)).toBe(KEY);
    expect(keyAfterFailure(new TypeError('fetch failed'), KEY)).toBe(KEY);
  });

  it('rotates the key after a final answer such as SCHEDULE_LINE_TAKEN', () => {
    const next = keyAfterFailure(refusal(409, 'SCHEDULE_LINE_TAKEN'), KEY);
    expect(next).not.toBe(KEY);
    expect(next).toMatch(/^[A-Za-z0-9-]{8,64}$/);
  });
});
