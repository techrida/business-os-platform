// The customer page as Sales, from the API's record flags (audit #5 and #6): "Start verification" shows only when
// the API says this person may start a case on this customer, and a case they may not open is acknowledged
// instead of reported as missing. The case list is not even asked for without verification read on the record.
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ID = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';

const api = vi.hoisted(() => ({
  getCustomerDetail: vi.fn(),
  listContacts: vi.fn(),
  listVerificationCases: vi.fn(),
  listCustomerPaymentTerms: vi.fn().mockResolvedValue([]),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
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
  country: 'NP',
  address: { line: 'Ring Road', city: 'Kathmandu' },
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
});

describe('customer page verification panel as Sales', () => {
  it("does not offer to start a case on a colleague's customer that has one, and says a case exists", async () => {
    api.getCustomerDetail.mockResolvedValue(
      customer({
        can: { write: true, readVerification: false, openVerification: false },
        verification: { exists: true },
      }),
    );
    const text = await render();
    expect(text).not.toContain('Start verification');
    expect(text).not.toContain('No verification case yet');
    expect(text).toContain('This customer has a verification case.');
    // Not readable on this record, so the list (a 404 or an empty answer for Sales) is never asked for.
    expect(api.listVerificationCases).not.toHaveBeenCalled();
    // Write is per record too: Sales may still edit this customer.
    expect(text).toContain('Edit Details');
  });

  it('offers Start verification on their own customer with no case', async () => {
    api.getCustomerDetail.mockResolvedValue(
      customer({
        can: { write: true, readVerification: true, openVerification: true },
        verification: { exists: false },
      }),
    );
    const text = await render();
    expect(text).toContain('Start verification');
    expect(api.listVerificationCases).toHaveBeenCalledWith(expect.anything(), { partyId: ID });
  });

  it('shows no write or verification controls when the API sends no flags', async () => {
    api.getCustomerDetail.mockResolvedValue(customer({}));
    const text = await render();
    expect(text).not.toContain('Start verification');
    expect(text).not.toContain('Edit Details');
    expect(text).not.toContain('Add contact');
  });
});
