// The not-verified banner and the Verification card's position on the customer page, state by state.
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

const html = async (): Promise<string> =>
  renderToStaticMarkup(
    await CustomerPage({ params: Promise.resolve({ id: ID }), searchParams: Promise.resolve({}) }),
  );
const textOf = (h: string) =>
  h
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ');

const CASE = '33333333-3333-4333-8333-333333333333';
const kase = (status: string) => ({ id: CASE, partyId: ID, status, checklist: [] });
const reader = { write: true, readVerification: true, openVerification: true };

beforeEach(() => {
  vi.clearAllMocks();
  api.listContacts.mockResolvedValue({ items: [], total: 0 });
  api.listVerificationCases.mockResolvedValue({ items: [], total: 0 });
});

/** The Verification card comes before the profile card (first in the right column), or after it. */
const cardFirst = (h: string) => {
  const card = h.indexOf('id="verification"');
  expect(card).toBeGreaterThan(-1);
  return card < h.indexOf('Organization Information');
};

describe('not-verified banner and card position', () => {
  it('no case: banner offers Start verification, card is first', async () => {
    api.getCustomerDetail.mockResolvedValue(
      customer({ can: reader, verification: { exists: false } }),
    );
    const h = await html();
    const t = textOf(h);
    expect(t).toContain("This customer isn't verified yet");
    expect(t).toContain('No verification case has been started.');
    expect(t).toContain('Portal invites stay closed until the KYB verification is approved.');
    expect(h).toContain('href="#verification"');
    expect(h).toContain('role="status"');
    expect(cardFirst(h)).toBe(true);
  });

  it.each([
    ['draft', 'Continue verification', 'not yet submitted'],
    ['submitted', 'Review submission', 'waiting for review'],
    ['rejected', 'Open the case', 'was rejected'],
  ])('%s case: banner says so and links to the case', async (status, label, words) => {
    api.getCustomerDetail.mockResolvedValue(
      customer({ can: reader, verification: { exists: true } }),
    );
    api.listVerificationCases.mockResolvedValue({ items: [kase(status)], total: 1 });
    const h = await html();
    expect(textOf(h)).toContain(words);
    expect(h).toContain(`href="/verification/${CASE}">${label}</a>`);
    expect(cardFirst(h)).toBe(true);
  });

  it('expired case: banner offers Reopen verification on the card', async () => {
    api.getCustomerDetail.mockResolvedValue(
      customer({ can: reader, verification: { exists: true } }),
    );
    api.listVerificationCases.mockResolvedValue({ items: [kase('expired')], total: 1 });
    const h = await html();
    expect(h).toContain('href="#verification">Reopen verification</a>');
  });

  it('approved: no banner and the card is back in its place after the profile', async () => {
    api.getCustomerDetail.mockResolvedValue(
      customer({ can: reader, verification: { exists: true } }),
    );
    api.listVerificationCases.mockResolvedValue({ items: [kase('approved')], total: 1 });
    const h = await html();
    expect(textOf(h)).not.toContain("isn't verified yet");
    expect(h).toContain('id="verification"');
    expect(cardFirst(h)).toBe(false);
  });

  it('an approved case wins over an older rejected one', async () => {
    api.getCustomerDetail.mockResolvedValue(
      customer({ can: reader, verification: { exists: true } }),
    );
    api.listVerificationCases.mockResolvedValue({
      items: [
        kase('rejected'),
        { ...kase('approved'), id: '44444444-4444-4444-8444-444444444444' },
      ],
      total: 2,
    });
    expect(textOf(await html())).not.toContain("isn't verified yet");
  });

  it('without verification read: plain message and no action when KYB blocks the portal', async () => {
    api.getCustomerDetail.mockResolvedValue(
      customer({
        can: { write: true, readVerification: false, openVerification: false },
        verification: { exists: true },
        portalAccess: { hasUser: false, canInvite: false, blocked: 'kyb_not_verified' },
      }),
    );
    const h = await html();
    expect(textOf(h)).toContain("This customer isn't verified yet");
    expect(h).not.toContain('Start verification');
    expect(h).not.toContain('Continue verification');
    expect(h).not.toContain('Review submission');
    expect(h).not.toContain('href="#verification"');
    expect(api.listVerificationCases).not.toHaveBeenCalled();
  });

  it('without verification read and no signal: no banner, nothing is guessed', async () => {
    api.getCustomerDetail.mockResolvedValue(
      customer({
        can: { write: true, readVerification: false, openVerification: false },
        verification: { exists: true },
      }),
    );
    const h = await html();
    expect(textOf(h)).not.toContain("isn't verified yet");
    expect(cardFirst(h)).toBe(false);
  });

  it('an empty list while the record says a case exists is not reported as no case', async () => {
    api.getCustomerDetail.mockResolvedValue(
      customer({ can: reader, verification: { exists: true } }),
    );
    const t = textOf(await html());
    expect(t).toContain("This customer isn't verified yet");
    expect(t).toContain('A verification case exists but is not approved.');
    expect(t).not.toContain('No verification case has been started.');
  });

  it('a failed case list shows no banner', async () => {
    api.getCustomerDetail.mockResolvedValue(
      customer({ can: reader, verification: { exists: true } }),
    );
    api.listVerificationCases.mockRejectedValue(new Error('down'));
    expect(textOf(await html())).not.toContain("isn't verified yet");
  });
});
