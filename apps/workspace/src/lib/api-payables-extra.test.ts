import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, apiFetch } from './api';
import {
  cancelPaymentRequest,
  createPaymentRequest,
  getPaymentRequest,
  getVatRegister,
  listPaymentRequests,
  requestBillException,
  submitPaymentRequest,
} from './api-payables';
import type { Session } from './session';

vi.mock('server-only', () => ({}));
vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  apiFetch: vi.fn(),
}));

const id = '11111111-1111-4111-8111-111111111111';
const key = '22222222-2222-4222-8222-222222222222';
const session = { roles: ['finance'] } as Session;
const request = {
  id,
  number: null,
  vendorPartyId: id,
  paymentType: 'settlement',
  purchaseOrderId: null,
  currency: 'NPR',
  totalAmount: '111500.00',
  fromBankAccountId: id,
  vendorBankAccountId: id,
  bankLast4: '1234',
  status: 'draft',
  requestedBy: id,
  approvalRequestId: null,
  cancelReason: null,
  version: 1,
  lines: [{ id, lineNo: 1, openItemId: id, amount: '111500.00' }],
};
const input = {
  vendorPartyId: id,
  paymentType: 'settlement' as const,
  currency: 'NPR' as const,
  fromBankAccountId: id,
  allocations: [{ openItemId: id, amount: '111500.00' }],
};
const reply = (body: unknown, status = 200) =>
  vi
    .mocked(apiFetch)
    .mockImplementation(async () => new Response(JSON.stringify(body), { status }));

beforeEach(() => vi.clearAllMocks());

describe('payment request client', () => {
  it('reads the list without lines and validates its optional status', async () => {
    const { lines: _lines, ...row } = request;
    reply([row]);
    expect((await listPaymentRequests(session, 'draft'))[0]?.totalAmount).toBe('111500.00');
    expect(apiFetch).toHaveBeenLastCalledWith(
      session,
      '/v1/payables/payment-requests?status=draft',
      undefined,
    );
    expect(() => listPaymentRequests(session, 'other' as never)).toThrow();
  });

  it('encodes ids and keeps amounts and the bank snapshot as server values', async () => {
    reply(request);
    const result = await getPaymentRequest(session, '../private?x');
    expect(result.lines[0]?.amount).toBe('111500.00');
    expect(result.bankLast4).toBe('1234');
    expect(apiFetch).toHaveBeenCalledWith(
      session,
      '/v1/payables/payment-requests/..%2Fprivate%3Fx',
      undefined,
    );
  });

  it('creates with a required idempotency key and sends only the supplied body', async () => {
    reply(request, 201);
    await createPaymentRequest(session, input, key);
    expect(apiFetch).toHaveBeenCalledWith(session, '/v1/payables/payment-requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(input),
    });
  });

  it('submits and cancels through the existing command routes', async () => {
    reply({ ...request, status: 'pending_approval' });
    expect((await submitPaymentRequest(session, id, key)).status).toBe('pending_approval');
    expect(apiFetch).toHaveBeenLastCalledWith(
      session,
      `/v1/payables/payment-requests/${id}/submit`,
      {
        method: 'POST',
        headers: { 'idempotency-key': key },
      },
    );
    reply({ ...request, status: 'cancelled', cancelReason: 'Wrong invoice' });
    await cancelPaymentRequest(session, id, 'Wrong invoice', key);
    expect(apiFetch).toHaveBeenLastCalledWith(
      session,
      `/v1/payables/payment-requests/${id}/cancel`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({ reason: 'Wrong invoice' }),
      },
    );
  });

  it('preserves refusal codes and rejects a drifting response', async () => {
    reply({ code: 'OVER_ALLOCATION' }, 409);
    await expect(createPaymentRequest(session, input, key)).rejects.toMatchObject({
      status: 409,
      body: { code: 'OVER_ALLOCATION' },
    });
    reply({ ...request, totalAmount: 111500 });
    await expect(getPaymentRequest(session, id)).rejects.toBeInstanceOf(ApiError);
    await expect(getPaymentRequest(session, id)).rejects.toMatchObject({ status: 502 });
  });
});

it('requests a match exception with reason and optional evidence', async () => {
  const exception = {
    id,
    vendorBillId: id,
    reason: 'Price agreed',
    status: 'pending',
    requestedBy: id,
    decidedBy: null,
    approvalRequestId: id,
  };
  reply(exception, 201);
  expect(
    await requestBillException(
      session,
      id,
      { reason: 'Price agreed', evidenceDocumentId: id },
      key,
    ),
  ).toEqual(exception);
  expect(apiFetch).toHaveBeenCalledWith(session, `/v1/payables/bills/${id}/exceptions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify({ reason: 'Price agreed', evidenceDocumentId: id }),
  });
});

it('reads the VAT register with inclusive validated dates and server totals', async () => {
  const register = {
    from: '2026-11-01',
    to: '2026-11-30',
    rows: [],
    total: { taxableAmount: '100000.00', vatAmount: '13000.00' },
  };
  reply(register);
  expect(await getVatRegister(session, register.from, register.to)).toEqual(register);
  expect(apiFetch).toHaveBeenCalledWith(
    session,
    '/v1/payables/vat-register?from=2026-11-01&to=2026-11-30',
    undefined,
  );
  vi.clearAllMocks();
  expect(() => getVatRegister(session, '2026-11-30', '2026-11-01')).toThrow();
  expect(apiFetch).not.toHaveBeenCalled();
});
