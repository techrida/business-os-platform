import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  allocationRow,
  listItem,
  payment,
  PAYMENT_ID,
  verifiedPayment,
  CUSTOMER_ID,
} from '@/app/(app)/payments/_lib/fixtures';

import { ApiError } from './api';
import {
  allocatePayment,
  deallocate,
  getAging,
  getCustomerAdvance,
  getCustomerStatement,
  getPayment,
  getPaymentsSummary,
  listPaymentAllocations,
  listPayments,
  listPaymentsPage,
  rejectPayment,
  reversePayment,
  submitPayment,
  verifyPayment,
} from './api-receivables';
import type { Session } from './session';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  apiFetch: mocks.apiFetch,
}));

const session = { accessToken: 't' } as Session;
const KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function answer(status: number, body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}
const last = () => mocks.apiFetch.mock.calls.at(-1) as [unknown, string, RequestInit];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('payment reads', () => {
  it('lists payments as a bare array, with the status as a query', async () => {
    mocks.apiFetch.mockImplementation(() => answer(200, [listItem()]));
    const rows = await listPayments(session, 'verified');
    expect(last()[1]).toBe('/v1/payments?status=verified');
    expect(rows).toHaveLength(1);
    await listPayments(session);
    expect(last()[1]).toBe('/v1/payments');
  });

  it('sends repeated filters, a search and a page, and reads the total from the header', async () => {
    mocks.apiFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify([listItem()]), {
          status: 200,
          headers: { 'X-Total-Count': '12' },
        }),
      ),
    );
    const page = await listPaymentsPage(session, {
      status: ['verified', 'rejected', 'verified', 'bogus'],
      method: ['cash', 'card'],
      q: ' acme ',
      limit: 10,
      offset: 20,
    });
    expect(page.total).toBe(12);
    expect(page.items).toHaveLength(1);
    const url = new URL(last()[1], 'http://x');
    expect(url.pathname).toBe('/v1/payments');
    expect(url.searchParams.getAll('status')).toEqual(['verified', 'rejected']);
    expect(url.searchParams.getAll('method')).toEqual(['cash']);
    expect(url.searchParams.get('q')).toBe('acme');
    expect(url.searchParams.get('limit')).toBe('10');
    expect(url.searchParams.get('offset')).toBe('20');
  });

  it('fails like a contract drift when the total header is missing, and keeps a refusal status', async () => {
    mocks.apiFetch.mockImplementation(() => Promise.resolve(new Response('[]', { status: 200 })));
    await expect(listPaymentsPage(session)).rejects.toMatchObject({ status: 502 });
    mocks.apiFetch.mockImplementation(() => answer(403, { error: { code: 'forbidden' } }));
    await expect(listPaymentsPage(session)).rejects.toMatchObject({ status: 403 });
  });

  it('reads the summary with the method and search but never the status', async () => {
    const body = {
      total: 5,
      byStatus: { submitted: 2, verified: 3, rejected: 0, withdrawn: 0, reversed: 0 },
    };
    mocks.apiFetch.mockImplementation(() => answer(200, body));
    const summary = await getPaymentsSummary(session, {
      q: 'acme',
      method: ['qr'],
      status: ['verified'],
    } as never);
    expect(summary.byStatus.verified).toBe(3);
    const url = new URL(last()[1], 'http://x');
    expect(url.pathname).toBe('/v1/payments/summary');
    expect(url.searchParams.get('q')).toBe('acme');
    expect(url.searchParams.getAll('method')).toEqual(['qr']);
    expect(url.searchParams.has('status')).toBe(false);
  });

  it('fails loudly with 502 when the list drifts from the contract', async () => {
    mocks.apiFetch.mockImplementation(() => answer(200, [{ id: 'nope' }]));
    await expect(listPayments(session)).rejects.toMatchObject({ status: 502 });
  });

  it('encodes the id and carries the API status of a refusal', async () => {
    mocks.apiFetch.mockImplementation(() => answer(404, { error: { code: 'not_found' } }));
    await expect(getPayment(session, '../x')).rejects.toBeInstanceOf(ApiError);
    expect(last()[1]).toBe('/v1/payments/..%2Fx');
    await expect(getPayment(session, PAYMENT_ID)).rejects.toMatchObject({ status: 404 });
  });

  it('reads a payment and its allocations', async () => {
    mocks.apiFetch.mockImplementation(() => answer(200, payment()));
    expect((await getPayment(session, PAYMENT_ID)).status).toBe('submitted');
    mocks.apiFetch.mockImplementation(() => answer(200, [allocationRow()]));
    const rows = await listPaymentAllocations(session, PAYMENT_ID);
    expect(last()[1]).toBe(`/v1/payments/${PAYMENT_ID}/allocations`);
    expect(rows[0]?.amount).toBe('750000.00');
  });
});

describe('payment commands', () => {
  function sent() {
    const [, path, init] = last();
    return {
      path,
      method: init.method,
      key: (init.headers as Record<string, string>)['idempotency-key'],
      body: JSON.parse(init.body as string) as unknown,
    };
  }

  it('sends verify with the key and the version the person saw', async () => {
    mocks.apiFetch.mockImplementation(() => answer(200, verifiedPayment()));
    await verifyPayment(session, PAYMENT_ID, { expectedVersion: 3 }, KEY);
    expect(sent()).toEqual({
      path: `/v1/payments/${PAYMENT_ID}/verify`,
      method: 'POST',
      key: KEY,
      body: { expectedVersion: 3 },
    });
  });

  it('sends reject and reverse with their reasons', async () => {
    mocks.apiFetch.mockImplementation(() => answer(200, payment({ status: 'submitted' })));
    await rejectPayment(
      session,
      PAYMENT_ID,
      { expectedVersion: 3, reason: 'Slip unreadable' },
      KEY,
    );
    expect(sent().path).toBe(`/v1/payments/${PAYMENT_ID}/reject`);
    expect(sent().body).toEqual({ expectedVersion: 3, reason: 'Slip unreadable' });
    await reversePayment(
      session,
      PAYMENT_ID,
      { expectedVersion: 4, reason: 'Cheque bounced' },
      KEY,
    );
    expect(sent().path).toBe(`/v1/payments/${PAYMENT_ID}/reverse`);
  });

  it('sends the same key again when the caller retries with it', async () => {
    mocks.apiFetch.mockImplementationOnce(() => answer(502, {}));
    mocks.apiFetch.mockImplementationOnce(() => answer(200, verifiedPayment()));
    await expect(
      verifyPayment(session, PAYMENT_ID, { expectedVersion: 3 }, KEY),
    ).rejects.toMatchObject({ status: 502 });
    const first = sent().key;
    await verifyPayment(session, PAYMENT_ID, { expectedVersion: 3 }, KEY);
    expect(sent().key).toBe(first);
  });

  it('records a staff payment at /v1/payments', async () => {
    mocks.apiFetch.mockImplementation(() => answer(200, payment()));
    await submitPayment(
      session,
      {
        customerId: CUSTOMER_ID,
        currency: 'NPR',
        amount: '1000000.00',
        tdsWithheld: '0.00',
        method: 'cheque',
        receivedOn: '2026-11-05',
        proofDocumentIds: ['55555555-5555-4555-8555-555555555555'],
      },
      KEY,
    );
    expect(sent().path).toBe('/v1/payments');
  });

  it('allocates and deallocates at the payment', async () => {
    mocks.apiFetch.mockImplementation(() => answer(200, [allocationRow()]));
    await allocatePayment(
      session,
      PAYMENT_ID,
      { lines: [{ invoiceId: '66666666-6666-4666-8666-666666666666', amount: '750000.00' }] },
      KEY,
    );
    expect(sent().path).toBe(`/v1/payments/${PAYMENT_ID}/allocations`);
    mocks.apiFetch.mockImplementation(() =>
      answer(
        200,
        allocationRow({
          amount: '-750000.00',
          reversesAllocationId: 'a'.repeat(8) + '-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          reason: 'wrong invoice',
        }),
      ),
    );
    await deallocate(
      session,
      PAYMENT_ID,
      'b'.repeat(8) + '-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      { reason: 'wrong invoice' },
      KEY,
    );
    expect(sent().path).toBe(
      `/v1/payments/${PAYMENT_ID}/allocations/${'b'.repeat(8)}-bbbb-4bbb-8bbb-bbbbbbbbbbbb/reverse`,
    );
  });
});

describe('receivable reads', () => {
  it('reads the aging report with the server date', async () => {
    mocks.apiFetch.mockImplementation(() =>
      answer(200, { asOf: '2026-11-09', rows: [], totals: [] }),
    );
    const report = await getAging(session);
    expect(last()[1]).toBe('/v1/receivables/aging');
    expect(report.asOf).toBe('2026-11-09');
  });

  it('reads a statement and the advance of one customer', async () => {
    mocks.apiFetch.mockImplementation(() => answer(200, []));
    await getCustomerStatement(session, CUSTOMER_ID, { openOnly: true, currency: 'NPR' });
    expect(last()[1]).toBe(
      `/v1/receivables/customers/${CUSTOMER_ID}/statement?open=true&currency=NPR`,
    );
    await getCustomerStatement(session, CUSTOMER_ID);
    expect(last()[1]).toBe(`/v1/receivables/customers/${CUSTOMER_ID}/statement`);
    await getCustomerAdvance(session, CUSTOMER_ID);
    expect(last()[1]).toBe(`/v1/receivables/customers/${CUSTOMER_ID}/advance`);
  });
});
