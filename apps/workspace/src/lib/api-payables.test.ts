import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import { __resetEnvForTests } from '@/lib/env';
import type { Session } from '@/lib/session';

import {
  convertBillSubmission,
  getBill,
  listBillSubmissions,
  listBills,
  matchBill,
  rejectBillSubmission,
  submitBill,
  voidBill,
  discardBill,
} from './api-payables';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const BILL = '11111111-1111-4111-8111-111111111111';
const VENDOR = '22222222-2222-4222-8222-222222222222';
const LINE = '33333333-3333-4333-8333-333333333333';
const SUB = '44444444-4444-4444-8444-444444444444';
const DOC = '55555555-5555-4555-8555-555555555555';
const KEY = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const session: Session = {
  id: 'A'.repeat(43),
  sub: 'user-1',
  orgId: BILL,
  orgKind: 'staff',
  roles: ['accountant'],
  accessToken: 'eyJ.secret-access-token.sig',
  accessExp: 2_000_000_000,
  createdAt: 1_700_000_000,
  lastSeenAt: 1_700_000_000,
};

const billLine = {
  id: LINE,
  lineNo: 1,
  poLineId: LINE,
  receiptLineId: null,
  description: 'Laptop',
  accountId: VENDOR,
  quantity: '2.0000',
  unitPrice: '1000.00',
  netAmount: '2000.00',
  taxCodeId: VENDOR,
  vatAmount: '260.00',
  tdsCodeId: null,
  tdsAmount: '0.00',
  match: {
    runNo: 1,
    status: 'variance',
    receivedQuantity: null,
    billedQuantity: '2.0000',
    quantityVariance: '0.0000',
    priceVariance: '100.00',
    taxVariance: '0.00',
  },
};
const header = {
  id: BILL,
  kind: 'bill',
  number: null,
  vendorPartyId: VENDOR,
  vendorName: 'Himal Traders',
  vendorInvoiceNo: 'INV-001',
  invoiceDate: '2026-11-08',
  fiscalYear: '2083/84',
  currency: 'NPR',
  purchaseOrderId: null,
  documentId: DOC,
  status: 'variance',
  matchStatus: 'variance',
  netTotal: '2000.00',
  vatTotal: '260.00',
  tdsTotal: '0.00',
  payableTotal: '2260.00',
  enteredBy: VENDOR,
  approvalRequestId: null,
  version: 2,
};
const bill = { ...header, lines: [billLine] };
const submission = {
  id: SUB,
  vendorPartyId: VENDOR,
  vendorName: 'Himal Traders',
  purchaseOrderId: null,
  vendorInvoiceNo: 'INV-001',
  invoiceDate: '2026-11-08',
  documentId: DOC,
  fileStatus: 'clean',
  note: null,
  status: 'received',
  receivedAt: '2026-11-08T05:45:00.000Z',
};

const fetchMock = vi.fn<typeof fetch>();
const reply = (body: unknown, status = 200): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });
const answer = (r: Response): void => {
  fetchMock.mockImplementation(() => Promise.resolve(r.clone()));
};
function lastCall() {
  const [url, init] = fetchMock.mock.calls.at(-1) ?? [];
  const requestInit = init ?? {};
  const href = url instanceof Request ? url.url : url instanceof URL ? url.href : (url ?? '');
  return { url: href, init: requestInit, headers: new Headers(requestInit.headers) };
}

const sentBody = (): unknown => JSON.parse(lastCall().init.body as string);

beforeEach(() => {
  vi.stubEnv('API_INTERNAL_URL', 'http://api:3001');
  for (const [k, v] of Object.entries({
    OIDC_ISSUER: 'https://auth.test',
    OIDC_CLIENT_ID: 'client-123',
    OIDC_REDIRECT_URI: 'https://app.test/auth/callback',
    OIDC_AUDIENCE: 'proj-42',
    WORKSPACE_PUBLIC_URL: 'https://app.test',
    VALKEY_URL: 'redis://valkey.test:6379',
    SESSION_ENC_KEY: Buffer.alloc(32, 5).toString('base64'),
  })) {
    vi.stubEnv(k, v);
  }
  __resetEnvForTests();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('bill reads', () => {
  it('lists with only the status the API accepts, and parses a row without lines', async () => {
    answer(reply([header]));
    const out = await listBills(session, 'variance');
    expect(out[0]?.vendorInvoiceNo).toBe('INV-001');
    expect(lastCall().url).toBe('http://api:3001/v1/payables/bills?status=variance');
    expect(lastCall().headers.get('authorization')).toBe('Bearer eyJ.secret-access-token.sig');
    answer(reply([]));
    await listBills(session);
    expect(lastCall().url).toBe('http://api:3001/v1/payables/bills');
  });

  it('refuses a status the API would not take, before any call', () => {
    expect(() => listBills(session, 'bogus' as never)).toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps money as the server sent it and tolerates a line match with no received quantity', async () => {
    answer(reply(bill));
    const out = await getBill(session, BILL);
    expect(out.payableTotal).toBe('2260.00');
    expect(typeof out.lines[0]?.netAmount).toBe('string');
    expect(out.lines[0]?.match?.receivedQuantity).toBeNull();
  });

  it('accepts a match status it has not met (a new value is not a 502)', async () => {
    answer(
      reply({
        ...bill,
        lines: [{ ...billLine, match: { ...billLine.match, status: 'tolerated' } }],
      }),
    );
    const out = await getBill(session, BILL);
    expect(out.lines[0]?.match?.status).toBe('tolerated');
  });

  it('encodes the id so it cannot climb out of the route', async () => {
    answer(reply(bill));
    await getBill(session, '../x?y');
    expect(lastCall().url).toBe('http://api:3001/v1/payables/bills/..%2Fx%3Fy');
  });

  it('turns a body that drifts from the contract into a 502', async () => {
    answer(reply({ ...bill, status: 'moon' }));
    await expect(getBill(session, BILL)).rejects.toMatchObject({ status: 502 });
  });

  it('carries the API refusal through as an ApiError', async () => {
    answer(reply({ error: { code: 'not_found' } }, 404));
    await expect(getBill(session, BILL)).rejects.toBeInstanceOf(ApiError);
  });
});

describe('bill writes', () => {
  it('discards a draft with the idempotency key and parses the terminal status', async () => {
    answer(reply({ ...bill, status: 'discarded' }));
    expect((await discardBill(session, BILL, KEY)).status).toBe('discarded');
    expect(lastCall().url).toBe(`http://api:3001/v1/payables/bills/${BILL}/discard`);
    expect(lastCall().init.method).toBe('POST');
    expect(lastCall().headers.get('idempotency-key')).toBe(KEY);
    expect(lastCall().init.body).toBeUndefined();
  });
  it('matches and submits with the idempotency key and no body', async () => {
    answer(reply(bill));
    await matchBill(session, BILL, KEY);
    expect(lastCall().url).toBe(`http://api:3001/v1/payables/bills/${BILL}/match`);
    expect(lastCall().init.method).toBe('POST');
    expect(lastCall().headers.get('idempotency-key')).toBe(KEY);
    expect(lastCall().init.body).toBeUndefined();
    await submitBill(session, BILL, KEY);
    expect(lastCall().url).toBe(`http://api:3001/v1/payables/bills/${BILL}/submit`);
    expect(lastCall().headers.get('idempotency-key')).toBe(KEY);
  });

  it('voids with a reason', async () => {
    answer(reply({ ...bill, status: 'voided' }));
    const out = await voidBill(session, BILL, 'Wrong vendor', KEY);
    expect(out.status).toBe('voided');
    expect(lastCall().url).toBe(`http://api:3001/v1/payables/bills/${BILL}/void`);
    expect(sentBody()).toEqual({ reason: 'Wrong vendor' });
    expect(lastCall().headers.get('content-type')).toBe('application/json');
  });
});

describe('bill submissions', () => {
  it('lists the inbox', async () => {
    answer(
      reply([
        submission,
        { ...submission, vendorPartyId: null, vendorName: null, fileStatus: null },
      ]),
    );
    const out = await listBillSubmissions(session);
    expect(out).toHaveLength(2);
    expect(lastCall().url).toBe('http://api:3001/v1/payables/bill-submissions');
  });

  it('converts with the lines only', async () => {
    answer(reply(bill, 201));
    const lines = [{ accountId: VENDOR, quantity: '2', unitPrice: '1000.00', taxCodeId: VENDOR }];
    await convertBillSubmission(session, SUB, lines, KEY);
    expect(lastCall().url).toBe(`http://api:3001/v1/payables/bill-submissions/${SUB}/convert`);
    expect(sentBody()).toEqual({ lines });
    expect(lastCall().headers.get('idempotency-key')).toBe(KEY);
  });

  it('rejects with a reason and reads the rejected row', async () => {
    answer(reply({ id: SUB, status: 'rejected', rejectionReason: 'Not ours' }));
    const out = await rejectBillSubmission(session, SUB, 'Not ours', KEY);
    expect(out.rejectionReason).toBe('Not ours');
    expect(lastCall().url).toBe(`http://api:3001/v1/payables/bill-submissions/${SUB}/reject`);
    expect(sentBody()).toEqual({ reason: 'Not ours' });
  });
});
