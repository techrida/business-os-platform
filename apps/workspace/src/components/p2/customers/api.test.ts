import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import { __resetEnvForTests } from '@/lib/env';
import type { Session } from '@/lib/session';

import {
  countCustomersByRelationship,
  decideVerification,
  getCustomer,
  getVerificationCase,
  listCustomerIndustries,
  listCustomerOwners,
  listCustomerPaymentTerms,
  listCustomers,
  listVerificationCasePage,
  listVerificationCases,
  updateCustomerTerms,
} from './api';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const TOKEN = 'eyJ.secret-access-token.sig';
const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const WHEN = '2026-11-08T05:45:00.000Z';

const session: Session = {
  id: 'A'.repeat(43),
  sub: 'user-1',
  orgId: ID_A,
  orgKind: 'staff',
  roles: ['sales'],
  accessToken: TOKEN,
  accessExp: 2_000_000_000,
  createdAt: 1_700_000_000,
  lastSeenAt: 1_700_000_000,
};

const customer = {
  id: ID_A,
  number: 'CUS-0001',
  legalName: 'Himalayan Construction Pvt. Ltd.',
  panVatNo: '301234567',
  industry: 'Construction',
  relationship: 'prospect',
  ownerUserId: null,
  defaultCurrency: 'NPR',
  address: { line1: 'Balaju', city: 'Kathmandu', country: 'NP' },
  mergedIntoId: null,
  version: 2,
  createdAt: WHEN,
  updatedAt: WHEN,
};

const verificationCase = {
  id: ID_B,
  partyId: ID_A,
  status: 'submitted',
  checklist: [
    {
      key: 'registration_certificate',
      required: true,
      status: 'provided',
      documentId: ID_A,
      expiresOn: null,
    },
    { key: 'other', required: false, status: 'missing', documentId: null, expiresOn: null },
  ],
  reviewedBy: null,
  decidedAt: null,
  decisionNote: null,
  version: 4,
};

const fetchMock = vi.fn<typeof fetch>();
const reply = (body: unknown, status = 200): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

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

describe('customers', () => {
  it('lists customers from a bare array or an items envelope, with the search as a query', async () => {
    fetchMock.mockResolvedValue(reply([customer]));
    const bare = await listCustomers(session, { q: 'Himalayan & Co', limit: 25, offset: 50 });
    expect(bare.items).toHaveLength(1);
    expect(bare.total).toBeNull();
    const { url, headers } = lastCall();
    expect(url).toBe('http://api:3001/v1/customers?q=Himalayan+%26+Co&limit=25&offset=50');
    expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);

    fetchMock.mockResolvedValue(reply({ items: [customer], total: 41 }));
    const wrapped = await listCustomers(session, {});
    expect(wrapped.total).toBe(41);
    expect(lastCall().url).toBe('http://api:3001/v1/customers');
  });

  it('counts each relationship with one single-row read, from the list totals', async () => {
    const totals: Record<string, number> = { prospect: 7, active: 30, inactive: 2 };
    fetchMock.mockImplementation((input) => {
      const href = input instanceof Request ? input.url : String(input);
      const relationship = new URL(href).searchParams.get('relationship') ?? '';
      return Promise.resolve(reply({ items: [customer], total: totals[relationship] }));
    });
    expect(await countCustomersByRelationship(session)).toEqual({
      prospect: 7,
      active: 30,
      inactive: 2,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(lastCall().url).toContain('limit=1');
  });

  it('gives no counts, rather than a guess, when a read fails or sends no total', async () => {
    fetchMock.mockResolvedValue(reply([customer]));
    expect(await countCustomersByRelationship(session)).toBeNull();
    fetchMock.mockRejectedValue(new Error('down'));
    expect(await countCustomersByRelationship(session)).toBeNull();
  });

  it('sends a repeated relationship and industry as one key per value', async () => {
    fetchMock.mockResolvedValue(reply({ items: [customer], total: 1 }));
    await listCustomers(session, {
      relationship: ['active', 'prospect'],
      industry: ['Construction', 'Food & Beverage'],
      limit: 10,
      offset: 20,
    });
    expect(lastCall().url).toBe(
      'http://api:3001/v1/customers?relationship=active&relationship=prospect&industry=Construction&industry=Food+%26+Beverage&limit=10&offset=20',
    );
    fetchMock.mockResolvedValue(reply({ items: [], total: 0 }));
    await listCustomers(session, { relationship: [], industry: [] });
    expect(lastCall().url).toBe('http://api:3001/v1/customers');
  });

  it('reads the industries in use for the filter', async () => {
    fetchMock.mockResolvedValue(reply(['Construction', 'Retail']));
    expect(await listCustomerIndustries(session)).toEqual(['Construction', 'Retail']);
    expect(lastCall().url).toBe('http://api:3001/v1/customers/industries');
    expect(lastCall().headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('reads the owner picker list, and refuses a body that carries more than a name (502)', async () => {
    fetchMock.mockResolvedValue(reply([{ userId: ID_B, displayName: 'Sita Rai' }]));
    expect(await listCustomerOwners(session)).toEqual([{ userId: ID_B, displayName: 'Sita Rai' }]);
    expect(lastCall().url).toBe('http://api:3001/v1/customers/owners');
    fetchMock.mockResolvedValue(
      reply([{ userId: ID_B, displayName: 'Sita Rai', email: 'sita@techrida.test' }]),
    );
    const err = await listCustomerOwners(session).catch((e: unknown) => e);
    expect((err as ApiError).status).toBe(502);
  });

  it('reads the payment terms from a customers route, not the quotation one', async () => {
    fetchMock.mockResolvedValue(reply([{ id: ID_B, label: 'Net 30 days' }]));
    expect(await listCustomerPaymentTerms(session)).toEqual([{ id: ID_B, label: 'Net 30 days' }]);
    expect(lastCall().url).toBe('http://api:3001/v1/customers/payment-terms');
  });

  it('patches the terms with one field and the version, and keeps null apart from absent', async () => {
    const saved = {
      partyId: ID_A,
      organizationId: ID_B,
      organizationName: 'Techrida Nepal',
      paymentTermId: null,
      creditLimit: null,
      version: 3,
    };
    fetchMock.mockResolvedValue(reply(saved));
    expect(
      await updateCustomerTerms(session, ID_A, {
        organizationId: ID_B,
        creditLimit: null,
        expectedVersion: 2,
      }),
    ).toEqual(saved);
    const { url, init } = lastCall();
    expect(url).toBe(`http://api:3001/v1/customers/${ID_A}/terms`);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({
      organizationId: ID_B,
      creditLimit: null,
      expectedVersion: 2,
    });
  });

  it('answers 502 when the industries are not a list of text', async () => {
    fetchMock.mockResolvedValue(reply([1, 2]));
    const err = await listCustomerIndustries(session).catch((e: unknown) => e);
    expect((err as ApiError).status).toBe(502);
  });

  it('encodes the id so a path cannot climb out of the route', async () => {
    fetchMock.mockResolvedValue(reply(customer));
    await getCustomer(session, '../admin');
    expect(lastCall().url).toBe('http://api:3001/v1/customers/..%2Fadmin');
  });

  it('answers 502 when the API drifts from the contract and never leaks the token', async () => {
    fetchMock.mockResolvedValue(reply([{ ...customer, relationship: 'vip' }]));
    const err = await listCustomers(session, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(502);
    expect(JSON.stringify(err)).not.toContain(TOKEN);
  });
});

describe('verification cases', () => {
  it('filters the queue by status and party', async () => {
    fetchMock.mockResolvedValue(reply({ items: [verificationCase] }));
    const out = await listVerificationCases(session, { status: 'submitted', partyId: ID_A });
    expect(out.items[0]?.checklist).toHaveLength(2);
    expect(lastCall().url).toBe(
      `http://api:3001/v1/verification-cases?status=submitted&partyId=${ID_A}`,
    );
  });

  it('pages the queue: repeated status, search, window and the total from X-Total-Count', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([verificationCase]), {
        status: 200,
        headers: { 'x-total-count': '137' },
      }),
    );
    const out = await listVerificationCasePage(session, {
      q: 'Himal',
      status: ['submitted', 'rejected'],
      limit: 25,
      offset: 50,
    });
    expect(out.items).toHaveLength(1);
    expect(out.total).toBe(137);
    expect(lastCall().url).toBe(
      'http://api:3001/v1/verification-cases?q=Himal&status=submitted&status=rejected&limit=25&offset=50',
    );
  });

  it('has no total when the header is missing or not a number', async () => {
    fetchMock.mockResolvedValue(reply([verificationCase]));
    expect((await listVerificationCasePage(session, {})).total).toBeNull();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([verificationCase]), { headers: { 'x-total-count': 'many' } }),
    );
    expect((await listVerificationCasePage(session, {})).total).toBeNull();
  });

  it('keeps the API status on a refusal and answers 502 for a case that breaks the contract', async () => {
    fetchMock.mockResolvedValue(reply({ error: { code: 'forbidden' } }, 403));
    const refused = await listVerificationCasePage(session, {}).catch((e: unknown) => e);
    expect((refused as ApiError).status).toBe(403);
    fetchMock.mockResolvedValue(reply([{ ...verificationCase, status: 'weird' }]));
    const drift = await listVerificationCasePage(session, {}).catch((e: unknown) => e);
    expect((drift as ApiError).status).toBe(502);
  });

  it('reads one case', async () => {
    fetchMock.mockResolvedValue(reply(verificationCase));
    const got = await getVerificationCase(session, ID_B);
    expect(got.version).toBe(4);
    expect(lastCall().url).toBe(`http://api:3001/v1/verification-cases/${ID_B}`);
  });

  it('posts the decision with the version and an Idempotency-Key', async () => {
    fetchMock.mockResolvedValue(reply({ ...verificationCase, status: 'approved', version: 5 }));
    const out = await decideVerification(
      session,
      ID_B,
      { decision: 'approve', comment: 'All documents match.', expectedVersion: 4 },
      'key-12345678',
    );
    expect(out.status).toBe('approved');
    const { url, init, headers } = lastCall();
    expect(url).toBe(`http://api:3001/v1/verification-cases/${ID_B}/decision`);
    expect(init.method).toBe('POST');
    expect(headers.get('idempotency-key')).toBe('key-12345678');
    expect(JSON.parse(init.body as string)).toEqual({
      decision: 'approve',
      comment: 'All documents match.',
      expectedVersion: 4,
    });
  });

  it('carries a 409 as an ApiError the caller can word', async () => {
    fetchMock.mockResolvedValue(reply({ error: { code: 'conflict', message: 'stale' } }, 409));
    const err = await getVerificationCase(session, ID_B).catch((e: unknown) => e);
    expect((err as ApiError).status).toBe(409);
  });
});
