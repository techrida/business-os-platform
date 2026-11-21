// The customer page's Portal access panel (F1-Q31), from the API's `portalAccess` block: the first portal admin is
// invited by the account owner, and the invite offers only the customer's existing contacts (a contact without an
// email is listed but cannot be chosen). Everyone else is told who invites the first admin.
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
vi.mock('@/components/p2/customers/actions', () => ({
  addContactAction: vi.fn(),
  invitePortalAdminAction: vi.fn(),
}));
vi.mock('@/components/p2/customers/portal-invite-form', () => ({
  PortalInviteForm: ({
    contacts,
    first,
  }: {
    contacts: Array<{ id: string; label: string; hasEmail: boolean }>;
    first: boolean;
  }) => (
    <div>
      <button type="button">{first ? 'Invite portal admin' : 'Invite portal user'}</button>
      <ul>
        {contacts.map((c) => (
          <li key={c.id}>{`option ${c.label}${c.hasEmail ? '' : ' disabled'}`}</li>
        ))}
      </ul>
    </div>
  ),
}));
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
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ');
}

beforeEach(() => {
  vi.clearAllMocks();
  api.listContacts.mockResolvedValue({ items: [], total: 0 });
  api.listVerificationCases.mockResolvedValue({ items: [], total: 0 });
});

const WRITE = { write: true, readVerification: true, openVerification: false };
const CONTACTS = {
  items: [
    {
      id: '33333333-3333-4333-8333-333333333333',
      customerId: ID,
      fullName: 'Ana Bista',
      email: 'ana@himalayan.test',
      phone: null,
      title: null,
      isPrimary: true,
      version: 1,
    },
    {
      id: '44444444-4444-4444-8444-444444444444',
      customerId: ID,
      fullName: 'Bikash Thapa',
      email: null,
      phone: null,
      title: null,
      isPrimary: false,
      version: 1,
    },
  ],
  total: 2,
};

describe('customer page portal access panel (F1-Q31)', () => {
  it("offers the account owner the first-admin invite with the customer's own contacts only", async () => {
    api.listContacts.mockResolvedValue(CONTACTS);
    api.getCustomerDetail.mockResolvedValue(
      customer({ can: WRITE, portalAccess: { hasUser: false, canInvite: true, blocked: null } }),
    );
    const text = await render();
    expect(text).toContain('Portal access');
    expect(text).toContain('Invite portal admin');
    expect(text).toContain('option Ana Bista (ana@himalayan.test)');
    expect(text).toContain('option Bikash Thapa disabled');
  });

  it('names the account owner to anyone else who may change the customer, with no invite', async () => {
    api.listContacts.mockResolvedValue(CONTACTS);
    api.getCustomerDetail.mockResolvedValue(
      customer({
        can: WRITE,
        portalAccess: { hasUser: false, canInvite: false, blocked: 'owner_only' },
      }),
    );
    const text = await render();
    expect(text).toContain('The account owner, Sita Rai, invites the first portal admin.');
    expect(text).not.toContain('Invite portal admin');
  });

  it('asks for an account owner when the customer has none', async () => {
    api.getCustomerDetail.mockResolvedValue(
      customer({
        ownerUserId: null,
        people: [],
        can: WRITE,
        portalAccess: { hasUser: false, canInvite: false, blocked: 'owner_missing' },
      }),
    );
    const text = await render();
    expect(text).toContain(
      'It has no account owner, and the account owner invites the first portal admin.',
    );
    expect(text).not.toContain('Invite portal admin');
  });

  it('says KYB comes first instead of offering an invite the API would refuse', async () => {
    api.listContacts.mockResolvedValue(CONTACTS);
    api.getCustomerDetail.mockResolvedValue(
      customer({
        can: WRITE,
        portalAccess: { hasUser: false, canInvite: false, blocked: 'kyb_not_verified' },
      }),
    );
    const text = await render();
    expect(text).toContain(
      "Portal access opens once this customer's KYB verification is approved.",
    );
    expect(text).not.toContain('Invite portal admin');
  });

  it('offers later invites once the portal has a user', async () => {
    api.listContacts.mockResolvedValue(CONTACTS);
    api.getCustomerDetail.mockResolvedValue(
      customer({ can: WRITE, portalAccess: { hasUser: true, canInvite: true, blocked: null } }),
    );
    const text = await render();
    expect(text).toContain('Portal access Active');
    expect(text).toContain('Invite portal user');
  });

  it('shows the state, with no invite, to a reader who may not change the customer and on a merged record', async () => {
    // Portal access is one row of the Commercial terms card: everyone who opens the customer sees its state.
    api.listContacts.mockResolvedValue(CONTACTS);
    api.getCustomerDetail.mockResolvedValue(
      customer({ portalAccess: { hasUser: false, canInvite: false, blocked: null } }),
    );
    const reader = await render();
    expect(reader).toContain('Portal access Not invited');
    expect(reader).not.toContain('Invite portal');
    // A merged record offers no invite even if the flag says otherwise: the page checks it too.
    api.getCustomerDetail.mockResolvedValue(
      customer({
        can: WRITE,
        mergedIntoId: '55555555-5555-4555-8555-555555555555',
        portalAccess: { hasUser: true, canInvite: true, blocked: null },
      }),
    );
    const merged = await render();
    expect(merged).toContain('Portal access Active');
    expect(merged).not.toContain('Invite portal');
  });
});
