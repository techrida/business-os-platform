import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import { __resetEnvForTests } from '@/lib/env';
import type { Session } from '@/lib/session';

import {
  createBankEvidence,
  createVendor,
  findVendorNameMatches,
  getVendorReviewReadiness,
  grantVendorPortalAccess,
  listBankAccounts,
  listVendorContacts,
  listVendors,
  proposeBankAccount,
  rejectBankAccount,
  submitVendorKyc,
  updateVendor,
  uploadBankEvidenceContent,
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
  address: null,
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

const ID_C = '33333333-3333-4333-8333-333333333333';
const ID_D = '44444444-4444-4444-8444-444444444444';
const EVIDENCE_PATH = `/v1/vendors/${ID_A}/bank-accounts/${ID_B}/evidence/${ID_C}/versions/${ID_D}/content`;
const evidence = { documentId: ID_C, versionId: ID_D, uploadPath: EVIDENCE_PATH };
const evidenceVersion = {
  id: ID_D,
  documentId: ID_C,
  version: 1,
  filename: 'callback.pdf',
  declaredMime: 'application/pdf',
  detectedMime: null,
  sizeBytes: 2048,
  sha256: null,
  status: 'quarantined',
  scanSignature: null,
  scannedAt: null,
  uploadedBy: ID_A,
  createdAt: '2026-11-08T05:45:00.000Z',
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

  it('sends several statuses and kinds as repeated keys', async () => {
    answer(reply({ items: [], total: 0 }));
    await listVendors(session, {
      status: ['approved', 'draft'],
      kind: ['company', 'sole_proprietor'],
      limit: 10,
      offset: 20,
    });
    expect(lastCall().url).toBe(
      'http://api:3001/v1/vendors?status=approved&status=draft&kind=company&kind=sole_proprietor&limit=10&offset=20',
    );
    await listVendors(session, { status: [], kind: [] });
    expect(lastCall().url).toBe('http://api:3001/v1/vendors');
  });

  it('refuses an unknown status before it is sent', () => {
    expect(() => listVendors(session, { status: ['weird'] as never })).toThrow();
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

  it('submit-kyc sends the key and the status its button saw; activate sends no body', async () => {
    answer(reply(vendor));
    await submitVendorKyc(session, ID_A, 'key-kyc-1234', 'draft');
    expect(lastCall().url).toBe(`http://api:3001/v1/vendors/${ID_A}/submit-kyc`);
    expect(lastCall().headers.get('idempotency-key')).toBe('key-kyc-1234');
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ expectedStatus: 'draft' });
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

  it('asks for vendors with the same name and returns the matches', async () => {
    const match = { id: ID_A, legalName: 'Himal Traders', status: 'approved' };
    answer(reply({ matches: [match] }));
    expect(await findVendorNameMatches(session, 'Himal Traders & Co')).toEqual([match]);
    expect(lastCall().url).toBe(
      'http://api:3001/v1/vendors/name-matches?legalName=Himal+Traders+%26+Co',
    );
    answer(reply({ matches: [{ ...match, status: 'gone' }] }));
    await expect(findVendorNameMatches(session, 'Himal')).rejects.toThrow();
  });

  it('reads the KYB review readiness and refuses a body that drifts from it', async () => {
    answer(reply({ kybSubmitted: true }));
    expect(await getVendorReviewReadiness(session, ID_A)).toEqual({ kybSubmitted: true });
    expect(lastCall().url).toBe(`http://api:3001/v1/vendors/${ID_A}/review-readiness`);
    answer(reply({ kybSubmitted: 'yes' }));
    await expect(getVendorReviewReadiness(session, ID_A)).rejects.toThrow();
  });

  it('encodes an id so it cannot climb out of the route', async () => {
    answer(reply(vendor));
    await submitVendorKyc(session, '../x', 'key-123456', 'draft');
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
          country: 'US',
          phones: [{ country: 'US', e164: '+14155552671', label: 'work', isPrimary: true }],
          role: null,
          isPrimary: true,
          version: 1,
        },
      ]),
    );
    const [contact] = await listVendorContacts(session, ID_A);
    expect(contact?.name).toBe('Sita');
    expect(contact?.phones[0]?.e164).toBe('+14155552671');
  });

  it('answers 502 for a contact whose phones have no primary, two primaries or one number twice (FX9 A2)', async () => {
    const us = { country: 'US', e164: '+14155552671', label: 'work', isPrimary: true } as const;
    const other = { country: 'US', e164: '+14155552672', label: null, isPrimary: false } as const;
    for (const phones of [
      [{ ...us, isPrimary: false }, other],
      [us, { ...other, isPrimary: true }],
      [us, { ...us, label: 'home', isPrimary: false }],
    ]) {
      answer(
        reply([
          {
            id: ID_B,
            vendorPartyId: ID_A,
            name: 'Sita',
            email: null,
            country: 'US',
            phones,
            role: null,
            isPrimary: true,
            version: 1,
          },
        ]),
      );
      const e = await listVendorContacts(session, ID_A).catch((x: unknown) => x);
      expect((e as ApiError).status, JSON.stringify(phones)).toBe(502);
    }
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

  describe('call-back evidence upload', () => {
    const upload = () => ({
      body: new ReadableStream<Uint8Array>(),
      contentLength: 2048,
      contentType: 'application/pdf',
    });

    it('declares the file on the vendor route, with no owner and no key', async () => {
      answer(reply(evidence, 201));
      const created = await createBankEvidence(session, ID_A, ID_B, {
        filename: 'callback.pdf',
        declaredMime: 'application/pdf',
        sizeBytes: 2048,
      });
      expect(created).toEqual(evidence);
      const { url, init, headers } = lastCall();
      expect(url).toBe(`http://api:3001/v1/vendors/${ID_A}/bank-accounts/${ID_B}/evidence`);
      expect(init.method).toBe('POST');
      expect(headers.get('idempotency-key')).toBeNull();
      expect(JSON.parse(init.body as string)).toEqual({
        filename: 'callback.pdf',
        declaredMime: 'application/pdf',
        sizeBytes: 2048,
      });
    });

    it('answers 502 when the declared document comes back malformed', async () => {
      answer(reply({ documentId: 'nope', versionId: ID_D, uploadPath: EVIDENCE_PATH }, 201));
      const e = await createBankEvidence(session, ID_A, ID_B, {
        filename: 'a.pdf',
        declaredMime: 'application/pdf',
        sizeBytes: 1,
      }).catch((x: unknown) => x);
      expect((e as ApiError).status).toBe(502);
    });

    it('streams the bytes with a raw PUT to the vendor evidence upload path', async () => {
      answer(reply(evidenceVersion));
      const input = upload();
      const out = await uploadBankEvidenceContent(session, ID_A, ID_B, evidence, input);
      expect(out.status).toBe('quarantined');
      const { url, init, headers } = lastCall();
      expect(url).toBe(`http://api:3001${EVIDENCE_PATH}`);
      expect(init.method).toBe('PUT');
      expect(init.body).toBe(input.body);
      expect((init as { duplex?: string }).duplex).toBe('half');
      expect(headers.get('content-type')).toBe('application/pdf');
      expect(headers.get('content-length')).toBe('2048');
    });

    it.each([
      ['the generic documents route', `/v1/documents/${ID_C}/versions/${ID_D}/content`],
      ['an unrelated route', '/v1/admin/users'],
      ['another origin', `https://evil.test${EVIDENCE_PATH}`],
      ['a protocol-relative url', `//evil.test${EVIDENCE_PATH}`],
      ['a query string', `${EVIDENCE_PATH}?x=1`],
      ['a trailing segment', `${EVIDENCE_PATH}/extra`],
      [
        'a path climb',
        `/v1/vendors/${ID_A}/bank-accounts/${ID_B}/evidence/../../x/${ID_C}/versions/${ID_D}/content`,
      ],
      ['another vendor', EVIDENCE_PATH.replace(ID_A, ID_D)],
      ['another account', EVIDENCE_PATH.replace(ID_B, ID_D)],
      ['another document', EVIDENCE_PATH.replace(ID_C, ID_A)],
      ['another version', EVIDENCE_PATH.replace(ID_D, ID_A)],
    ])('refuses %s as the upload path and sends nothing', async (_label, uploadPath) => {
      await expect(
        uploadBankEvidenceContent(session, ID_A, ID_B, { ...evidence, uploadPath }, upload()),
      ).rejects.toMatchObject({ status: 502 });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
