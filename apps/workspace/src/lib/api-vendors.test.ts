import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import { __resetEnvForTests } from '@/lib/env';
import type { Session } from '@/lib/session';

import {
  createVendor,
  grantVendorPortalAccess,
  listBankAccounts,
  listVendorContacts,
  listVendors,
  proposeBankAccount,
  rejectBankAccount,
  submitVendorKyc,
  updateVendor,
  vendorLifecycle,
  verifyBankAccount,
} from './api-vendors';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

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

const vendor = {
  id: ID_A,
  legalName: 'Himal Traders Pvt. Ltd.',
  tradeName: null,
  kind: 'company',
  pan: '301234567',
  vatRegistered: true,
  country: 'NP',
  status: 'draft',
  version: 1,
  approvedAt: null,
};

const bank = {
  id: ID_B,
  vendorPartyId: ID_A,
  bankName: 'Nabil Bank',
  branch: null,
  accountName: 'Himal Traders',
  accountLast4: '4455',
  status: 'proposed',
  proposedVia: 'staff',
  verifiedAt: null,
};

const fetchMock = vi.fn<typeof fetch>();
const reply = (body: unknown, status = 200): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

/** Each call gets its own copy, so one canned answer can serve several calls. */
const answer = (r: Response): void => {
  fetchMock.mockImplementation(() => Promise.resolve(r.clone()));
};

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

describe('listVendors', () => {
  it('sends the status and search, and parses { items, total }', async () => {
    answer(reply({ items: [vendor], total: 41 }));
    const out = await listVendors(session, { q: 'Himal', status: 'draft', limit: 25, offset: 50 });
    expect(out.total).toBe(41);
    expect(out.items[0]?.legalName).toBe('Himal Traders Pvt. Ltd.');
    const { url, headers } = lastCall();
    expect(url).toBe('http://api:3001/v1/vendors?q=Himal&status=draft&limit=25&offset=50');
    expect(headers.get('authorization')).toBe('Bearer eyJ.secret-access-token.sig');
  });

  it('leaves empty filters out of the query', async () => {
    answer(reply({ items: [], total: 0 }));
    await listVendors(session, { q: '' });
    expect(lastCall().url).toBe('http://api:3001/v1/vendors');
  });

  it('answers 502 for a vendor that breaks the contract', async () => {
    answer(reply({ items: [{ ...vendor, status: 'weird' }], total: 1 }));
    const e = await listVendors(session, {}).catch((x: unknown) => x);
    expect((e as ApiError).status).toBe(502);
  });

  it('keeps the API status and body on a refusal', async () => {
    answer(reply({ error: { code: 'forbidden' } }, 403));
    const e = await listVendors(session, {}).catch((x: unknown) => x);
    expect((e as ApiError).status).toBe(403);
  });
});

describe('writes carry the Idempotency-Key', () => {
  it('create POSTs the body with the key', async () => {
    answer(reply(vendor, 201));
    await createVendor(
      session,
      { legalName: 'Himal', kind: 'company', pan: '301234567', vatRegistered: true, country: 'NP' },
      'key-123456',
    );
    const { url, init, headers } = lastCall();
    expect(url).toBe('http://api:3001/v1/vendors');
    expect(init.method).toBe('POST');
    expect(headers.get('idempotency-key')).toBe('key-123456');
    expect(JSON.parse(init.body as string)).toMatchObject({ kind: 'company', country: 'NP' });
  });

  it('submit-kyc and activate send the key and no body', async () => {
    answer(reply(vendor));
    await submitVendorKyc(session, ID_A, 'key-kyc-1234');
    expect(lastCall().url).toBe(`http://api:3001/v1/vendors/${ID_A}/submit-kyc`);
    expect(lastCall().headers.get('idempotency-key')).toBe('key-kyc-1234');
    await vendorLifecycle(session, ID_A, 'activate', 'key-act-1234');
    expect(lastCall().url).toBe(`http://api:3001/v1/vendors/${ID_A}/activate`);
    expect(lastCall().init.body).toBeUndefined();
  });

  it('suspend, block and archive send the reason', async () => {
    answer(reply(vendor));
    await vendorLifecycle(session, ID_A, 'block', 'key-blk-1234', 'Unpaid dues');
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ reason: 'Unpaid dues' });
    expect(lastCall().headers.get('idempotency-key')).toBe('key-blk-1234');
  });

  it('PATCH sends the version and no key', async () => {
    answer(reply(vendor));
    await updateVendor(session, ID_A, { expectedVersion: 3, vatRegistered: false });
    const { init, headers } = lastCall();
    expect(init.method).toBe('PATCH');
    expect(headers.get('idempotency-key')).toBeNull();
    expect(JSON.parse(init.body as string)).toEqual({ expectedVersion: 3, vatRegistered: false });
  });

  it('encodes an id so it cannot climb out of the route', async () => {
    answer(reply(vendor));
    await submitVendorKyc(session, '../x', 'key-123456');
    expect(lastCall().url).toBe('http://api:3001/v1/vendors/..%2Fx/submit-kyc');
  });
});

describe('contacts and portal access', () => {
  it('parses a bare contact array', async () => {
    answer(
      reply([
        {
          id: ID_B,
          vendorPartyId: ID_A,
          name: 'Sita',
          email: null,
          phone: null,
          role: null,
          isPrimary: true,
          version: 1,
        },
      ]),
    );
    expect((await listVendorContacts(session, ID_A))[0]?.name).toBe('Sita');
  });

  it('grants portal access to a contact with the key', async () => {
    answer(
      reply(
        {
          vendorId: ID_A,
          contactId: ID_B,
          userId: ID_A,
          idpOrgId: ID_B,
          email: 'sita@example.com',
          status: 'invited',
          inviteSent: true,
          capability: 'onboarding_only',
        },
        201,
      ),
    );
    const out = await grantVendorPortalAccess(session, ID_A, ID_B, 'key-prt-1234');
    expect(out.capability).toBe('onboarding_only');
    expect(lastCall().url).toBe(`http://api:3001/v1/vendors/${ID_A}/portal-access`);
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ contactId: ID_B });
  });
});

describe('bank accounts', () => {
  it('lists the last four only and rejects a body that carries a full number', async () => {
    answer(reply([bank]));
    expect((await listBankAccounts(session, ID_A))[0]?.accountLast4).toBe('4455');
    answer(reply([{ ...bank, accountNumber: '001122334455' }]));
    const e = await listBankAccounts(session, ID_A).catch((x: unknown) => x);
    expect((e as ApiError).status).toBe(502);
  });

  it('propose, verify and reject POST with a key', async () => {
    answer(reply(bank, 201));
    await proposeBankAccount(
      session,
      ID_A,
      { bankName: 'Nabil Bank', accountName: 'Himal', accountNumber: '001122334455' },
      'key-prp-1234',
    );
    expect(lastCall().url).toBe(`http://api:3001/v1/vendors/${ID_A}/bank-accounts`);
    expect(lastCall().headers.get('idempotency-key')).toBe('key-prp-1234');
    await verifyBankAccount(
      session,
      ID_A,
      ID_B,
      { callbackEvidenceDocumentId: ID_A },
      'key-vfy-1234',
    );
    expect(lastCall().url).toBe(`http://api:3001/v1/vendors/${ID_A}/bank-accounts/${ID_B}/verify`);
    await rejectBankAccount(session, ID_A, ID_B, { reason: 'wrong name' }, 'key-rej-1234');
    expect(lastCall().url).toBe(`http://api:3001/v1/vendors/${ID_A}/bank-accounts/${ID_B}/reject`);
    expect(lastCall().headers.get('idempotency-key')).toBe('key-rej-1234');
  });
});
