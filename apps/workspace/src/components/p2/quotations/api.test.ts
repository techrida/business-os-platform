import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import { __resetEnvForTests } from '@/lib/env';
import type { Session } from '@/lib/session';

import { getQuotation, getQuotationsSummary, listQuotations, listQuotationsPage } from './api';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const WHEN = '2026-11-08T05:45:00.000Z';

const session: Session = {
  id: 'A'.repeat(43),
  sub: 'user-1',
  orgId: ID_A,
  orgKind: 'staff',
  roles: ['sales'],
  accessToken: 'eyJ.secret-access-token.sig',
  accessExp: 2_000_000_000,
  createdAt: 1_700_000_000,
  lastSeenAt: 1_700_000_000,
};

const parent = {
  id: ID_A,
  number: 'QT-2082-0042',
  customerId: ID_B,
  opportunityId: ID_B,
  currentVersionId: ID_B,
  ownerUserId: null,
  status: 'draft',
  version: 1,
  createdAt: WHEN,
  updatedAt: WHEN,
};

const listItem = {
  ...parent,
  customerName: 'Big Kahuna Burger Ltd.',
  currency: 'NPR',
  total: '2690999.99',
  validUntil: '2026-11-23',
  ownerName: null,
  canEdit: true,
};

function reply(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const fetchMock = vi.fn<typeof fetch>();

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
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function calledUrl(): URL {
  return new URL(fetchMock.mock.calls[0]?.[0] as URL | string);
}

describe('listQuotations', () => {
  it('asks for the bare list and parses an array', async () => {
    fetchMock.mockResolvedValue(reply(200, [listItem]));
    const items = await listQuotations(session);
    expect(items).toHaveLength(1);
    expect(items[0]?.customerName).toBe('Big Kahuna Burger Ltd.');
    expect(calledUrl().pathname).toBe('/v1/quotations');
    // Callers of this helper want every row, so it sends no limit and the API returns every match.
    expect(calledUrl().search).toBe('');
  });

  it('passes the status filter in the query string', async () => {
    fetchMock.mockResolvedValue(reply(200, []));
    await listQuotations(session, { status: 'sent' });
    expect(calledUrl().searchParams.get('status')).toBe('sent');
    expect(calledUrl().searchParams.has('opportunityId')).toBe(false);
    expect(calledUrl().searchParams.has('limit')).toBe(false);
  });

  it('passes the opportunity filter, alone or with a status', async () => {
    const opportunityId = '3f1d2c3b-0d52-4d1e-9d8a-4f6c7a5e4a5f';
    fetchMock.mockResolvedValue(reply(200, []));
    await listQuotations(session, { opportunityId });
    expect(calledUrl().searchParams.get('opportunityId')).toBe(opportunityId);
    expect(calledUrl().searchParams.has('status')).toBe(false);
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(reply(200, []));
    await listQuotations(session, { opportunityId, status: 'draft' });
    expect(calledUrl().searchParams.get('opportunityId')).toBe(opportunityId);
    expect(calledUrl().searchParams.get('status')).toBe('draft');
  });

  it('lets a caller choose its own limit', async () => {
    fetchMock.mockResolvedValue(reply(200, []));
    await listQuotations(session, { limit: 20 });
    expect(calledUrl().searchParams.getAll('limit')).toEqual(['20']);
  });

  it('turns a body that breaks the contract into a 502, never undefined fields', async () => {
    fetchMock.mockResolvedValue(reply(200, [{ ...listItem, total: 2690999.99 }]));
    await expect(listQuotations(session)).rejects.toMatchObject({ status: 502 });
  });

  it('keeps the upstream status, so the page can show a no-access state for 403', async () => {
    fetchMock.mockResolvedValue(reply(403, { error: { code: 'forbidden' } }));
    const err = await listQuotations(session).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
  });

  it('never puts the access token in an error message', async () => {
    fetchMock.mockResolvedValue(reply(500, { error: { code: 'internal' } }));
    const err = await listQuotations(session).catch((e: unknown) => e);
    expect((err as Error).message).not.toContain(session.accessToken);
  });
});

describe('listQuotationsPage', () => {
  const WINDOW = { limit: 25, offset: 0 };
  const CUSTOMER_A = '3f1d2c3b-0d52-4d1e-9d8a-4f6c7a5e4a5f';
  const CUSTOMER_B = '9b1d2c3b-0d52-4d1e-9d8a-4f6c7a5e4a5f';

  it('repeats multi filters, sends the window and reads the total from the header', async () => {
    fetchMock.mockResolvedValue(reply(200, [listItem], { 'x-total-count': '41' }));
    const result = await listQuotationsPage(session, {
      status: ['draft', 'sent'],
      customerId: [CUSTOMER_A, CUSTOMER_B],
      q: ' himal ',
      limit: 10,
      offset: 20,
    });
    expect(result.total).toBe(41);
    expect(result.items).toHaveLength(1);
    const params = calledUrl().searchParams;
    expect(params.getAll('status')).toEqual(['draft', 'sent']);
    expect(params.getAll('customerId')).toEqual([CUSTOMER_A, CUSTOMER_B]);
    expect(params.get('q')).toBe('himal');
    expect(params.get('limit')).toBe('10');
    expect(params.get('offset')).toBe('20');
  });

  it('drops values the API would refuse, keeping the window it was given', async () => {
    fetchMock.mockResolvedValue(reply(200, [], { 'x-total-count': '0' }));
    await listQuotationsPage(session, {
      limit: 25,
      offset: 0,
      status: ['nonsense', 'draft', 'draft'],
      customerId: 'not-an-id',
      opportunityId: '../x',
      q: '  ',
    });
    expect(calledUrl().search).toBe('?status=draft&limit=25&offset=0');
  });

  it.each([[null], ['abc'], ['-1']])('fails with 502 when X-Total-Count is %s', async (value) => {
    fetchMock.mockResolvedValue(
      reply(200, [listItem], value === null ? {} : { 'x-total-count': value }),
    );
    await expect(listQuotationsPage(session, WINDOW)).rejects.toMatchObject({ status: 502 });
  });

  it('keeps the upstream status for a refusal', async () => {
    fetchMock.mockResolvedValue(reply(403, { error: { code: 'forbidden' } }));
    await expect(listQuotationsPage(session, WINDOW)).rejects.toMatchObject({ status: 403 });
  });
});

describe('getQuotationsSummary', () => {
  const byStatus = {
    draft: 2,
    submitted: 1,
    returned: 0,
    approved: 0,
    sent: 3,
    accepted: 4,
    rejected: 0,
    expired: 0,
    cancelled: 0,
    superseded: 0,
  };

  it('sends only the scope and search, never status or paging', async () => {
    fetchMock.mockResolvedValue(reply(200, { total: 10, byStatus }));
    // A caller that hands over its whole list filter must not make the strict summary answer 400.
    const listFilter = {
      customerId: [ID_A, ID_B],
      opportunityId: ID_B,
      q: 'himal',
      status: 'draft',
      limit: 5,
      offset: 5,
    };
    const summary = await getQuotationsSummary(session, listFilter);
    expect(summary.byStatus.accepted).toBe(4);
    expect(calledUrl().pathname).toBe('/v1/quotations/summary');
    const params = calledUrl().searchParams;
    expect(params.getAll('customerId')).toEqual([ID_A, ID_B]);
    expect(params.get('opportunityId')).toBe(ID_B);
    expect(params.get('q')).toBe('himal');
    for (const name of ['status', 'limit', 'offset']) expect(params.has(name)).toBe(false);
  });

  it('turns a body that breaks the contract into a 502', async () => {
    fetchMock.mockResolvedValue(reply(200, { total: 1 }));
    await expect(getQuotationsSummary(session)).rejects.toMatchObject({ status: 502 });
  });
});

describe('getQuotation', () => {
  const detail = {
    quotation: parent,
    versions: [],
    statusHistory: [],
    customerName: 'Big Kahuna Burger Ltd.',
    contacts: [{ id: ID_B, name: 'Jules', email: null }],
    capabilities: { canEdit: true, canRevise: false },
  };

  it('encodes the id as one path segment', async () => {
    fetchMock.mockResolvedValue(reply(200, detail));
    await getQuotation(session, '../admin');
    expect(calledUrl().pathname).toBe('/v1/quotations/..%2Fadmin');
  });

  it('parses the detail shape', async () => {
    fetchMock.mockResolvedValue(reply(200, detail));
    const got = await getQuotation(session, ID_A);
    expect(got.quotation.number).toBe('QT-2082-0042');
    expect(got.contacts[0]?.email).toBeNull();
  });

  it('keeps the lifecycle fields the contract does not describe yet, from the same body', async () => {
    fetchMock.mockResolvedValue(
      reply(200, {
        ...detail,
        capabilities: { ...detail.capabilities, canCancel: false, canConfirmAcceptance: true },
      }),
    );
    const got = await getQuotation(session, ID_A);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(got.lifecycle).toEqual({
      canCancel: false,
      canConfirmAcceptance: true,
      confirmations: {},
    });
  });

  it('reads no lifecycle answers from a body that has none', async () => {
    fetchMock.mockResolvedValue(reply(200, detail));
    const got = await getQuotation(session, ID_A);
    expect(got.lifecycle).toEqual({
      canCancel: undefined,
      canConfirmAcceptance: undefined,
      confirmations: {},
    });
  });

  it('turns a detail without history into a 502', async () => {
    const { statusHistory: _omitted, ...broken } = detail;
    fetchMock.mockResolvedValue(reply(200, broken));
    await expect(getQuotation(session, ID_A)).rejects.toMatchObject({ status: 502 });
  });
});
