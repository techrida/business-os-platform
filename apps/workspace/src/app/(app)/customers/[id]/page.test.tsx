import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetEnvForTests } from '@/lib/env';

import CustomerPage from './page';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireStaffSession: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('next/navigation', () => ({
  notFound: mocks.notFound,
  redirect: vi.fn(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const SALES = '33333333-3333-4333-8333-333333333333';
const MATE = '55555555-5555-4555-8555-555555555555';

const customer = (over: Record<string, unknown> = {}) => ({
  id: CUSTOMER,
  number: 'CUS-00007',
  legalName: 'Himalayan Agro Foods Pvt. Ltd.',
  panVatNo: null,
  industry: null,
  relationship: 'active',
  ownerUserId: SALES,
  defaultCurrency: 'NPR',
  address: { line1: 'Ring Road', city: 'Kathmandu', country: 'NP' },
  mergedIntoId: null,
  version: 2,
  createdAt: '2026-11-19T05:46:00.000Z',
  updatedAt: '2026-11-19T05:46:00.000Z',
  accounts: [],
  ...over,
});

/** The env the API client validates before any fetch; without it no request would reach the stub. */
function stubApiEnv() {
  for (const [k, v] of Object.entries({
    API_INTERNAL_URL: 'http://api:3001',
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
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let detail: unknown = customer();
// What the API answers a Sales user: the record, its contacts and cases, and 403 for the admin directory.
const fetchMock = vi.fn<typeof fetch>((input) => {
  const path = new URL(input as URL | string).pathname;
  if (path === `/v1/customers/${CUSTOMER}`) return Promise.resolve(json(200, detail));
  if (path === `/v1/customers/${CUSTOMER}/contacts`) return Promise.resolve(json(200, []));
  if (path === '/v1/verification-cases') return Promise.resolve(json(200, []));
  if (path === '/v1/payment-terms') return Promise.resolve(json(200, []));
  return Promise.resolve(
    json(403, { error: { code: 'forbidden', message: 'Forbidden', correlationId: 'c' } }),
  );
});

async function render(): Promise<string> {
  const html = renderToStaticMarkup(
    await CustomerPage({
      params: Promise.resolve({ id: CUSTOMER }),
      searchParams: Promise.resolve({}),
    }),
  );
  return html.replace(/<[^>]*>/g, ' ');
}

beforeEach(() => {
  mocks.requireStaffSession
    .mockReset()
    .mockResolvedValue({ accessToken: 'tok', roles: ['sales'], userId: SALES });
  fetchMock.mockClear();
  stubApiEnv();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('customer detail account owner', () => {
  it('names the owner from the record for a Sales user, who cannot read the admin directory', async () => {
    detail = customer({ people: [{ userId: SALES, name: 'Dev Sales' }] });
    const text = await render();
    expect(text).toContain('Dev Sales');
    expect(text).not.toContain('Owner name unavailable');
    const paths = fetchMock.mock.calls.map(([url]) => new URL(url as URL | string).pathname);
    expect(paths.some((p) => p.startsWith('/v1/admin'))).toBe(false);
  });

  it('names a different owner by the name the record carries for that owner', async () => {
    detail = customer({ ownerUserId: MATE, people: [{ userId: MATE, name: 'Mina Rai' }] });
    const text = await render();
    expect(text).toContain('Mina Rai');
  });

  it('says the name is unavailable when the record names nobody for the owner', async () => {
    detail = customer({ people: [] });
    expect(await render()).toContain('Owner name unavailable');
  });

  it('says Not assigned for a customer without an owner', async () => {
    detail = customer({ ownerUserId: null, people: [] });
    const text = await render();
    expect(text).toContain('Not assigned');
    expect(text).not.toContain('Owner name unavailable');
  });
});

describe('customer detail dates', () => {
  it('renders the same text, in Kathmandu time, whatever the server process time zone', async () => {
    detail = customer({ people: [{ userId: SALES, name: 'Dev Sales' }] });
    const before = process.env.TZ;
    try {
      process.env.TZ = 'America/Los_Angeles';
      const west = await render();
      process.env.TZ = 'Asia/Tokyo';
      const east = await render();
      expect(west).toContain('19 Nov 2026, 11:31');
      expect(east).toBe(west);
    } finally {
      process.env.TZ = before;
    }
  });
});
