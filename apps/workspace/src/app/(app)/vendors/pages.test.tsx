import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));
const session = vi.hoisted(() => ({ roles: ['procurement'] as string[] }));
vi.mock('@/lib/bff', () => ({
  requireStaffSession: () => Promise.resolve({ roles: session.roles }),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/vendors',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('./actions', () => ({
  addContactAction: vi.fn(),
  decideBankAction: vi.fn(),
  grantPortalAction: vi.fn(),
  lifecycleAction: vi.fn(),
  proposeBankAction: vi.fn(),
}));
const api = vi.hoisted(() => ({
  listVendors: vi.fn(),
  getVendor: vi.fn(),
  listVendorContacts: vi.fn(),
  listVendorAccounts: vi.fn(),
  listBankAccounts: vi.fn(),
}));
vi.mock('@/lib/api-vendors', () => api);
const kyb = vi.hoisted(() => ({ listVerificationCases: vi.fn() }));
vi.mock('@/components/p2/customers/api', () => kyb);

const { default: VendorsPage } = await import('./page');
const { default: VendorPage } = await import('./[id]/page');

const ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const ORG = '33333333-3333-4333-8333-333333333333';

const apiError = (status: number, code = 'x', extra: Record<string, unknown> = {}) =>
  new ApiError(status, 'x', {
    error: { code, message: 'internal wording', correlationId: 'corr-12345678', ...extra },
  });

const vendor = (over: Record<string, unknown> = {}) => ({
  id: ID,
  legalName: 'Himal Traders Pvt. Ltd.',
  tradeName: null,
  kind: 'company',
  pan: '301234567',
  vatRegistered: true,
  country: 'NP',
  status: 'draft',
  version: 1,
  approvedAt: null,
  ...over,
});

const bank = (over: Record<string, unknown> = {}) => ({
  id: ACCOUNT,
  vendorPartyId: ID,
  bankName: 'Nabil Bank',
  branch: null,
  accountName: 'Himal Traders',
  accountLast4: '4455',
  status: 'proposed',
  proposedVia: 'staff',
  verifiedAt: null,
  ...over,
});

const html = (el: unknown) => renderToStaticMarkup(el as React.ReactElement);
const list = async (sp: Record<string, string | string[]> = {}) =>
  html(await VendorsPage({ searchParams: Promise.resolve(sp) }));
const detail = async () =>
  html(
    await VendorPage({
      params: Promise.resolve({ id: ID }),
      searchParams: Promise.resolve({}),
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  session.roles = ['procurement'];
  api.listVendorContacts.mockResolvedValue([]);
  api.listVendorAccounts.mockResolvedValue([]);
  api.listBankAccounts.mockResolvedValue([]);
  kyb.listVerificationCases.mockResolvedValue({ items: [], total: null });
});

describe('vendor list', () => {
  it('shows the rows with their status, kind and PAN, and the add button for writers', async () => {
    api.listVendors.mockResolvedValue({
      items: [
        vendor({ status: 'approved' }),
        vendor({
          id: ACCOUNT,
          legalName: 'Foreign Ltd',
          kind: 'foreign',
          pan: null,
          country: 'IN',
          status: 'pending_kyc',
        }),
      ],
      total: 2,
    });
    const out = await list();
    expect(out).toContain('Himal Traders Pvt. Ltd.');
    expect(out).toContain('Approved');
    expect(out).toContain('KYC pending');
    expect(out).toContain('Foreign vendor');
    expect(out).toContain('301234567');
    expect(out).toContain('Add vendor');
    expect(out).toContain('2 vendors');
    expect(out).toContain('type="search"');
    expect(out).not.toContain('>Apply<');
    expect(out).toContain(`/vendors/${ID}`);
  });

  it('hides the add button without vendor.write', async () => {
    session.roles = ['finance'];
    api.listVendors.mockResolvedValue({ items: [vendor()], total: 1 });
    expect(await list()).not.toContain('Add vendor');
  });

  it('forwards the search, repeated statuses and kinds and the page window, ignoring unknown values', async () => {
    api.listVendors.mockResolvedValue({ items: [], total: 0 });
    await list({
      q: 'Himal',
      status: ['draft', 'weird', 'approved'],
      kind: 'sole_proprietor',
      page: '3',
      rows: '10',
    });
    expect(api.listVendors).toHaveBeenLastCalledWith(expect.anything(), {
      q: 'Himal',
      status: ['draft', 'approved'],
      kind: ['sole_proprietor'],
      limit: 10,
      offset: 20,
    });
    await list({ status: 'weird' });
    expect(api.listVendors).toHaveBeenLastCalledWith(expect.anything(), { limit: 25, offset: 0 });
  });

  it('cuts a very long search before it reaches the API', async () => {
    api.listVendors.mockResolvedValue({ items: [], total: 0 });
    await list({ q: 'x'.repeat(300) });
    const query = api.listVendors.mock.calls.at(-1)?.[1] as { q: string };
    expect(query.q).toHaveLength(100);
  });

  it('has three different empty states: none yet, filtered, and past the last page', async () => {
    api.listVendors.mockResolvedValue({ items: [], total: 0 });
    expect(await list()).toContain('No vendors yet.');
    const searched = await list({ q: 'zzz' });
    expect(searched).toContain('No vendors match.');
    expect(searched).toContain('Hidden by Search');
    expect(searched).toContain('zzz');
    const filtered = await list({ q: 'zzz', status: ['blocked', 'archived'], rows: '50' });
    expect(filtered).toContain('Status: Blocked, Archived');
    expect(filtered).toContain('Clear filters');
    expect(filtered).toContain('href="/vendors?rows=50"');
    expect(await list({ page: '4' })).toContain('There are no more vendors.');
  });

  it('a 403 is a no-access note without a retry link', async () => {
    api.listVendors.mockRejectedValue(apiError(403, 'forbidden', { reason: 'no_permission' }));
    const out = await list();
    expect(out).toContain('Your roles do not include vendors');
    expect(out).not.toContain('Reload vendors');
  });

  it('a failure offers a reload and never shows the API wording', async () => {
    api.listVendors.mockRejectedValue(apiError(500, 'internal'));
    const out = await list();
    expect(out).toContain('Vendors did not load');
    expect(out).toContain('Reload vendors');
    expect(out).not.toContain('internal wording');
  });

  it('a 502 from a body that broke the contract reads as a failure, not a crash', async () => {
    api.listVendors.mockRejectedValue(new ApiError(502, 'invalid body', []));
    expect(await list()).toContain('Vendors did not load');
  });

  it('wraps a long unbroken name instead of widening the table', async () => {
    api.listVendors.mockResolvedValue({
      items: [vendor({ legalName: 'A'.repeat(200) })],
      total: 1,
    });
    expect(await list()).toContain('A'.repeat(200));
  });

  it('shows a next link while there are more pages', async () => {
    api.listVendors.mockResolvedValue({ items: [vendor()], total: 60 });
    const out = await list();
    expect(out).toContain('Showing 1 of 60 vendors');
    expect(out).toContain('Showing 1 to 1 of 60');
    expect(out).toContain('/vendors?page=2');
  });
});

describe('vendor detail', () => {
  it('a 404 is the not-found page, a 403 is a no-access note, anything else offers a retry', async () => {
    api.getVendor.mockRejectedValue(apiError(404, 'not_found'));
    await expect(detail()).rejects.toThrow('NOT_FOUND');
    api.getVendor.mockRejectedValue(apiError(403, 'forbidden'));
    expect(await detail()).toContain('You cannot open this vendor');
    api.getVendor.mockRejectedValue(apiError(500, 'internal'));
    const out = await detail();
    expect(out).toContain('This vendor did not load');
    expect(out).toContain('Try again');
  });

  it('shows the profile and empty panels for a fresh draft', async () => {
    api.getVendor.mockResolvedValue(vendor());
    const out = await detail();
    expect(out).toContain('Himal Traders Pvt. Ltd.');
    expect(out).toContain('Draft');
    expect(out).toContain('No contacts yet.');
    expect(out).toContain('No terms set yet.');
    expect(out).toContain('No bank account yet.');
    expect(out).toContain('Edit vendor');
  });

  it('one failing panel does not take the profile down', async () => {
    api.getVendor.mockResolvedValue(vendor());
    api.listVendorContacts.mockRejectedValue(apiError(500, 'internal'));
    const out = await detail();
    expect(out).toContain('The contacts did not load');
    expect(out).toContain('Himal Traders Pvt. Ltd.');
    expect(out).toContain('No bank account yet.');
  });

  it('shows the last four characters of a bank account and nothing longer', async () => {
    api.getVendor.mockResolvedValue(vendor({ status: 'approved' }));
    api.listBankAccounts.mockResolvedValue([
      bank({ status: 'active', verifiedAt: '2026-11-08T05:45:00.000Z' }),
    ]);
    const out = await detail();
    expect(out).toContain('4455');
    expect(out).toContain('Verified, in use');
  });

  it('offers verify and reject to vendor.bank.verify holders only, and propose to proposers only', async () => {
    api.getVendor.mockResolvedValue(vendor({ status: 'approved' }));
    api.listBankAccounts.mockResolvedValue([bank()]);
    session.roles = ['procurement'];
    const maker = await detail();
    expect(maker).toContain('Propose a bank account');
    expect(maker).not.toContain('Verify account');
    session.roles = ['finance'];
    const checker = await detail();
    expect(checker).toContain('Verify account');
    expect(checker).toContain('Call-back evidence');
    expect(checker).not.toContain('Propose a bank account');
  });

  it('gates the lifecycle buttons by status and permission', async () => {
    api.getVendor.mockResolvedValue(vendor({ status: 'draft' }));
    session.roles = ['procurement'];
    const draft = await detail();
    expect(draft).toContain('Start KYB review');
    expect(draft).not.toContain('Approve vendor');

    api.getVendor.mockResolvedValue(vendor({ status: 'under_review' }));
    expect(await detail()).not.toContain('Approve vendor');
    session.roles = ['founder'];
    const founder = await detail();
    expect(founder).toContain('Approve vendor');

    api.getVendor.mockResolvedValue(vendor({ status: 'approved' }));
    const approved = await detail();
    expect(approved).toContain('Suspend vendor');
    expect(approved).toContain('Block vendor');
  });

  it('an archived or blocked vendor has no edit link', async () => {
    api.getVendor.mockResolvedValue(vendor({ status: 'blocked' }));
    expect(await detail()).not.toContain('Edit vendor');
    api.getVendor.mockResolvedValue(vendor({ status: 'archived' }));
    const out = await detail();
    expect(out).not.toContain('Edit vendor');
    expect(out).toContain('Nothing more can be done');
  });

  it('shows the portal grant for approved and pending_kyc vendors with contacts, not for drafts', async () => {
    const contact = {
      id: ORG,
      vendorPartyId: ID,
      name: 'Sita Sharma',
      email: 'sita@example.com',
      phone: null,
      role: null,
      isPrimary: true,
      version: 1,
    };
    api.listVendorContacts.mockResolvedValue([
      contact,
      { ...contact, id: ACCOUNT, name: 'No Mail', email: null, isPrimary: false },
    ]);
    api.getVendor.mockResolvedValue(vendor({ status: 'pending_kyc' }));
    const out = await detail();
    expect(out).toContain('Grant portal access');
    expect(out).toContain('No Mail (no email)');
    api.getVendor.mockResolvedValue(vendor({ status: 'draft' }));
    expect(await detail()).not.toContain('Grant portal access');
  });

  it('links to the KYB case for people who may read verification, and says so otherwise', async () => {
    api.getVendor.mockResolvedValue(vendor({ status: 'pending_kyc' }));
    kyb.listVerificationCases.mockResolvedValue({
      items: [
        {
          id: ACCOUNT,
          partyId: ID,
          status: 'submitted',
          checklist: [],
          reviewedBy: null,
          decidedAt: null,
          decisionNote: null,
          version: 1,
        },
      ],
      total: 1,
    });
    session.roles = ['founder'];
    const out = await detail();
    expect(out).toContain(`/verification/${ACCOUNT}`);
    expect(out).toContain('Awaiting review');
    expect(kyb.listVerificationCases).toHaveBeenCalledWith(expect.anything(), { partyId: ID });
  });
});
