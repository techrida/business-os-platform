// @vitest-environment jsdom
import type { CustomerDto } from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

import CustomersPage from './page';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireStaffSession: vi.fn(),
  listCustomers: vi.fn(),
  listCustomerIndustries: vi.fn(),
  countCustomersByRelationship: vi.fn(),
}));
vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
// GET /v1/me for an unedited role answers the role's default grants.
vi.mock('@/lib/grants', async () => {
  const { DEFAULT_ROLE_PERMISSIONS } = await import('@bos/contracts');
  return {
    getGrants: (session: { roles: string[] }) =>
      Promise.resolve(
        new Map(
          session.roles.flatMap((r) =>
            Object.entries(
              DEFAULT_ROLE_PERMISSIONS[r as keyof typeof DEFAULT_ROLE_PERMISSIONS] ?? {},
            ),
          ),
        ),
      ),
    hasGrant: (g: Map<string, string>, p: string) => g.has(p),
  };
});
vi.mock('@/components/p2/customers/api', () => ({
  listCustomers: mocks.listCustomers,
  listCustomerIndustries: mocks.listCustomerIndustries,
  countCustomersByRelationship: mocks.countCustomersByRelationship,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/customers',
  useSearchParams: () => new URLSearchParams(),
}));

const ID = '11111111-1111-4111-8111-111111111111';
const MERGED = '22222222-2222-4222-8222-222222222222';
const WHEN = '2026-11-08T05:45:00.000Z';

const customer = {
  id: ID,
  number: 'CUS-0001',
  legalName: 'Himal Traders Pvt. Ltd.',
  panVatNo: '301234567',
  industry: 'Retail',
  relationship: 'active',
  ownerUserId: null,
  defaultCurrency: 'NPR',
  country: 'NP',
  address: { line: 'Balaju', city: 'Kathmandu' },
  mergedIntoId: null,
  version: 1,
  createdAt: WHEN,
  updatedAt: WHEN,
} satisfies CustomerDto;

async function render(): Promise<string> {
  return renderToStaticMarkup(await CustomersPage({ searchParams: Promise.resolve({}) }));
}

beforeEach(() => {
  mocks.requireStaffSession.mockReset().mockResolvedValue({ accessToken: 'tok', roles: ['sales'] });
  mocks.listCustomers.mockReset().mockResolvedValue({ items: [customer], total: 1 });
  mocks.listCustomerIndustries.mockReset().mockResolvedValue(['Retail']);
  mocks.countCustomersByRelationship
    .mockReset()
    .mockResolvedValue({ prospect: 7, active: 30, inactive: 2 });
});

describe('customers list page', () => {
  it('names each owner in an Owner column from the list row, and no one without an owner (U15a-Q3)', async () => {
    const OWNER = '33333333-3333-4333-8333-333333333333';
    mocks.listCustomers.mockResolvedValue({
      items: [
        { ...customer, ownerUserId: OWNER, ownerName: 'Anil Karki' },
        // An older payload without the field reads as no owner, never an id.
        { ...customer, id: MERGED, legalName: 'Kathmandu Steel', ownerUserId: OWNER },
      ],
      total: 2,
    });
    const doc = new DOMParser().parseFromString(await render(), 'text/html');
    const headers = [...doc.querySelectorAll('thead th')].map((th) => th.textContent?.trim());
    const column = headers.indexOf('Owner');
    expect(column).toBeGreaterThan(-1);
    const owners = [...doc.querySelectorAll('tbody tr')].map((tr) =>
      tr.querySelectorAll('td')[column]?.textContent?.trim(),
    );
    expect(owners[0]).toContain('Anil Karki');
    expect(owners[1]).toBe('No owner');
    expect(doc.body.innerHTML).not.toContain(OWNER);
  });

  // FX9: one combined column with the city and the country's name; no street line and no phone in the list.
  it("shows each organization's city and country name in a Location column", async () => {
    mocks.listCustomers.mockResolvedValue({
      items: [
        { ...customer, address: { line: 'Lakeside Road 6', city: 'Pokhara' } },
        {
          ...customer,
          id: MERGED,
          legalName: 'Bay Area Imports Inc.',
          panVatNo: null,
          country: 'US',
          address: { line: '500 Howard Street', city: 'San Francisco' },
        },
      ],
      total: 2,
    });
    const doc = new DOMParser().parseFromString(await render(), 'text/html');
    const headers = [...doc.querySelectorAll('thead th')].map((th) => th.textContent?.trim());
    const column = headers.indexOf('Location');
    expect(column).toBe(headers.indexOf('Organization') + 1);
    const cells = [...doc.querySelectorAll('tbody tr')].map((tr) =>
      tr.querySelectorAll('td')[column]?.textContent?.trim(),
    );
    expect(cells).toEqual(['Pokhara, Nepal', 'San Francisco, United States']);
    expect(doc.body.textContent).not.toContain('Lakeside Road 6');
    expect(doc.body.textContent).not.toContain('500 Howard Street');
  });

  it('draws the four cards from the relationship counts, the total being their sum', async () => {
    const html = await render();
    expect(html).toContain('aria-label="Organizations by relationship"');
    for (const label of ['Organizations', 'Active', 'Prospects', 'Inactive']) {
      expect(html).toContain(`>${label}</dt>`);
    }
    expect(html).toContain('>39<');
    expect(html).toContain('>30<');
    expect(html).toContain('>7<');
    expect(html).toContain('>2<');
  });

  it('leaves the cards out, not at zero, when the counts cannot be read', async () => {
    mocks.countCustomersByRelationship.mockResolvedValue(null);
    const html = await render();
    expect(html).not.toContain('Organizations by relationship');
    expect(html).toContain('Himal Traders Pvt. Ltd.');
  });

  it('puts the row actions in a kebab button named for the row, for people who can write', async () => {
    const html = await render();
    expect(html).toContain('aria-label="Actions for Himal Traders Pvt. Ltd."');
    expect(html).not.toContain('>Edit<');
  });

  it('shows no kebab to a role that cannot write, and none for a merged record', async () => {
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 'tok', roles: ['viewer'] });
    expect(await render()).not.toContain('Actions for');
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 'tok', roles: ['sales'] });
    mocks.listCustomers.mockResolvedValue({
      items: [{ ...customer, mergedIntoId: MERGED }],
      total: 1,
    });
    expect(await render()).not.toContain('Actions for');
  });

  it('says so when the roles do not include organizations', async () => {
    mocks.listCustomers.mockRejectedValue(new ApiError(403, 'no'));
    const html = await render();
    expect(html).toContain('Your roles do not include organizations');
  });
});
