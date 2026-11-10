import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import { __resetEnvForTests } from '@/lib/env';
import type { Session } from '@/lib/session';

import {
  cancelPurchaseRequest,
  createPurchaseRequest,
  getPurchaseRequest,
  listPurchaseRequests,
  listDepartments,
  submitPurchaseRequest,
  updatePurchaseRequest,
} from './api-procurement';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
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

const item = {
  id: ID_A,
  number: null,
  requestType: 'goods',
  departmentId: ID_B,
  requesterUserId: ID_B,
  costCenterId: ID_B,
  justification: 'Chairs for the new office',
  requiredBy: '2026-12-01',
  deliveryLocation: null,
  budgetCode: 'OPS-26',
  projectId: null,
  currency: 'NPR',
  estimatedTotal: '45000.00',
  estimatedTotalNpr: null,
  fxRate: null,
  fxSource: null,
  fxDate: null,
  isEmergency: false,
  emergencyReason: null,
  status: 'draft',
  approvalRequestId: null,
  submittedAt: null,
  version: 1,
  createdAt: '2026-11-08T05:45:00.000Z',
  updatedAt: '2026-11-08T05:45:00.000Z',
};
const dto = {
  ...item,
  lines: [
    {
      id: ID_B,
      lineNo: 1,
      description: 'Chair',
      specification: null,
      uom: 'pcs',
      quantity: '10.0000',
      estimatedUnitPrice: '4500.00',
      estimatedAmount: '45000.00',
    },
  ],
};
const body = {
  requestType: 'goods' as const,
  departmentId: ID_B,
  costCenterId: ID_B,
  justification: 'Chairs for the new office',
  requiredBy: '2026-12-01',
  budgetCode: 'OPS-26',
  currency: 'NPR' as const,
  isEmergency: false,
  lines: [{ description: 'Chair', uom: 'pcs', quantity: '10', estimatedUnitPrice: '4500.00' }],
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

describe('listPurchaseRequests', () => {
  it('sends only status and limit (the API list query is strict) and parses a bare array', async () => {
    answer(reply([item]));
    const out = await listPurchaseRequests(session, { status: 'submitted', limit: 100 });
    expect(out).toHaveLength(1);
    const { url, headers } = lastCall();
    expect(url).toBe('http://api:3001/v1/procurement/purchase-requests?status=submitted&limit=100');
    expect(headers.get('authorization')).toBe('Bearer eyJ.secret-access-token.sig');
  });

  it('refuses a status that is not a purchase request status before calling the API', () => {
    expect(() => listPurchaseRequests(session, { status: 'bogus' as never })).toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads the live RFQ id, and treats an answer without one as no RFQ', async () => {
    answer(reply([{ ...item, rfqId: ID_B }, item]));
    const out = await listPurchaseRequests(session, {});
    expect(out[0]?.rfqId).toBe(ID_B);
    expect(out[1]?.rfqId).toBeNull();
  });

  it('keeps money as the server wrote it, as strings', async () => {
    answer(reply([item]));
    const [first] = await listPurchaseRequests(session, {});
    expect(first?.estimatedTotal).toBe('45000.00');
    expect(first?.number).toBeNull();
  });

  it('turns an answer that breaks the contract into a 502', async () => {
    answer(reply([{ ...item, estimatedTotal: 45000 }]));
    await expect(listPurchaseRequests(session, {})).rejects.toMatchObject({ status: 502 });
  });

  it('throws the API status and body on a refusal', async () => {
    answer(reply({ error: { code: 'forbidden' } }, 403));
    await expect(listPurchaseRequests(session, {})).rejects.toBeInstanceOf(ApiError);
  });
});

describe('getPurchaseRequest', () => {
  it('encodes the id into the path and parses the lines', async () => {
    answer(reply(dto));
    const out = await getPurchaseRequest(session, ID_A);
    expect(out.lines[0]?.estimatedAmount).toBe('45000.00');
    expect(lastCall().url).toBe(`http://api:3001/v1/procurement/purchase-requests/${ID_A}`);
  });

  it('can never climb out of the route with a hostile id', async () => {
    answer(reply(dto));
    await getPurchaseRequest(session, '../../admin/users');
    expect(lastCall().url).toBe(
      'http://api:3001/v1/procurement/purchase-requests/..%2F..%2Fadmin%2Fusers',
    );
  });
});

describe('writes carry the Idempotency-Key', () => {
  it('create posts the contract body with the key', async () => {
    answer(reply(dto, 201));
    await createPurchaseRequest(session, body, KEY);
    const { url, init, headers } = lastCall();
    expect(url).toBe('http://api:3001/v1/procurement/purchase-requests');
    expect(init.method).toBe('POST');
    expect(headers.get('idempotency-key')).toBe(KEY);
    expect(JSON.parse(bodyText(init))).toEqual(body);
  });

  it('update patches the whole body plus expectedVersion, with a key', async () => {
    answer(reply(dto));
    await updatePurchaseRequest(session, ID_A, body, KEY, 3);
    const { url, init, headers } = lastCall();
    expect(url).toBe(`http://api:3001/v1/procurement/purchase-requests/${ID_A}`);
    expect(init.method).toBe('PATCH');
    expect(headers.get('idempotency-key')).toBe(KEY);
    expect(JSON.parse(bodyText(init))).toEqual({ ...body, expectedVersion: 3 });
  });

  it('submit posts nothing but expectedVersion, with a key', async () => {
    answer(reply({ ...dto, status: 'submitted' }));
    await submitPurchaseRequest(session, ID_A, KEY, 2);
    const { url, init, headers } = lastCall();
    expect(url).toBe(`http://api:3001/v1/procurement/purchase-requests/${ID_A}/submit`);
    expect(headers.get('idempotency-key')).toBe(KEY);
    expect(JSON.parse(bodyText(init))).toEqual({ expectedVersion: 2 });
  });

  it('cancel sends an empty object without a version, with a key', async () => {
    answer(reply({ ...dto, status: 'cancelled' }));
    await cancelPurchaseRequest(session, ID_A, KEY);
    const { url, init, headers } = lastCall();
    expect(url).toBe(`http://api:3001/v1/procurement/purchase-requests/${ID_A}/cancel`);
    expect(headers.get('idempotency-key')).toBe(KEY);
    expect(JSON.parse(bodyText(init))).toEqual({});
  });

  it('a 422 from submit surfaces as an ApiError with its body', async () => {
    answer(reply({ error: { code: 'NO_ELIGIBLE_APPROVER', message: 'no head' } }, 422));
    await expect(submitPurchaseRequest(session, ID_A, KEY)).rejects.toMatchObject({
      status: 422,
    });
  });
});

it('reads named departments from the existing scoped staff lookup', async () => {
  answer(reply([{ id: ID_B, name: 'Operations' }]));
  await expect(listDepartments(session)).resolves.toEqual([{ id: ID_B, name: 'Operations' }]);
  expect(lastCall().url).toBe('http://api:3001/v1/departments');
});
