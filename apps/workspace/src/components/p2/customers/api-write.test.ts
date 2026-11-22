import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import { __resetEnvForTests } from '@/lib/env';
import type { Session } from '@/lib/session';

import {
  createContact,
  createCustomer,
  getCustomerDetail,
  listContacts,
  updateCustomer,
} from './api';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const TOKEN = 'eyJ.secret-access-token.sig';
const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const ID_C = '33333333-3333-4333-8333-333333333333';
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
  country: 'NP',
  address: { line: 'Balaju', city: 'Kathmandu' },
  mergedIntoId: null,
  version: 2,
  createdAt: WHEN,
  updatedAt: WHEN,
};

const contact = {
  id: ID_B,
  customerId: ID_A,
  fullName: 'Sita Sharma',
  email: 'sita@example.com',
  country: 'NP',
  phones: [{ country: 'NP', e164: '+9779812345678', label: 'mobile', isPrimary: true }],
  title: 'Purchase manager',
  isPrimary: true,
  version: 1,
};

const account = {
  partyId: ID_A,
  organizationId: ID_C,
  paymentTermId: null,
  creditLimit: '500000.00',
  version: 1,
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

describe('customer detail', () => {
  it('keeps the per-entity accounts when the API sends them', async () => {
    fetchMock.mockResolvedValue(reply({ ...customer, accounts: [account] }));
    const out = await getCustomerDetail(session, ID_A);
    expect(out.accounts).toHaveLength(1);
    expect(out.accounts?.[0]?.creditLimit).toBe('500000.00');
  });

  it('leaves accounts undefined (not an empty list) when the API does not send them', async () => {
    fetchMock.mockResolvedValue(reply(customer));
    const out = await getCustomerDetail(session, ID_A);
    expect(out.accounts).toBeUndefined();
  });

  it('answers 502 for an account that breaks the contract', async () => {
    fetchMock.mockResolvedValue(
      reply({ ...customer, accounts: [{ ...account, creditLimit: '-5' }] }),
    );
    const err = await getCustomerDetail(session, ID_A).catch((e: unknown) => e);
    expect((err as ApiError).status).toBe(502);
  });
});

describe('create and update customer', () => {
  const body = {
    legalName: 'Himalayan Construction Pvt. Ltd.',
    relationship: 'prospect' as const,
    country: 'NP' as const,
    address: { line: 'Balaju', city: 'Kathmandu' },
    contact: {
      fullName: 'Sita Rai',
      email: 'sita@himalayan.example',
      country: 'NP' as const,
      phones: [],
    },
  };

  it('POSTs the body with the idempotency key and parses the new customer', async () => {
    fetchMock.mockResolvedValue(reply(customer, 201));
    const out = await createCustomer(session, body, 'key-123456');
    expect(out.id).toBe(ID_A);
    const { url, init, headers } = lastCall();
    expect(url).toBe('http://api:3001/v1/customers');
    expect(init.method).toBe('POST');
    expect(headers.get('idempotency-key')).toBe('key-123456');
    expect(headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  it('PATCHes with the version the person saw', async () => {
    fetchMock.mockResolvedValue(reply({ ...customer, version: 3 }));
    const out = await updateCustomer(session, ID_A, { industry: 'Hydro', expectedVersion: 2 });
    expect(out.version).toBe(3);
    const { url, init } = lastCall();
    expect(url).toBe(`http://api:3001/v1/customers/${ID_A}`);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ industry: 'Hydro', expectedVersion: 2 });
  });

  it('surfaces a 409 as an ApiError with that status', async () => {
    fetchMock.mockResolvedValue(reply({ error: { code: 'conflict' } }, 409));
    const err = await updateCustomer(session, ID_A, { expectedVersion: 1 }).catch(
      (e: unknown) => e,
    );
    expect((err as ApiError).status).toBe(409);
  });
});

describe('contacts', () => {
  it('lists contacts from a bare array or an items envelope', async () => {
    fetchMock.mockResolvedValue(reply([contact]));
    const bare = await listContacts(session, ID_A);
    expect(bare.items[0]?.fullName).toBe('Sita Sharma');
    expect(lastCall().url).toBe(`http://api:3001/v1/customers/${ID_A}/contacts`);

    fetchMock.mockResolvedValue(reply({ items: [contact], total: 1 }));
    expect((await listContacts(session, ID_A)).total).toBe(1);
  });

  it('encodes the customer id in the path', async () => {
    fetchMock.mockResolvedValue(reply([]));
    await listContacts(session, '../x');
    expect(lastCall().url).toBe('http://api:3001/v1/customers/..%2Fx/contacts');
  });

  it('POSTs a contact with the idempotency key', async () => {
    fetchMock.mockResolvedValue(reply(contact, 201));
    const out = await createContact(
      session,
      ID_A,
      {
        fullName: 'Sita Sharma',
        country: 'NP',
        phones: [{ country: 'NP', e164: '+9779812345678', isPrimary: true }],
        isPrimary: true,
      },
      'key-abcdef12',
    );
    expect(out.id).toBe(ID_B);
    const { url, init, headers } = lastCall();
    expect(url).toBe(`http://api:3001/v1/customers/${ID_A}/contacts`);
    expect(init.method).toBe('POST');
    expect(headers.get('idempotency-key')).toBe('key-abcdef12');
  });
});
