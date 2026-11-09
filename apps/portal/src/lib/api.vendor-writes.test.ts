import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from './api';
import { __resetEnvForTests } from './env';
import type { Session } from './session';

vi.mock('server-only', () => ({}));

const {
  requestVendorBankChange,
  submitVendorBill,
  submitVendorKycDocument,
  uploadVendorFile,
  UPLOAD_KINDS,
} = await import('./api.vendor-writes');

const session: Session = {
  id: 'A'.repeat(43),
  sub: 'user-1',
  orgId: '00000000-0000-4000-8000-000000000002',
  orgKind: 'vendor',
  partyId: '00000000-0000-4000-8000-0000000000aa',
  roles: [],
  accessToken: 'eyJ.secret-access-token.sig',
  accessExp: 2_000_000_000,
  createdAt: 1_700_000_000,
  lastSeenAt: 1_700_000_000,
};

const DOC = '0f8fad5b-d9cb-469f-a165-70867728950e';
const VER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const IDEM = '3b241101-e2bb-4255-8caf-4136c566a962';
const PO = '9b2d7a1e-5c3f-4e8a-8f10-2a6b7c8d9e01';
const NUMBER = '0123456789012';

const pathFor = (kind: string, doc = DOC, ver = VER) =>
  `/v1/portal/vendor/${kind}/files/${doc}/versions/${ver}/content`;

const fetchMock = vi.fn<typeof fetch>();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const started = (kind: string, over: Partial<Record<string, string>> = {}) =>
  json({ documentId: DOC, versionId: VER, uploadPath: pathFor(kind), ...over }, 201);

function request(n: number): { url: string; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls[n] ?? [];
  const href = typeof url === 'string' ? url : url instanceof URL ? url.href : (url as Request).url;
  return { url: href, init: init ?? {} };
}
const header = (n: number, name: string) => new Headers(request(n).init.headers).get(name);

const file = () => ({
  filename: 'pan.pdf',
  mime: 'application/pdf',
  size: 8,
  body: new Response('%PDF-1.7').body as ReadableStream<Uint8Array>,
});

beforeEach(() => {
  for (const [k, v] of Object.entries({
    API_INTERNAL_URL: 'http://api:3001',
    OIDC_ISSUER: 'https://auth.test',
    OIDC_CLIENT_ID: 'client-123',
    OIDC_REDIRECT_URI: 'https://app.test/auth/callback',
    OIDC_AUDIENCE: 'proj-42',
    PORTAL_PUBLIC_URL: 'https://app.test',
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

describe('uploadVendorFile', () => {
  it.each(UPLOAD_KINDS)(
    'declares, then streams the bytes for %s, and returns only the document id',
    async (kind) => {
      fetchMock.mockResolvedValueOnce(started(kind)).mockResolvedValueOnce(json({}, 200));
      const result = await uploadVendorFile(session, kind, file());

      expect(result).toEqual({ documentId: DOC });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const first = request(0);
      expect(first.url).toBe(`http://api:3001/v1/portal/vendor/${kind}/files`);
      expect(first.init.method).toBe('POST');
      expect(JSON.parse(first.init.body as string)).toEqual({
        filename: 'pan.pdf',
        declaredMime: 'application/pdf',
        sizeBytes: 8,
      });
      const put = request(1);
      expect(put.url).toBe(`http://api:3001${pathFor(kind)}`);
      expect(put.init.method).toBe('PUT');
      expect(header(1, 'content-type')).toBe('application/pdf');
      expect(header(1, 'authorization')).toBe(`Bearer ${session.accessToken}`);
      expect((put.init as { duplex?: string }).duplex).toBe('half');
    },
  );

  // The PUT carries the bearer token, so a path the API did not mean to hand out must never be fetched.
  it.each([
    ['an absolute URL', 'https://evil.test/v1/portal/vendor/kyc-documents/files/x'],
    ['a protocol-relative path', '//evil.test/x'],
    ['the other kind', pathFor('bill-submissions')],
    ['a dot-dot segment', '/v1/portal/vendor/kyc-documents/files/../../../me/versions/x/content'],
    ['ids that are not the returned ones', pathFor('kyc-documents', DOC, PO)],
    ['a query string', `${pathFor('kyc-documents')}?next=//evil.test`],
    ['a backslash', pathFor('kyc-documents').replace('/files/', '\\files\\')],
    ['an empty path', ''],
  ])('refuses %s with a 502 before the PUT goes out', async (_name, uploadPath) => {
    fetchMock.mockResolvedValueOnce(started('kyc-documents', { uploadPath }));
    const err = await uploadVendorFile(session, 'kyc-documents', file()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a start answer with ids that are not UUIDs (502, one call)', async () => {
    fetchMock.mockResolvedValueOnce(started('kyc-documents', { documentId: '../me' }));
    const err = await uploadVendorFile(session, 'kyc-documents', file()).catch((e: unknown) => e);
    expect((err as ApiError).status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the status of a refused declaration and a refused PUT', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'forbidden' } }, 403));
    await expect(uploadVendorFile(session, 'bill-submissions', file())).rejects.toMatchObject({
      status: 403,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(started('bill-submissions'))
      .mockResolvedValueOnce(json({ error: { code: 'payload_too_large' } }, 413));
    await expect(uploadVendorFile(session, 'bill-submissions', file())).rejects.toMatchObject({
      status: 413,
    });
  });
});

describe('submitVendorKycDocument', () => {
  it('posts the checklist item and file with the Idempotency-Key', async () => {
    fetchMock.mockResolvedValueOnce(json({ state: 'submitted' }, 201));
    await submitVendorKycDocument(session, { docType: 'pan_certificate', documentId: DOC }, IDEM);
    const r = request(0);
    expect(r.url).toBe('http://api:3001/v1/portal/vendor/kyc-documents');
    expect(r.init.method).toBe('POST');
    expect(header(0, 'idempotency-key')).toBe(IDEM);
    expect(JSON.parse(r.init.body as string)).toEqual({
      docType: 'pan_certificate',
      documentId: DOC,
    });
  });

  it('refuses a tax clearance without an expiry before anything is sent', async () => {
    await expect(
      submitVendorKycDocument(session, { docType: 'tax_clearance', documentId: DOC }, IDEM),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(json({}, 201));
    await submitVendorKycDocument(
      session,
      { docType: 'tax_clearance', documentId: DOC, validUntil: '2027-07-15' },
      IDEM,
    );
    expect(JSON.parse(request(0).init.body as string)).toMatchObject({ validUntil: '2027-07-15' });
  });

  it('cannot send a field outside the contract (no vendor id)', async () => {
    await expect(
      submitVendorKycDocument(
        session,
        { docType: 'pan_certificate', documentId: DOC, vendorPartyId: DOC } as never,
        IDEM,
      ),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws an ApiError carrying the status, including the in-progress 409', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'idempotency_in_progress' } }, 409));
    await expect(
      submitVendorKycDocument(session, { docType: 'pan_certificate', documentId: DOC }, IDEM),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('submitVendorBill', () => {
  const body = {
    documentId: DOC,
    vendorInvoiceNo: 'INV-77',
    invoiceDate: '2026-11-01',
    currency: 'NPR' as const,
    claimedTotal: '1250000.50',
    purchaseOrderId: PO,
  };

  it('posts the bill claim with the Idempotency-Key and no party id', async () => {
    fetchMock.mockResolvedValueOnce(json({ status: 'received' }, 201));
    await submitVendorBill(session, body, IDEM);
    const r = request(0);
    expect(r.url).toBe('http://api:3001/v1/portal/vendor/bill-submissions');
    expect(header(0, 'idempotency-key')).toBe(IDEM);
    expect(JSON.parse(r.init.body as string)).toEqual(body);
  });

  it('rejects a bad total, a missing file and an extra field before sending', async () => {
    for (const bad of [
      { ...body, claimedTotal: '-5' },
      { ...body, claimedTotal: '12,50' },
      { ...body, documentId: 'nope' },
      { ...body, vendorPartyId: DOC },
    ]) {
      await expect(submitVendorBill(session, bad as never, IDEM)).rejects.toThrow();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('requestVendorBankChange', () => {
  const body = {
    bankName: 'Nabil Bank',
    accountName: 'Himal Traders Pvt Ltd',
    accountNumber: NUMBER,
  };
  const dto = {
    id: DOC,
    vendorPartyId: PO,
    bankName: 'Nabil Bank',
    branch: null,
    accountName: 'Himal Traders Pvt Ltd',
    accountLast4: '9012',
    status: 'proposed',
    proposedVia: 'portal',
    verifiedAt: null,
  };

  it('posts the account with the Idempotency-Key and returns the bank, last four and status only', async () => {
    fetchMock.mockResolvedValueOnce(json(dto, 201));
    const receipt = await requestVendorBankChange(session, body, IDEM);
    const r = request(0);
    expect(r.url).toBe('http://api:3001/v1/portal/vendor/bank-change-requests');
    expect(header(0, 'idempotency-key')).toBe(IDEM);
    expect(JSON.parse(r.init.body as string)).toEqual(body);
    expect(receipt).toEqual({ bankName: 'Nabil Bank', last4: '9012', status: 'proposed' });
    expect(JSON.stringify(receipt)).not.toContain(NUMBER);
    expect(JSON.stringify(receipt)).not.toContain(PO);
  });

  it('answers null for a 2xx it cannot read, instead of failing a request that landed', async () => {
    fetchMock.mockResolvedValueOnce(json({ ...dto, extra: 'x' }, 201));
    expect(await requestVendorBankChange(session, body, IDEM)).toBeNull();
    fetchMock.mockResolvedValueOnce(new Response('', { status: 201 }));
    expect(await requestVendorBankChange(session, body, IDEM)).toBeNull();
  });

  it('refuses a malformed number or an attached document before sending, without echoing it', async () => {
    const short = await requestVendorBankChange(
      session,
      { ...body, accountNumber: '12 34' },
      IDEM,
    ).catch((e: unknown) => e);
    expect(short).toBeInstanceOf(Error);
    expect(JSON.stringify(short)).not.toContain('12 34');
    expect(String((short as Error).message)).not.toContain('12 34');
    await expect(
      requestVendorBankChange(session, { ...body, supportingDocumentId: DOC } as never, IDEM),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the response body and the number out of a refusal', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ error: { code: 'validation_failed', note: NUMBER } }, 400),
    );
    const err = (await requestVendorBankChange(session, body, IDEM).catch(
      (e: unknown) => e,
    )) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
    expect(err.message).not.toContain(NUMBER);
    expect(JSON.stringify(err.body ?? null)).not.toContain(NUMBER);
  });
});
