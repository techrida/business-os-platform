import { CreditHoldDtoSchema, OpportunityDtoSchema } from '@bos/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { confirmOrderAction, draftInvoiceAction, markBillableAction } from './actions';
import { IDS, invoiceDetail, salesOrderDetail, scheduleLine } from './fixtures';
import type { ActionState } from './state';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireStaffSession: vi.fn(),
  apiFetch: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
  getOpportunity: vi.fn(),
  getCreditHold: vi.fn(),
  getPermissionCheck: vi.fn(),
}));

vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: mocks.apiFetch,
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@/components/p2/crm/crm-api', () => ({
  getOpportunity: mocks.getOpportunity,
  getCreditHold: mocks.getCreditHold,
}));
vi.mock('@/lib/display-settings', () => ({ getNumberSystems: () => Promise.resolve(undefined) }));
vi.mock('@/lib/live-permissions', () => ({ getPermissionCheck: mocks.getPermissionCheck }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));

const KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OPP = '11111111-1111-4111-8111-111111111111';

/** A deal as `GET /v1/opportunities/:id` sends it, through the contract (optional fields omitted). */
const dealDto = (over: Record<string, unknown> = {}) =>
  OpportunityDtoSchema.parse({
    id: OPP,
    number: 'DEAL-0042',
    name: 'Bridge works',
    customerId: '33333333-3333-4333-8333-333333333333',
    contactId: null,
    leadId: null,
    ownerUserId: null,
    ownerName: null,
    stage: 'negotiation',
    stageReason: null,
    lostReason: null,
    stageNote: null,
    value: null,
    currency: 'NPR',
    probability: null,
    expectedClose: null,
    wonQuotationVersionId: null,
    version: 1,
    createdAt: '2026-11-08T05:45:00.000Z',
    updatedAt: '2026-11-08T05:45:00.000Z',
    ...over,
  });
const prev: ActionState = { key: KEY };

function form(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.append(k, v);
  return f;
}

const confirmForm = (over: Record<string, string> = {}) =>
  form({
    idempotencyKey: KEY,
    quotationVersionId: IDS.version,
    evidenceDocumentIds: IDS.po,
    ...over,
  });
const markForm = (over: Record<string, string> = {}) =>
  form({
    idempotencyKey: KEY,
    salesOrderId: IDS.order,
    scheduleLineId: IDS.milestone,
    expectedVersion: '3',
    evidenceDocumentId: IDS.po,
    ...over,
  });
const draftForm = (over: Record<string, string> = {}) =>
  form({
    idempotencyKey: KEY,
    salesOrderId: IDS.order,
    scheduleLineId: IDS.advance,
    ...over,
  });

function answer(status: number, body: unknown = {}) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}
function refusal(status: number, code: string, message = 'm') {
  return answer(status, { error: { code, message, correlationId: 'c' } });
}
const IN_PROGRESS = () =>
  refusal(409, 'conflict', 'A request with this Idempotency-Key is still being processed');

type Call = [unknown, string, RequestInit];
const call = (n = 0) => mocks.apiFetch.mock.calls[n] as Call;
const keyOf = (c: Call) => (c[2].headers as Record<string, string>)['idempotency-key'];

async function redirectTarget(run: Promise<unknown>): Promise<string> {
  const err = await run.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  return (err as Error).message;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['accountant'] });
  mocks.apiFetch.mockImplementation(() => answer(200, salesOrderDetail()));
});

describe('confirmOrderAction', () => {
  it('posts the version id and the evidence ids with the page key, then opens the new order', async () => {
    const to = await redirectTarget(confirmOrderAction(prev, confirmForm()));
    expect(to).toBe(`NEXT_REDIRECT /sales-orders/${IDS.order}`);
    const [, path, init] = call();
    expect(path).toBe('/v1/sales-orders');
    expect(init.method).toBe('POST');
    expect(keyOf(call())).toBe(KEY);
    expect(JSON.parse(init.body as string)).toEqual({
      quotationVersionId: IDS.version,
      evidenceDocumentIds: [IDS.po],
    });
  });

  it('refuses an invalid form without calling the API and keeps the unused key', async () => {
    const state = await confirmOrderAction(prev, confirmForm({ quotationVersionId: '' }));
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(state.key).toBe(KEY);
    expect(state.errors?.quotation).toMatch(/Choose an accepted quotation/);
  });

  it('never forwards a key that is not ours', async () => {
    await redirectTarget(confirmOrderAction(prev, confirmForm({ idempotencyKey: 'x' })));
    expect(keyOf(call())).not.toBe('x');
    expect(keyOf(call())).toMatch(/^[A-Za-z0-9-]{8,64}$/);
  });

  it('says plainly that the evidence is missing on 422 evidence_policy_unmet, and rotates the key', async () => {
    mocks.apiFetch.mockImplementation(() => refusal(422, 'evidence_policy_unmet'));
    const state = await confirmOrderAction(prev, confirmForm({ evidenceDocumentIds: '' }));
    expect(state.error).toMatch(/evidence this step needs is missing/i);
    expect(state.reload).toBeUndefined();
    expect(state.key).not.toBe(KEY);
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it('asks for a reload on an unknown 409 and rotates the key', async () => {
    mocks.apiFetch.mockImplementation(() => refusal(409, 'conflict'));
    const state = await confirmOrderAction(prev, confirmForm());
    expect(state.reload).toBe(true);
    expect(state.key).not.toBe(KEY);
  });

  it('keeps the key while the first click is still being processed (409 in progress)', async () => {
    mocks.apiFetch.mockImplementation(IN_PROGRESS);
    const state = await confirmOrderAction(prev, confirmForm());
    expect(state.key).toBe(KEY);
    expect(state.error).toMatch(/still being processed/);
  });

  it('keeps the key after a 5xx or a network failure, and the next click reuses it', async () => {
    mocks.apiFetch.mockImplementationOnce(() => answer(502, {}));
    const first = await confirmOrderAction(prev, confirmForm());
    expect(first.key).toBe(KEY);

    mocks.apiFetch.mockImplementationOnce(() => Promise.reject(new TypeError('fetch failed')));
    const second = await confirmOrderAction(first, confirmForm({ idempotencyKey: first.key }));
    expect(second.key).toBe(KEY);

    await redirectTarget(confirmOrderAction(second, confirmForm({ idempotencyKey: second.key })));
    expect(mocks.apiFetch.mock.calls.map((c) => keyOf(c as Call))).toEqual([KEY, KEY, KEY]);
  });

  describe('a credit hold (409 credit_hold, F1-Q20)', () => {
    const deal = '11111111-1111-4111-8111-111111111111';
    const held = (opportunityId: string = deal) =>
      answer(409, {
        error: {
          code: 'credit_hold',
          message: 'm',
          correlationId: 'c',
          details: { opportunityId },
        },
      });
    const grants = (...held: string[]) =>
      mocks.getPermissionCheck.mockResolvedValue((p: string) => held.includes(p));

    beforeEach(() => {
      mocks.getOpportunity.mockReset();
      mocks.getCreditHold.mockReset();
      mocks.getCreditHold.mockRejectedValue(new Error('403'));
      mocks.getPermissionCheck.mockReset();
    });

    it('lets a credit.override holder who cannot open the deal override it from the refusal', async () => {
      mocks.apiFetch.mockImplementation(() => held());
      mocks.getOpportunity.mockRejectedValue(new Error('404'));
      grants('sales_order.confirm', 'credit.override');
      const state = await confirmOrderAction(prev, confirmForm());
      expect(state.error).toMatch(/over its credit limit/);
      expect(state.reload).toBeUndefined();
      expect(state.creditHold).toEqual({
        opportunityId: deal,
        number: null,
        canOpen: false,
        canOverride: true,
        quotationVersionId: IDS.version,
      });
      expect(mocks.getOpportunity).toHaveBeenCalledWith(expect.anything(), deal);
      expect(mocks.redirect).not.toHaveBeenCalled();
    });

    it('gives a credit.override holder the position the hold is made of, so the dialog shows the amounts (R5 FU4)', async () => {
      mocks.apiFetch.mockImplementation(() => held());
      mocks.getOpportunity.mockResolvedValue(dealDto({ id: deal }));
      mocks.getCreditHold.mockResolvedValue(
        CreditHoldDtoSchema.parse({
          opportunityId: deal,
          customerId: '22222222-2222-4222-8222-222222222222',
          currency: 'NPR',
          creditLimit: '150000.00',
          exposure: '0.00',
          uninvoiced: '90400.00',
          orderValue: '90400.00',
          exposureWithOrder: '180800.00',
          held: true,
          override: {
            reason: 'Paid',
            byUserId: '33333333-3333-4333-8333-333333333333',
            byName: 'Gita Karki',
            at: '2026-11-20T05:45:00.000Z',
            orderValue: '5000.00',
          },
          overrideCovers: false,
        }),
      );
      grants('sales_order.confirm', 'credit.override');
      const state = await confirmOrderAction(prev, confirmForm());
      expect(mocks.getCreditHold).toHaveBeenCalledWith(expect.anything(), deal);
      const position = state.creditHold?.position;
      expect(position?.rows.map((row) => row.label)).toEqual([
        'Credit limit',
        'Open receivables',
        'Confirmed orders not yet invoiced',
        'This order',
        'Total against the limit',
      ]);
      expect(position?.rows.at(-1)?.value).toContain('1,80,800.00');
      expect(position?.note).toContain('5,000.00');
    });

    it('names the deal for someone who can open it, without an override they do not hold', async () => {
      mocks.apiFetch.mockImplementation(() => held());
      mocks.getOpportunity.mockResolvedValue(dealDto({ id: deal }));
      grants('sales_order.confirm');
      const state = await confirmOrderAction(prev, confirmForm());
      expect(state.creditHold).toEqual({
        opportunityId: deal,
        number: 'DEAL-0042',
        canOpen: true,
        canOverride: false,
        quotationVersionId: IDS.version,
      });
    });

    it('carries no deal when the refusal names no usable id', async () => {
      mocks.apiFetch.mockImplementation(() => held('../x'));
      const state = await confirmOrderAction(prev, confirmForm());
      expect(state.error).toMatch(/over its credit limit/);
      expect(state).not.toHaveProperty('creditHold');
      expect(mocks.getOpportunity).not.toHaveBeenCalled();
    });
  });

  it('says plainly when the customer evidence is not confirmed yet (422 evidence_not_confirmed)', async () => {
    mocks.apiFetch.mockImplementation(() => refusal(422, 'evidence_not_confirmed'));
    const state = await confirmOrderAction(prev, confirmForm());
    expect(state.error).toMatch(/evidence for the accepted quotation has not been confirmed/);
    expect(state.error).not.toMatch(/did not accept this/);
    expect(state.key).not.toBe(KEY);
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it('points to the waiting draft of another revision (409 draft_of_other_revision)', async () => {
    mocks.apiFetch.mockImplementation(() => refusal(409, 'draft_of_other_revision'));
    const state = await confirmOrderAction(prev, confirmForm());
    expect(state.error).toMatch(/draft order from another revision/);
    expect(state.reload).toBeUndefined();
  });

  it('words a 403 and does not reload', async () => {
    mocks.apiFetch.mockImplementation(() => refusal(403, 'forbidden'));
    const state = await confirmOrderAction(prev, confirmForm());
    expect(state.error).toBeTruthy();
    expect(state.done).toBeUndefined();
  });
});

describe('markBillableAction', () => {
  it('posts the document and the order version to the line, and says it is done', async () => {
    const state = await markBillableAction(prev, markForm());
    expect(state).toEqual({ key: KEY, done: true });
    const [, path, init] = call();
    expect(path).toBe(
      `/v1/sales-orders/${IDS.order}/schedule-lines/${IDS.milestone}/mark-billable`,
    );
    expect(keyOf(call())).toBe(KEY);
    expect(JSON.parse(init.body as string)).toEqual({
      evidenceDocumentId: IDS.po,
      expectedVersion: 3,
    });
  });

  it('refuses a form with no document before the API is called', async () => {
    const state = await markBillableAction(prev, markForm({ evidenceDocumentId: '' }));
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(state.errors?.document).toBe('Upload the document that shows this step was done.');
    expect(state.key).toBe(KEY);
  });

  it('posts an uploaded file as the evidence when one was uploaded', async () => {
    await markBillableAction(prev, markForm({ otherDocumentId: IDS.contract }));
    const [, , init] = call();
    expect(JSON.parse(init.body as string)).toMatchObject({ evidenceDocumentId: IDS.contract });
  });

  it('words a file that is not evidence of this order, and an infected file, plainly', async () => {
    mocks.apiFetch.mockImplementationOnce(() => refusal(422, 'invalid_evidence_document'));
    const foreign = await markBillableAction(prev, markForm({ otherDocumentId: IDS.contract }));
    expect(foreign.error).toMatch(/not evidence uploaded to this record/);
    expect(foreign.reload).toBeUndefined();

    const virus =
      'A virus was found in this file. Remove it or upload a clean copy, then try again.';
    mocks.apiFetch.mockImplementationOnce(() => refusal(409, 'document_infected', virus));
    const infected = await markBillableAction(prev, markForm({ otherDocumentId: IDS.contract }));
    expect(infected.error).toBe(virus);
    expect(infected.reload).toBeUndefined();
  });

  it('asks for a reload on 409 because the order version moved, and rotates the key', async () => {
    mocks.apiFetch.mockImplementation(() => refusal(409, 'conflict'));
    const state = await markBillableAction(prev, markForm());
    expect(state.reload).toBe(true);
    expect(state.key).not.toBe(KEY);
    expect(state.done).toBeUndefined();
  });

  it('shows the evidence message on 422 and keeps the key on the in-progress 409', async () => {
    mocks.apiFetch.mockImplementationOnce(() => refusal(422, 'evidence_policy_unmet'));
    const refused = await markBillableAction(prev, markForm());
    expect(refused.error).toMatch(/evidence this step needs is missing/i);

    mocks.apiFetch.mockImplementationOnce(IN_PROGRESS);
    const waiting = await markBillableAction(prev, markForm());
    expect(waiting.key).toBe(KEY);
  });
});

describe('draftInvoiceAction', () => {
  /** The order as read again after the draft: the line holds the invoice, openable or not. */
  const drafted = (openInvoice: boolean) =>
    salesOrderDetail({
      schedule: [
        scheduleLine({
          id: IDS.advance,
          seq: 1,
          status: 'drafted',
          invoiceId: IDS.invoice,
          can: { openInvoice },
        }),
      ],
    });

  it('drafts from the line with the page key, then opens the invoice', async () => {
    mocks.apiFetch.mockImplementation((_s: unknown, path: string) =>
      path === '/v1/invoices/from-schedule'
        ? answer(200, invoiceDetail())
        : answer(200, drafted(true)),
    );
    const to = await redirectTarget(draftInvoiceAction(prev, draftForm()));
    expect(to).toBe(`NEXT_REDIRECT /invoices/${IDS.invoice}`);
    const [, path, init] = call();
    expect(path).toBe('/v1/invoices/from-schedule');
    expect(keyOf(call())).toBe(KEY);
    expect(JSON.parse(init.body as string)).toEqual({ scheduleLineId: IDS.advance });
  });

  it('SCHEDULE_LINE_TAKEN names the invoice already drafted for the line, found by reading the order again', async () => {
    mocks.apiFetch.mockImplementation((_s: unknown, path: string) =>
      path === '/v1/invoices/from-schedule'
        ? refusal(409, 'SCHEDULE_LINE_TAKEN')
        : answer(200, drafted(true)),
    );
    const state = await draftInvoiceAction(prev, draftForm());
    expect(state.error).toMatch(/already has an invoice/i);
    expect(state.takenInvoiceId).toBe(IDS.invoice);
    expect(state.reload).toBeUndefined();
    expect(state.key).not.toBe(KEY);
    expect(call(1)[1]).toBe(`/v1/sales-orders/${IDS.order}`);
  });

  // Someone whose live grants hold invoice.draft but not invoice.read: the API marks the line's invoice as
  // not openable for them (can.openInvoice false).
  describe('for someone who may draft invoices but not read them', () => {
    it('returns to the order with the drafted notice instead of opening an invoice they cannot read', async () => {
      mocks.apiFetch.mockImplementation((_s: unknown, path: string) =>
        path === '/v1/invoices/from-schedule'
          ? answer(200, invoiceDetail())
          : answer(200, drafted(false)),
      );
      const to = await redirectTarget(draftInvoiceAction(prev, draftForm()));
      expect(to).toBe(`NEXT_REDIRECT /sales-orders/${IDS.order}?drafted=1`);
      expect(to).not.toContain(IDS.invoice);
      expect(mocks.revalidatePath).toHaveBeenCalledWith(`/sales-orders/${IDS.order}`);
    });

    it('returns to the order when the order cannot be read again after the draft', async () => {
      mocks.apiFetch.mockImplementation((_s: unknown, path: string) =>
        path === '/v1/invoices/from-schedule' ? answer(200, invoiceDetail()) : answer(500, {}),
      );
      const to = await redirectTarget(draftInvoiceAction(prev, draftForm()));
      expect(to).toBe(`NEXT_REDIRECT /sales-orders/${IDS.order}?drafted=1`);
    });

    it('SCHEDULE_LINE_TAKEN offers no link to the invoice, only a reload, and names no invoice id', async () => {
      mocks.apiFetch.mockImplementation((_s: unknown, path: string) =>
        path === '/v1/invoices/from-schedule'
          ? refusal(409, 'SCHEDULE_LINE_TAKEN')
          : answer(200, drafted(false)),
      );
      const state = await draftInvoiceAction(prev, draftForm());
      expect(state.error).toMatch(/already has an invoice/i);
      expect(state.takenInvoiceId).toBeUndefined();
      expect(state.reload).toBe(true);
      expect(JSON.stringify(state)).not.toContain(IDS.invoice);
    });
  });

  it('SCHEDULE_LINE_TAKEN falls back to a reload when the line shows no invoice or the order cannot be read', async () => {
    mocks.apiFetch.mockImplementation((_s: unknown, path: string) =>
      path === '/v1/invoices/from-schedule'
        ? refusal(409, 'SCHEDULE_LINE_TAKEN')
        : answer(200, salesOrderDetail()),
    );
    const noInvoice = await draftInvoiceAction(prev, draftForm());
    expect(noInvoice.takenInvoiceId).toBeUndefined();
    expect(noInvoice.reload).toBe(true);

    mocks.apiFetch.mockImplementation((_s: unknown, path: string) =>
      path === '/v1/invoices/from-schedule' ? refusal(409, 'SCHEDULE_LINE_TAKEN') : answer(500, {}),
    );
    const unreadable = await draftInvoiceAction(prev, draftForm());
    expect(unreadable.takenInvoiceId).toBeUndefined();
    expect(unreadable.reload).toBe(true);
    expect(unreadable.error).toMatch(/already has an invoice/i);
  });

  it('keeps the key while the first click is processing, and after a network failure', async () => {
    mocks.apiFetch.mockImplementationOnce(IN_PROGRESS);
    expect((await draftInvoiceAction(prev, draftForm())).key).toBe(KEY);
    mocks.apiFetch.mockImplementationOnce(() => Promise.reject(new TypeError('fetch failed')));
    expect((await draftInvoiceAction(prev, draftForm())).key).toBe(KEY);
  });

  it('refuses a form that lost its ids without calling the API', async () => {
    const state = await draftInvoiceAction(prev, draftForm({ scheduleLineId: '' }));
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(state.reload).toBe(true);
  });
});
