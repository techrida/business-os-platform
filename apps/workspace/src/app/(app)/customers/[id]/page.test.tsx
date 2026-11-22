import { avatarColour, imagePath } from '@bos/contracts';
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
const LOGO = '77777777-7777-4777-8777-777777777777';

const customer = (over: Record<string, unknown> = {}) => ({
  id: CUSTOMER,
  number: 'CUS-00007',
  legalName: 'Himalayan Agro Foods Pvt. Ltd.',
  panVatNo: null,
  industry: null,
  relationship: 'active',
  ownerUserId: SALES,
  defaultCurrency: 'NPR',
  country: 'NP',
  address: { line: 'Durbar Marg 1', city: 'Kathmandu' },
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
let contactsBody: unknown = [];
// What the API answers a Sales user: the record, its contacts and cases, and 403 for the admin directory.
const fetchMock = vi.fn<typeof fetch>((input) => {
  const path = new URL(input as URL | string).pathname;
  if (path === `/v1/customers/${CUSTOMER}`) return Promise.resolve(json(200, detail));
  if (path === `/v1/customers/${CUSTOMER}/contacts`)
    return Promise.resolve(json(200, contactsBody));
  if (path === '/v1/verification-cases') return Promise.resolve(json(200, []));
  if (path === '/v1/payment-terms') return Promise.resolve(json(200, []));
  return Promise.resolve(
    json(403, { error: { code: 'forbidden', message: 'Forbidden', correlationId: 'c' } }),
  );
});

async function renderHtml(): Promise<string> {
  return renderToStaticMarkup(
    await CustomerPage({
      params: Promise.resolve({ id: CUSTOMER }),
      searchParams: Promise.resolve({}),
    }),
  );
}

async function render(): Promise<string> {
  return (await renderHtml()).replace(/<[^>]*>/g, ' ');
}

beforeEach(() => {
  mocks.requireStaffSession
    .mockReset()
    .mockResolvedValue({ accessToken: 'tok', roles: ['sales'], userId: SALES });
  fetchMock.mockClear();
  contactsBody = [];
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

describe('customer detail logo', () => {
  /** The markup of the "Customer logo" group: from its opening tag to the organization name after it. */
  const logoGroup = (html: string) => {
    const start = html.indexOf('aria-label="Customer logo"');
    expect(start).toBeGreaterThan(-1);
    return html.slice(start, html.indexOf('id="organization-name"', start));
  };

  it('uses an id whose seeded colour differs from the unseeded one, so the seed assertions bite', () => {
    expect(avatarColour(CUSTOMER)).not.toBe(avatarColour(null));
  });

  it('draws the logo seeded from the customer id, and lets a writer replace it', async () => {
    detail = customer({
      logoDocumentId: LOGO,
      people: [],
      can: { write: true, readVerification: false, openVerification: false },
    });
    const group = logoGroup(await renderHtml());
    expect(group).toContain(`--avatar-fill:${avatarColour(CUSTOMER)}`);
    expect(group).toContain(`src="${imagePath(LOGO)}"`);
    expect(group).toContain('type="file"');
  });

  it('shows the initials, still seeded from the id, when the customer has no logo', async () => {
    detail = customer({ people: [] });
    const group = logoGroup(await renderHtml());
    expect(group).toContain(`--avatar-fill:${avatarColour(CUSTOMER)}`);
    expect(group).not.toContain('<img');
  });

  it('is the picture only when the page offers no editing: a merged record', async () => {
    detail = customer({ logoDocumentId: LOGO, mergedIntoId: MATE, people: [] });
    const html = await renderHtml();
    const group = logoGroup(html);
    expect(group).toContain(`src="${imagePath(LOGO)}"`);
    expect(group).not.toContain('type="file"');
    expect(html).not.toContain('Edit Details');
  });

  it('is the picture only for roles without customer.write', async () => {
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 'tok', roles: [], userId: SALES });
    detail = customer({ logoDocumentId: LOGO, people: [] });
    const html = await renderHtml();
    expect(logoGroup(html)).not.toContain('type="file"');
    expect(html).not.toContain('Edit Details');
  });
});

describe('customer detail address and contact phones', () => {
  const contact = (over: Record<string, unknown>) => ({
    id: '99999999-9999-4999-8999-999999999999',
    customerId: CUSTOMER,
    fullName: 'Ana Bista',
    email: 'ana@himalayan.test',
    country: 'NP',
    phones: [],
    title: null,
    isPrimary: true,
    version: 1,
    ...over,
  });

  it('shows a Nepal address as street, city and country name', async () => {
    detail = customer({ people: [] });
    expect(await renderHtml()).toContain('Durbar Marg 1, Kathmandu, Nepal');
  });

  it("names a foreign customer's country", async () => {
    detail = customer({
      country: 'US',
      address: { line: '1 Market St', city: 'San Francisco' },
      people: [],
    });
    const html = await renderHtml();
    expect(html).toContain('1 Market St, San Francisco, United States');
    expect(html).not.toContain('Nepal');
  });

  it('links the primary phone of a contact with two numbers, not the other one', async () => {
    detail = customer({ people: [] });
    contactsBody = [
      contact({
        phones: [
          { country: 'US', e164: '+14155552671', label: 'work', isPrimary: true },
          { country: 'NP', e164: '+9779812345678', label: 'mobile', isPrimary: false },
        ],
      }),
    ];
    const html = await renderHtml();
    expect(html).toContain('href="tel:+14155552671"');
    expect(html).toContain('+1 415 555 2671');
    expect(html).not.toContain('9812345678');
  });

  it("names a contact's own country only when it differs from the customer's", async () => {
    detail = customer({ people: [] });
    contactsBody = [
      contact({ fullName: 'Ana Bista', country: 'NP' }),
      contact({
        id: '88888888-8888-4888-8888-888888888888',
        fullName: 'John Doe',
        email: null,
        country: 'GB',
        isPrimary: false,
      }),
    ];
    const html = await renderHtml();
    const table = html.slice(html.indexOf('<caption'), html.indexOf('</table>'));
    expect(table).toContain('United Kingdom');
    expect(table).not.toContain('Nepal');
  });
});
