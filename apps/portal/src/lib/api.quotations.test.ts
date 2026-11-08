import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AcceptQuotationBodySchema,
  acceptPortalQuotation,
  ApiError,
  getPortalQuotation,
  getPortalQuotationLink,
  listPortalQuotations,
  openSignedFile,
  RejectQuotationBodySchema,
  rejectPortalQuotation,
} from './api';
import { __resetEnvForTests } from './env';
import type { Session } from './session';
import { sampleListItem, sampleView } from '../components/portal/quotation-fixtures';

vi.mock('server-only', () => ({}));

const session: Session = {
  id: 'A'.repeat(43),
  sub: 'user-1',
  orgId: '00000000-0000-4000-8000-000000000002',
  orgKind: 'customer',
  partyId: '00000000-0000-4000-8000-0000000000aa',
  roles: [],
  accessToken: 'eyJ.secret-access-token.sig',
  accessExp: 2_000_000_000,
  createdAt: 1_700_000_000,
  lastSeenAt: 1_700_000_000,
};

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const IDEM = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const fetchMock = vi.fn<typeof fetch>();

function lastCall(): { url: string; init: RequestInit; headers: Headers } {
  const [url, init] = fetchMock.mock.calls.at(-1) ?? [];
  const requestInit = init ?? {};
  const href = url instanceof Request ? url.url : url instanceof URL ? url.href : (url ?? '');
  return { url: href, init: requestInit, headers: new Headers(requestInit.headers) };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

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
  vi.restoreAllMocks();
});

describe('listPortalQuotations', () => {
  it('GETs /v1/portal/quotations and parses the array', async () => {
    fetchMock.mockResolvedValue(json([sampleListItem()]));
    await expect(listPortalQuotations(session)).resolves.toEqual([sampleListItem()]);
    const { url, init } = lastCall();
    expect(url).toBe('http://api:3001/v1/portal/quotations');
    expect(init.method).toBe('GET');
  });

  it('refuses a row with a status the customer may not see, or an extra field (502)', async () => {
    fetchMock.mockResolvedValue(json([{ ...sampleListItem(), status: 'draft' }]));
    await expect(listPortalQuotations(session)).rejects.toMatchObject({ status: 502 });
    fetchMock.mockResolvedValue(json([{ ...sampleListItem(), internalCostTotal: '1.00' }]));
    await expect(listPortalQuotations(session)).rejects.toMatchObject({ status: 502 });
  });
});

describe('getPortalQuotation', () => {
  it('GETs one view by an encoded id and parses it strictly', async () => {
    fetchMock.mockResolvedValue(json(sampleView()));
    await expect(getPortalQuotation(session, ID)).resolves.toEqual(sampleView());
    expect(lastCall().url).toBe(`http://api:3001/v1/portal/quotations/${ID}`);

    await getPortalQuotation(session, '../admin').catch(() => undefined);
    expect(lastCall().url).toBe('http://api:3001/v1/portal/quotations/..%2Fadmin');
  });

  it('refuses a view carrying an internal field (502), and passes a 404 through', async () => {
    fetchMock.mockResolvedValue(json({ ...sampleView(), marginPct: '22.5' }));
    await expect(getPortalQuotation(session, ID)).rejects.toMatchObject({ status: 502 });
    fetchMock.mockResolvedValue(json({ error: { code: 'not_found' } }, 404));
    await expect(getPortalQuotation(session, ID)).rejects.toMatchObject({ status: 404 });
  });
});

describe('getPortalQuotationLink and openSignedFile', () => {
  it('GETs the document link, then fetches only a relative /v1/files path', async () => {
    const link = { url: '/v1/files/tok.abc-123', expiresAt: '2026-11-08T10:01:00+05:45' };
    fetchMock.mockResolvedValue(json(link));
    await expect(getPortalQuotationLink(session, ID)).resolves.toEqual(link);
    expect(lastCall().url).toBe(`http://api:3001/v1/portal/quotations/${ID}/document`);
    expect(lastCall().init.method).toBe('GET');

    fetchMock.mockResolvedValue(new Response('%PDF-1.7'));
    const res = await openSignedFile(session, link);
    expect(await res.text()).toBe('%PDF-1.7');
    expect(lastCall().url).toBe('http://api:3001/v1/files/tok.abc-123');
  });

  it('refuses a link that is absolute or leaves /v1/files, without fetching it', async () => {
    fetchMock.mockReset();
    for (const url of ['https://evil.test/v1/files/x', '//evil.test/x', '/v1/admin/x']) {
      await expect(
        openSignedFile(session, { url, expiresAt: '2026-11-08T10:01:00+05:45' }),
      ).rejects.toBeInstanceOf(ApiError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('accept and reject', () => {
  it('POSTs the accept body with the Idempotency-Key and ignores the response body', async () => {
    fetchMock.mockResolvedValue(json({ anything: true }));
    await acceptPortalQuotation(session, ID, { acceptedByName: 'Jules', confirm: true }, IDEM);
    const { url, init, headers } = lastCall();
    expect(url).toBe(`http://api:3001/v1/portal/quotations/${ID}/accept`);
    expect(init.method).toBe('POST');
    expect(headers.get('idempotency-key')).toBe(IDEM);
    expect(headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ acceptedByName: 'Jules', confirm: true });
  });

  it('POSTs the reject comment, and throws ApiError with the status on a 409', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await rejectPortalQuotation(session, ID, { comment: 'Too slow' }, IDEM);
    expect(lastCall().url).toBe(`http://api:3001/v1/portal/quotations/${ID}/reject`);
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ comment: 'Too slow' });

    fetchMock.mockResolvedValue(json({ error: { code: 'conflict' } }, 409));
    await expect(
      rejectPortalQuotation(session, ID, { comment: 'Too slow' }, IDEM),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('body schemas: a name and confirm=true to accept, a comment to reject, nothing else', () => {
    expect(
      AcceptQuotationBodySchema.safeParse({ acceptedByName: ' Jules ', confirm: true }).data,
    ).toEqual({ acceptedByName: 'Jules', confirm: true });
    expect(
      AcceptQuotationBodySchema.safeParse({ acceptedByName: 'Jules', confirm: false }).success,
    ).toBe(false);
    expect(
      AcceptQuotationBodySchema.safeParse({ acceptedByName: '   ', confirm: true }).success,
    ).toBe(false);
    expect(
      AcceptQuotationBodySchema.safeParse({ acceptedByName: 'J', confirm: true, evidenceKind: 'x' })
        .success,
    ).toBe(false);
    expect(RejectQuotationBodySchema.safeParse({ comment: '  ' }).success).toBe(false);
    expect(RejectQuotationBodySchema.safeParse({ comment: 'x'.repeat(2001) }).success).toBe(false);
    expect(RejectQuotationBodySchema.safeParse({ comment: 'No thanks' }).success).toBe(true);
  });
});
