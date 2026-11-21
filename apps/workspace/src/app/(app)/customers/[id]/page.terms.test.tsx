// The customer terms table as Sales (audit #16): each row names its legal entity from the account row itself,
// and says so plainly when the API sends no name.
import type React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ID = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';

const api = vi.hoisted(() => ({
  getCustomerDetail: vi.fn(),
  listContacts: vi.fn(),
  listVerificationCases: vi.fn(),
  listCustomerPaymentTerms: vi.fn().mockResolvedValue([]),
  listCustomerOwners: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
// A static render shows only the selected tab; render every panel so the terms tab can be read.
vi.mock('@/components/ui/tabs', () => ({
  Tabs: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Tab: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  TabPanel: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
}));
vi.mock('@/lib/bff', () => ({
  requireStaffSession: vi.fn().mockResolvedValue({ roles: ['sales'], accessToken: 't' }),
}));
vi.mock('@/lib/display-settings', () => ({ getNumberSystems: vi.fn().mockResolvedValue({}) }));
vi.mock('@/lib/business-labels', () => ({ userNames: vi.fn().mockResolvedValue(new Map()) }));
vi.mock('@/components/p2/customers/actions', () => ({ addContactAction: vi.fn() }));
vi.mock('@/components/p2/customers/contact-form', () => ({
  ContactForm: () => <span>Add contact</span>,
}));
vi.mock('../../verification/open-case-form', () => ({
  OpenCaseForm: ({ label }: { label: string }) => <button type="button">{label}</button>,
}));
vi.mock('@/components/p2/customers/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/p2/customers/api')>()),
  ...api,
}));

const { default: CustomerPage } = await import('./page');

const customer = (over: Record<string, unknown>) => ({
  id: ID,
  number: 'CUS-00042',
  legalName: 'Himalayan Traders Pvt. Ltd.',
  panVatNo: null,
  industry: null,
  relationship: 'active',
  ownerUserId: OWNER,
  defaultCurrency: 'NPR',
  address: { line1: 'Ring Road', city: 'Kathmandu', country: 'NP' },
  mergedIntoId: null,
  version: 1,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  accounts: [],
  people: [{ userId: OWNER, name: 'Sita Rai' }],
  ...over,
});

async function render(): Promise<string> {
  const html = renderToStaticMarkup(
    await CustomerPage({ params: Promise.resolve({ id: ID }), searchParams: Promise.resolve({}) }),
  );
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
}

beforeEach(() => {
  vi.clearAllMocks();
  api.listContacts.mockResolvedValue({ items: [], total: 0 });
  api.listVerificationCases.mockResolvedValue({ items: [], total: 0 });
  api.listCustomerOwners.mockResolvedValue([{ userId: OWNER, displayName: 'Sita Rai' }]);
});

const ENTITY = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';

describe('customer terms by legal entity', () => {
  it('names each legal entity from its terms row', async () => {
    api.getCustomerDetail.mockResolvedValue(
      customer({
        can: { write: true, readVerification: true, openVerification: true },
        accounts: [
          {
            partyId: ID,
            organizationId: ENTITY,
            organizationName: 'Techrida Nepal Pvt. Ltd.',
            paymentTermId: null,
            creditLimit: '50000.00',
            version: 1,
          },
          {
            partyId: ID,
            organizationId: OTHER,
            paymentTermId: null,
            creditLimit: null,
            version: 1,
          },
        ],
      }),
    );
    const text = await render();
    expect(text).toContain('Techrida Nepal Pvt. Ltd.');
    expect(text.match(/Legal entity name unavailable/g)?.length).toBe(1);
    expect(text).not.toContain(ENTITY);
  });

  it('shows credit limits in NPR, the currency they are held in, even for a customer that trades in USD', async () => {
    api.getCustomerDetail.mockResolvedValue(
      customer({
        defaultCurrency: 'USD',
        can: { write: true, readVerification: true, openVerification: true },
        accounts: [
          {
            partyId: ID,
            organizationId: ENTITY,
            organizationName: 'Techrida Nepal Pvt. Ltd.',
            paymentTermId: null,
            creditLimit: '50000.00',
            version: 1,
          },
        ],
      }),
    );
    const text = await render();
    expect(text).toMatch(/NPR\s*50,000\.00/);
    expect(text).not.toMatch(/USD\s*50,000/);
    expect(text).toContain('Credit limits are held in NPR');
  });
});

const CAN = {
  write: false,
  readVerification: false,
  openVerification: false,
  creditLimit: false,
  owner: false,
  paymentTerms: false,
};

describe('the Commercial terms card on the page', () => {
  const acting = {
    actingEntity: { organizationId: ENTITY, name: 'Techrida Nepal Pvt. Ltd.' },
    accounts: [
      {
        partyId: ID,
        organizationId: ENTITY,
        organizationName: 'Techrida Nepal Pvt. Ltd.',
        paymentTermId: null,
        creditLimit: '0.00',
        version: 2,
      },
      {
        partyId: ID,
        organizationId: OTHER,
        organizationName: 'Techrida Trading',
        paymentTermId: null,
        creditLimit: null,
        version: 1,
      },
    ],
  };

  it('asks for the people list only for someone who may change the owner (Management)', async () => {
    api.getCustomerDetail.mockResolvedValue(customer({ ...acting, can: { ...CAN, owner: true } }));
    const text = await render();
    expect(api.listCustomerOwners).toHaveBeenCalledTimes(1);
    expect(text).toContain('Change account owner');
    expect(text).not.toContain('Change credit limit');
    expect(text).not.toContain('Change payment terms');
  });

  it('never asks for the people list for Sales, and offers only the payment terms', async () => {
    api.getCustomerDetail.mockResolvedValue(
      customer({ ...acting, can: { ...CAN, write: true, paymentTerms: true } }),
    );
    const text = await render();
    expect(api.listCustomerOwners).not.toHaveBeenCalled();
    expect(text).toContain('Change payment terms');
    expect(text).not.toContain('Change account owner');
  });

  it("shows the acting entity's terms in the card, and every entity's in the read-only table", async () => {
    api.getCustomerDetail.mockResolvedValue(customer({ ...acting, can: CAN }));
    const text = await render();
    expect(text).toContain('Commercial terms');
    expect(text).toContain('agreed with Techrida Nepal Pvt. Ltd.');
    // The acting entity's zero limit, not the other entity's "no limit".
    expect(text).toContain('A zero limit holds any order unless the customer has enough credit');
    expect(text).toContain('Techrida Trading');
    expect(text).not.toContain('Change ');
  });
});
