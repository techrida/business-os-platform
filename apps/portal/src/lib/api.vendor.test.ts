import { forbiddenPortalKeys } from '@bos/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from './api';
import {
  getVendorBill,
  getVendorOnboarding,
  getVendorPurchaseOrder,
  getVendorPurchaseOrderLink,
  getVendorRfq,
  listVendorBills,
  listVendorPurchaseOrders,
  listVendorRfqs,
  openVendorFile,
} from './api.vendor';
import { __resetEnvForTests } from './env';
import type { Session } from './session';
import { sampleRfq, sampleRfqListItem } from '../components/vendor/rfq-fixtures';
import {
  sampleBill,
  sampleOnboarding,
  samplePo,
  samplePoListItem,
} from '../components/vendor/vendor-fixtures';

vi.mock('server-only', () => ({}));

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
const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const fetchMock = vi.fn<typeof fetch>();

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function lastCall(): { url: string; headers: Headers } {
  const [url, init] = fetchMock.mock.calls.at(-1) ?? [];
  const href = url instanceof URL ? url.href : typeof url === 'string' ? url : '';
  return { url: href, headers: new Headers(init?.headers) };
}

async function statusOf(p: Promise<unknown>): Promise<number | 'ok'> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    return err instanceof ApiError ? err.status : -1;
  }
}

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

describe('vendor reads', () => {
  it('reads onboarding with the bearer token, and the fixture carries no internal key', async () => {
    fetchMock.mockResolvedValue(json(sampleOnboarding()));
    const view = await getVendorOnboarding(session);
    expect(view.status).toBe('pending_kyc');
    const { url, headers } = lastCall();
    expect(url).toBe('http://api:3001/v1/portal/vendor/onboarding');
    expect(headers.get('authorization')).toBe('Bearer eyJ.secret-access-token.sig');
    expect(forbiddenPortalKeys(view)).toEqual([]);
  });

  it('refuses a body with an extra key (a review note) as a 502 instead of passing it on', async () => {
    fetchMock.mockResolvedValue(json({ ...sampleOnboarding(), reviewNote: 'looks fishy' }));
    expect(await statusOf(getVendorOnboarding(session))).toBe(502);
  });

  it('lists purchase orders and reads one, with the id encoded as one path segment', async () => {
    fetchMock.mockResolvedValueOnce(json([samplePoListItem()]));
    expect(await listVendorPurchaseOrders(session)).toHaveLength(1);
    expect(lastCall().url).toBe('http://api:3001/v1/portal/vendor/purchase-orders');

    fetchMock.mockResolvedValueOnce(json(samplePo()));
    await getVendorPurchaseOrder(session, ID);
    expect(lastCall().url).toBe(`http://api:3001/v1/portal/vendor/purchase-orders/${ID}`);

    fetchMock.mockResolvedValueOnce(json(samplePo()));
    await getVendorPurchaseOrder(session, '../bills');
    expect(lastCall().url).toContain('/purchase-orders/..%2Fbills');
  });

  it('answers a purchase order in a state the vendor may not see as 404, never as 502', async () => {
    fetchMock.mockResolvedValue(json({ ...samplePo(), status: 'draft', internalMemo: 'x' }));
    expect(await statusOf(getVendorPurchaseOrder(session, ID))).toBe(404);
  });

  it('passes a 403 and a 404 from the API through with their status', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'forbidden' } }, 403));
    expect(await statusOf(listVendorPurchaseOrders(session))).toBe(403);
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'not_found' } }, 404));
    expect(await statusOf(getVendorBill(session, ID))).toBe(404);
  });

  it('reads the PDF link and refuses to fetch a link outside /v1/files', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ url: '/v1/files/tok.abc-123', expiresAt: '2026-11-08T10:01:00+05:45' }),
    );
    const link = await getVendorPurchaseOrderLink(session, ID);
    expect(lastCall().url).toBe(`http://api:3001/v1/portal/vendor/purchase-orders/${ID}/pdf`);

    fetchMock.mockResolvedValueOnce(new Response('%PDF', { status: 200 }));
    await openVendorFile(session, link);
    expect(lastCall().url).toBe('http://api:3001/v1/files/tok.abc-123');

    fetchMock.mockClear();
    const outside = { url: 'https://evil.test/x', expiresAt: link.expiresAt };
    expect(await statusOf(openVendorFile(session, outside))).toBe(502);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lists and reads bills; a bill with an extra key is a 502', async () => {
    fetchMock.mockResolvedValueOnce(json([sampleBill()]));
    expect(await listVendorBills(session)).toHaveLength(1);
    expect(lastCall().url).toBe('http://api:3001/v1/portal/vendor/bills');

    fetchMock.mockResolvedValueOnce(json(sampleBill()));
    const bill = await getVendorBill(session, ID);
    expect(forbiddenPortalKeys(bill)).toEqual([]);
    expect(lastCall().url).toBe(`http://api:3001/v1/portal/vendor/bills/${ID}`);

    fetchMock.mockResolvedValueOnce(json({ ...sampleBill(), matchVariance: '1.00' }));
    expect(await statusOf(getVendorBill(session, ID))).toBe(502);
  });

  it('lists RFQs and reads one, with the id encoded as one path segment', async () => {
    fetchMock.mockResolvedValueOnce(json([sampleRfqListItem()]));
    expect(await listVendorRfqs(session)).toHaveLength(1);
    expect(lastCall().url).toBe('http://api:3001/v1/portal/vendor/rfqs');
    expect(lastCall().headers.get('authorization')).toBe('Bearer eyJ.secret-access-token.sig');

    fetchMock.mockResolvedValueOnce(json(sampleRfq()));
    const rfq = await getVendorRfq(session, ID);
    expect(forbiddenPortalKeys(rfq)).toEqual([]);
    expect(lastCall().url).toBe(`http://api:3001/v1/portal/vendor/rfqs/${ID}`);

    fetchMock.mockResolvedValueOnce(json(sampleRfq()));
    await getVendorRfq(session, '../bills');
    expect(lastCall().url).toContain('/rfqs/..%2Fbills');
  });

  it('refuses an RFQ with an extra key (an estimate) as a 502, and passes 403 and 404 through', async () => {
    fetchMock.mockResolvedValueOnce(json([{ ...sampleRfqListItem(), estimate: '100.00' }]));
    expect(await statusOf(listVendorRfqs(session))).toBe(502);
    fetchMock.mockResolvedValueOnce(json({ ...sampleRfq(), invitedVendors: ['x'] }));
    expect(await statusOf(getVendorRfq(session, ID))).toBe(502);
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'forbidden' } }, 403));
    expect(await statusOf(listVendorRfqs(session))).toBe(403);
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'not_found' } }, 404));
    expect(await statusOf(getVendorRfq(session, ID))).toBe(404);
  });
});
