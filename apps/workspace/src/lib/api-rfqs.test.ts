import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import { __resetEnvForTests } from '@/lib/env';
import type { Session } from '@/lib/session';

import {
  commitRfq,
  convertSubmission,
  createRfq,
  getComparison,
  getRfq,
  listRfqsPage,
  listSubmissions,
  recommendQuotation,
  recordQuotation,
  scoreQuotation,
} from './api-rfqs';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const ID_C = '33333333-3333-4333-8333-333333333333';
const KEY = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const session: Session = {
  id: 'A'.repeat(43),
  sub: 'user-1',
  orgId: ID_A,
  orgKind: 'staff',
  roles: ['procurement'],
  accessToken: 'eyJ.secret-access-token.sig',
  accessExp: 2_000_000_000,
  createdAt: 1_700_000_000,
  lastSeenAt: 1_700_000_000,
};

const listItem = {
  id: ID_A,
  number: 'RFQ-2082/83-00001',
  purchaseRequestId: ID_B,
  purchaseRequestNumber: 'PR-2082/83-00001',
  status: 'open',
  deadline: '2026-12-01T10:00:00.000Z',
  invitedVendorCount: 3,
  quotationCount: 1,
};
const rfq = {
  id: ID_A,
  number: 'RFQ-2082/83-00001',
  purchaseRequestId: ID_B,
  deadline: '2026-12-01T10:00:00.000Z',
  status: 'open',
  vendorIds: [ID_B, ID_C],
  vendors: [
    { id: ID_B, name: 'Himal Traders' },
    { id: ID_C, name: 'Everest Supplies' },
  ],
  recommendedQuotationId: null,
  fewerThanThreeReason: null,
  recommendationRationale: null,
  commitmentApprovalRequestId: null,
  version: 1,
};
const quotation = {
  id: ID_C,
  rfqId: ID_A,
  vendorId: ID_B,
  currency: 'NPR',
  subtotal: '4500000.00',
  taxAmount: '585000.00',
  total: '5085000.00',
  fxRate: '1.000000',
  totalNpr: '5085000.00',
  deliveryDays: null,
  documentId: ID_A,
  vendorName: 'Himal Traders',
  lines: [],
  averageScore: null,
  scores: [],
};
const recordBody = {
  vendorId: ID_B,
  documentId: ID_A,
  currency: 'NPR' as const,
  lines: [{ prLineId: ID_B, quantity: '10', unitPrice: '450000.00', taxCodeId: ID_C }],
};

const fetchMock = vi.fn<typeof fetch>();
const reply = (b: unknown, status = 200): Response =>
  new Response(b === undefined ? null : JSON.stringify(b), { status });
const answer = (r: Response): void => {
  fetchMock.mockImplementation(() => Promise.resolve(r.clone()));
};
const bodyText = (init: RequestInit): string => (typeof init.body === 'string' ? init.body : '');
function lastCall() {
  const [url, init] = fetchMock.mock.calls.at(-1) ?? [];
  const requestInit = init ?? {};
  const href = url instanceof Request ? url.url : url instanceof URL ? url.href : (url ?? '');
  return { url: href, init: requestInit, headers: new Headers(requestInit.headers) };
}

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

describe('reads', () => {
  it('lists a page with repeated statuses, a search and an offset, and reads the total', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify([listItem]), {
          status: 200,
          headers: { 'x-total-count': '61' },
        }),
      ),
    );
    const out = await listRfqsPage(session, {
      status: ['open', 'closed'],
      q: 'RFQ-1',
      limit: 25,
      offset: 25,
    });
    expect(out.total).toBe(61);
    expect(lastCall().url).toBe(
      'http://api:3001/v1/procurement/rfqs?status=open&status=closed&q=RFQ-1&limit=25&offset=25',
    );
    expect(() =>
      listRfqsPage(session, { status: ['bogus' as never], limit: 25, offset: 0 }),
    ).toThrow();
  });

  it('turns a list row that breaks the contract into a 502', async () => {
    answer(reply([{ ...listItem, quotationCount: 'many' }]));
    await expect(listRfqsPage(session, { limit: 25, offset: 0 })).rejects.toMatchObject({
      status: 502,
    });
  });

  it('gets one RFQ, encoding the id so it cannot climb out of the route', async () => {
    answer(reply(rfq));
    await getRfq(session, ID_A);
    expect(lastCall().url).toBe(`http://api:3001/v1/procurement/rfqs/${ID_A}`);
    answer(reply(rfq));
    await getRfq(session, '../../admin');
    expect(lastCall().url).not.toContain('/../');
    expect(lastCall().url).toContain('..%2F..%2Fadmin');
  });

  it('keeps comparison money as the server wrote it', async () => {
    answer(
      reply([
        {
          ...quotation,
          averageScore: '82.50',
          scores: [{ criterion: 'price', score: '90.00', comment: null }],
        },
      ]),
    );
    const rows = await getComparison(session, ID_A);
    expect(rows[0]?.totalNpr).toBe('5085000.00');
    expect(rows[0]?.averageScore).toBe('82.50');
    expect(lastCall().url).toBe(`http://api:3001/v1/procurement/rfqs/${ID_A}/quotations`);
  });

  it('reads each quotation line as the server sent it, and refuses a drifted one (502)', async () => {
    const line = {
      id: ID_A,
      prLineId: ID_B,
      lineNo: 1,
      description: 'Laptop 14-inch',
      quantity: '10.0000',
      unitPrice: '450000.00',
      taxCode: 'VAT13',
      taxRateBp: 1300,
      gross: '4500000.00',
      taxAmount: '585000.00',
      lineTotal: '5085000.00',
    };
    answer(reply([{ ...quotation, lines: [line] }]));
    const rows = await getComparison(session, ID_A);
    expect(rows[0]?.lines[0]).toEqual(line);
    const { description: _gone, ...drifted } = line;
    answer(reply([{ ...quotation, lines: [drifted] }]));
    await expect(getComparison(session, ID_A)).rejects.toMatchObject({ status: 502 });
  });

  it('lists submissions with their scan status', async () => {
    answer(
      reply([
        {
          id: ID_A,
          vendorId: ID_B,
          vendorName: 'Himal Traders',
          vendorRef: null,
          submittedAt: '2026-11-08T05:45:00.000Z',
          documentId: ID_C,
          scanStatus: null,
        },
      ]),
    );
    const out = await listSubmissions(session, ID_A);
    expect(out[0]?.scanStatus).toBeNull();
    expect(lastCall().url).toBe(`http://api:3001/v1/procurement/rfqs/${ID_A}/submissions`);
  });
});

describe('writes carry the Idempotency-Key', () => {
  it('create posts the contract body with the key', async () => {
    answer(reply(rfq, 201));
    const body = {
      purchaseRequestId: ID_B,
      deadline: '2026-12-01T10:00:00+05:45',
      vendorIds: [ID_B, ID_C],
    };
    await createRfq(session, body, KEY);
    const { url, init, headers } = lastCall();
    expect(url).toBe('http://api:3001/v1/procurement/rfqs');
    expect(init.method).toBe('POST');
    expect(headers.get('idempotency-key')).toBe(KEY);
    expect(JSON.parse(bodyText(init))).toEqual(body);
  });

  it('record posts the quotation body to /quotations', async () => {
    answer(reply(quotation, 201));
    await recordQuotation(session, ID_A, recordBody, KEY);
    const { url, init, headers } = lastCall();
    expect(url).toBe(`http://api:3001/v1/procurement/rfqs/${ID_A}/quotations`);
    expect(headers.get('idempotency-key')).toBe(KEY);
    expect(JSON.parse(bodyText(init))).toEqual(recordBody);
  });

  it('convert posts to /quotations/convert with no vendor or document', async () => {
    answer(reply(quotation, 201));
    const body = { submissionId: ID_C, currency: 'NPR' as const, lines: recordBody.lines };
    await convertSubmission(session, ID_A, body, KEY);
    const { url, init, headers } = lastCall();
    expect(url).toBe(`http://api:3001/v1/procurement/rfqs/${ID_A}/quotations/convert`);
    expect(headers.get('idempotency-key')).toBe(KEY);
    expect(JSON.parse(bodyText(init))).toEqual(body);
  });

  it('score posts to the quotation and parses the refreshed comparison', async () => {
    answer(reply([quotation]));
    const body = { scores: [{ criterion: 'price', score: 90 }] };
    const out = await scoreQuotation(session, ID_A, ID_C, body, KEY);
    expect(out).toHaveLength(1);
    const { url, init, headers } = lastCall();
    expect(url).toBe(`http://api:3001/v1/procurement/rfqs/${ID_A}/quotations/${ID_C}/scores`);
    expect(headers.get('idempotency-key')).toBe(KEY);
    expect(JSON.parse(bodyText(init))).toEqual(body);
  });

  it('recommend posts the body, and commit posts an empty one, both keyed', async () => {
    answer(reply({ ...rfq, status: 'recommended', recommendedQuotationId: ID_C }));
    await recommendQuotation(session, ID_A, { vendorQuotationId: ID_C, rationale: 'Lowest' }, KEY);
    expect(lastCall().url).toBe(`http://api:3001/v1/procurement/rfqs/${ID_A}/recommendation`);
    expect(lastCall().headers.get('idempotency-key')).toBe(KEY);
    await commitRfq(session, ID_A, KEY);
    expect(lastCall().url).toBe(`http://api:3001/v1/procurement/rfqs/${ID_A}/commitment`);
    expect(lastCall().headers.get('idempotency-key')).toBe(KEY);
    expect(lastCall().init.method).toBe('POST');
  });

  it('a 409 surfaces as an ApiError with its body', async () => {
    answer(reply({ error: { code: 'VENDOR_NOT_APPROVED', message: 'x' } }, 409));
    await expect(
      createRfq(session, { purchaseRequestId: ID_B, deadline: 'x', vendorIds: [ID_A] }, KEY),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
