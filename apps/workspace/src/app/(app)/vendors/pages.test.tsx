import {
  avatarColour,
  DEFAULT_ROLE_PERMISSIONS,
  formatPartyPhoneForPrint,
  imagePath,
} from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

import type { PortalForm } from './_components/panel-forms';

type PortalFormProps = Parameters<typeof PortalForm>[0];

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));
const session = vi.hoisted(() => ({ roles: ['procurement'] as string[] }));
const me = vi.hoisted(() => ({ getMe: vi.fn() }));
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  getMe: me.getMe,
}));
vi.mock('@/lib/bff', () => ({
  requireStaffSession: () => Promise.resolve({ roles: session.roles, accessToken: 'tok' }),
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
  createVendorAction: vi.fn(),
  decideBankAction: vi.fn(),
  grantPortalAction: vi.fn(),
  lifecycleAction: vi.fn(),
  proposeBankAction: vi.fn(),
  updateVendorAction: vi.fn(),
}));
const api = vi.hoisted(() => ({
  listVendors: vi.fn(),
  getVendor: vi.fn(),
  listVendorContacts: vi.fn(),
  listVendorAccounts: vi.fn(),
  listBankAccounts: vi.fn(),
  getVendorReviewReadiness: vi.fn(),
}));
vi.mock('@/lib/api-vendors', () => api);
// The real portal grant form, with what the page handed it recorded: the picker's options are only in the markup
// while it is open (its own behaviour is covered in panel-forms.portal.test.tsx).
const portal = vi.hoisted(() => ({
  formProps: vi.fn<(props: PortalFormProps) => void>(),
}));
vi.mock('./_components/panel-forms', async (original) => {
  const actual = await original<typeof import('./_components/panel-forms')>();
  return {
    ...actual,
    PortalForm: (props: PortalFormProps) => {
      portal.formProps(props);
      return actual.PortalForm(props);
    },
  };
});
const kyb = vi.hoisted(() => ({ listVerificationCases: vi.fn() }));
vi.mock('@/components/p2/customers/api', () => kyb);

const { default: VendorsPage } = await import('./page');
const { default: VendorPage } = await import('./[id]/page');
const { default: NewVendorPage } = await import('./new/page');
const { default: EditVendorPage } = await import('./[id]/edit/page');

const ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const ORG = '33333333-3333-4333-8333-333333333333';
const LOGO = '77777777-7777-4777-8777-777777777777';

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
  address: null,
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

/**
 * GET /v1/me as the saved role rows answer it: here, each role's built-in grants (what Settings > Access starts
 * from). A test that wants another answer sets `me.getMe` itself; one that wants the read to fail rejects it.
 */
const meOfRoles = (roles: readonly string[]) => ({
  permissions: roles.flatMap((role) =>
    Object.entries(
      (DEFAULT_ROLE_PERMISSIONS as Record<string, Record<string, string> | undefined>)[role] ?? {},
    ).map(([permission, scope]) => ({ permission, scope })),
  ),
});

beforeEach(() => {
  vi.clearAllMocks();
  session.roles = ['procurement'];
  me.getMe.mockImplementation(() => Promise.resolve(meOfRoles(session.roles)));
  api.listVendorContacts.mockResolvedValue([]);
  api.listVendorAccounts.mockResolvedValue([]);
  api.listBankAccounts.mockResolvedValue([]);
  api.getVendorReviewReadiness.mockResolvedValue({ kybSubmitted: false });
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
          address: { line: '12 Marine Drive', city: 'Mumbai' },
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
    // The address with its city and country; a vendor with none shows its country.
    expect(out).toContain('12 Marine Drive, Mumbai, India');
    expect(out).toContain('Nepal');
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

  it('shows the last page for a stale page number past the end, not "Showing 0 of 12" over an empty state', async () => {
    // The KPI counts carry no offset; the page read past the end is empty, the last page (offset 10) has rows.
    api.listVendors.mockImplementation((_s: unknown, query: { offset?: number }) =>
      Promise.resolve(
        query.offset === undefined
          ? { items: [], total: 0 }
          : query.offset >= 20
            ? { items: [], total: 12 }
            : { items: [vendor(), vendor({ id: ACCOUNT, legalName: 'Second Ltd' })], total: 12 },
      ),
    );
    const out = await list({ page: '5', rows: '10' });
    expect(api.listVendors).toHaveBeenLastCalledWith(expect.anything(), { limit: 10, offset: 10 });
    expect(out).toContain('Himal Traders Pvt. Ltd.');
    expect(out).toContain('Showing 2 of 12 vendors');
    expect(out).toContain('Showing 11–12 of 12');
    expect(out).not.toContain('Showing 0 of 12');
    expect(out).not.toContain('There are no more vendors.');
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
    expect(out).toContain('Showing 1–25 of 60');
    expect(out).toContain('/vendors?page=2');
    expect(out).toContain('aria-label="Rows per page"');
    expect(out).toContain('href="/vendors?rows=50"');
  });

  it('counts the vendors per status group in the KPI cards, unfiltered by the search', async () => {
    const totals: Record<string, number> = { approved: 4, draft: 2, suspended: 1 };
    api.listVendors.mockImplementation((_s: unknown, query: { status?: string[] }) =>
      Promise.resolve({
        items: query.status === undefined ? [vendor()] : [],
        total:
          query.status === undefined
            ? 1
            : query.status.reduce((sum, status) => sum + (totals[status] ?? 0), 0),
      }),
    );
    const out = await list({ q: 'Himal' });
    const cards = out.slice(out.indexOf('aria-label="Vendors by status"'));
    expect(cards).toMatch(/Vendors<\/dt><dd[^>]*>7</);
    expect(cards).toMatch(/Approved<\/dt><dd[^>]*>4</);
    expect(cards).toMatch(/In onboarding<\/dt><dd[^>]*>2</);
    expect(cards).toMatch(/Inactive<\/dt><dd[^>]*>1</);
    // Three count calls, none of them carrying the search, then the page itself.
    const queries = api.listVendors.mock.calls.map((c) => c[1] as Record<string, unknown>);
    expect(queries.slice(0, 3)).toEqual([
      { status: ['approved'], limit: 1 },
      { status: ['draft', 'pending_kyc', 'under_review'], limit: 1 },
      { status: ['suspended', 'blocked', 'archived'], limit: 1 },
    ]);
    expect(queries.at(-1)).toMatchObject({ q: 'Himal' });
  });

  it('leaves the KPI cards out when a count fails, and keeps the list', async () => {
    api.listVendors.mockImplementation((_s: unknown, query: { status?: string[] }) =>
      query.status !== undefined
        ? Promise.reject(apiError(500, 'internal'))
        : Promise.resolve({ items: [vendor()], total: 1 }),
    );
    const out = await list();
    expect(out).not.toContain('Vendors by status');
    expect(out).toContain('Himal Traders Pvt. Ltd.');
  });

  it('ends each row with the status and a View link named after that vendor', async () => {
    api.listVendors.mockResolvedValue({
      items: [vendor(), vendor({ id: ACCOUNT, pan: null, legalName: 'Foreign Ltd' })],
      total: 2,
    });
    const out = await list();
    expect(out).toContain('aria-label="View Himal Traders Pvt. Ltd., PAN 301234567"');
    expect(out).toContain('aria-label="View Foreign Ltd"');
    expect(out).toContain(`href="/vendors/${ACCOUNT}"`);
    expect(out).toContain('>Action</th>');
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
    // PageHeader carries the single page h1 and header actions; the profile card uses h2 without repeating the title.
    expect(out.match(/<h1\b/g)).toHaveLength(1);
    expect(out).toMatch(/<h1[^>]*>Himal Traders Pvt. Ltd.<\/h1>/);
    expect(out).toMatch(/<h2 id="vendor-name"[^>]*>Vendor details<\/h2>/);
    expect(out).toContain(`href="/vendors/${ID}/edit"`);
    expect(out).toContain('Edit Details');
    // The h1 comes before every panel heading.
    expect(out.indexOf('<h1')).toBeLessThan(out.indexOf('<h2'));
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

  it('shows "Send for review" only once the KYB case is submitted, the state the API checks', async () => {
    api.getVendor.mockResolvedValue(vendor({ status: 'pending_kyc' }));
    session.roles = ['procurement'];
    // The case is open, not submitted: no button, and the status panel says why.
    const open = await detail();
    expect(api.getVendorReviewReadiness).toHaveBeenCalledWith(expect.anything(), ID);
    expect(open).not.toContain('Send for review');
    expect(open).toContain('once its KYB case is submitted');
    expect(open).not.toContain('No status action is open');

    api.getVendorReviewReadiness.mockResolvedValue({ kybSubmitted: true });
    const ready = await detail();
    expect(ready.slice(0, ready.indexOf('<section'))).toContain('Send for review');
    expect(ready).not.toContain('once its KYB case is submitted');

    // The readiness read fails: the button stays hidden (fail closed) and the panel says so.
    api.getVendorReviewReadiness.mockRejectedValue(apiError(500, 'internal'));
    const failed = await detail();
    expect(failed).not.toContain('Send for review');
    expect(failed).toContain('could not check the KYB case');
  });

  it('does not ask for KYB readiness when "Send for review" could not show', async () => {
    api.getVendor.mockResolvedValue(vendor({ status: 'draft' }));
    await detail();
    session.roles = ['finance'];
    api.getVendor.mockResolvedValue(
      vendor({
        status: 'pending_kyc',
        can: { write: false, activate: true, suspend: false, block: false, archive: false },
      }),
    );
    await detail();
    expect(api.getVendorReviewReadiness).not.toHaveBeenCalled();
  });

  it('gates the lifecycle buttons by status and permission in the page header', async () => {
    api.getVendor.mockResolvedValue(vendor({ status: 'draft' }));
    session.roles = ['procurement'];
    const draft = await detail();
    const header = draft.slice(0, draft.indexOf('<section'));
    const body = draft.slice(draft.indexOf('<section'));
    expect(header).toContain('Start KYB review');
    expect(header).toContain('Edit Details');
    expect(body).not.toContain('Start KYB review');
    expect(draft).not.toContain('Approve vendor');
    expect(draft).toContain('Use the header actions to move this vendor to the next stage.');

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

  it('hides Approve/Reinstate and explains SoD, KYB, and expired tax clearance blocks prominently', async () => {
    session.roles = ['founder'];
    api.getVendor.mockResolvedValue(
      vendor({
        status: 'under_review',
        can: {
          write: true,
          activate: false,
          suspend: false,
          block: false,
          archive: false,
          activateBlockedBySod: true,
        },
      }),
    );
    const sodApprove = await detail();
    expect(sodApprove).not.toContain('Approve vendor');
    expect(sodApprove).toContain('Approval requires another approver');
    expect(sodApprove).toContain(
      'You created this vendor, so another person with approval access must approve it.',
    );

    api.getVendor.mockResolvedValue(
      vendor({
        status: 'suspended',
        can: {
          write: true,
          activate: false,
          suspend: false,
          block: true,
          archive: false,
          activateBlockedBySod: true,
        },
      }),
    );
    const sodReinstate = await detail();
    expect(sodReinstate).not.toContain('Reinstate vendor');
    expect(sodReinstate).toContain('Reinstatement requires another approver');
    expect(sodReinstate).toContain(
      'You created this vendor, so another person with approval access must reinstate it.',
    );

    api.getVendor.mockResolvedValue(
      vendor({
        status: 'under_review',
        can: {
          write: true,
          activate: false,
          suspend: false,
          block: false,
          archive: false,
          activateBlockedByKyb: true,
        },
      }),
    );
    const kybBlocked = await detail();
    expect(kybBlocked).not.toContain('Approve vendor');
    expect(kybBlocked).toContain('KYB review must be approved first');

    api.getVendor.mockResolvedValue(
      vendor({
        status: 'suspended',
        can: {
          write: true,
          activate: false,
          suspend: false,
          block: true,
          archive: false,
          activateBlockedByKycExpired: true,
        },
      }),
    );
    const kycExpired = await detail();
    expect(kycExpired).not.toContain('Reinstate vendor');
    expect(kycExpired).toContain('Tax clearance has expired');
  });

  it('respects live permissions over static role defaults', async () => {
    session.roles = ['founder'];
    me.getMe.mockResolvedValue({
      permissions: [{ permission: 'vendor.read', scope: 'all' }],
    });
    api.getVendor.mockResolvedValue(vendor({ status: 'under_review' }));
    const out = await detail();
    expect(out).not.toContain('Approve vendor');
    expect(out).not.toContain('Edit Details');
    expect(out).toContain('No status action is open to your current permissions at this status.');
    expect(kyb.listVerificationCases).not.toHaveBeenCalled();
  });

  it('an archived or blocked vendor has no edit link', async () => {
    api.getVendor.mockResolvedValue(vendor({ status: 'blocked' }));
    expect(await detail()).not.toContain(`/vendors/${ID}/edit`);
    api.getVendor.mockResolvedValue(vendor({ status: 'archived' }));
    const out = await detail();
    expect(out).not.toContain(`/vendors/${ID}/edit`);
    expect(out).toContain('Nothing more can be done');
  });

  it('shows the portal grant for approved and pending_kyc vendors with contacts, not for drafts', async () => {
    const contact = {
      id: ORG,
      vendorPartyId: ID,
      name: 'Sita Sharma',
      email: 'sita@example.com',
      country: 'US',
      phones: [
        { country: 'US', e164: '+14155552671', label: 'work', isPrimary: true },
        { country: 'NP', e164: '+9779812345678', label: null, isPrimary: false },
      ],
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
    // The contact is picked in a search box (a combobox posting `contactId`), not a plain select. Its options are only
    // in the markup while it is open, so assert what the page handed the form: each contact with its email, and
    // "No Mail" as a contact that cannot be invited.
    expect(out).toContain('name="contactId"');
    expect(portal.formProps).toHaveBeenCalled();
    const props = portal.formProps.mock.calls.at(-1)![0];
    expect(props.vendorId).toBe(ID);
    expect(props.vendorCountry).toBe('NP');
    expect(props.contacts).toEqual([
      { id: ORG, label: 'Sita Sharma', email: 'sita@example.com', hasEmail: true },
      { id: ACCOUNT, label: 'No Mail', email: null, hasEmail: false },
    ]);
    // The contact's primary number, in the print format; the other number stays off the table.
    expect(out).toContain('href="tel:+14155552671"');
    expect(out).toContain(formatPartyPhoneForPrint('+14155552671'));
    expect(out).not.toContain('tel:+9779812345678');
    api.getVendor.mockResolvedValue(vendor({ status: 'draft' }));
    expect(await detail()).not.toContain('Grant portal access');
  });

  it('shows the address with its city and country, and the country by name', async () => {
    api.getVendor.mockResolvedValue(
      vendor({ address: { line: 'Thamel Marg', city: 'Kathmandu' } }),
    );
    const out = await detail();
    expect(out).toContain('Thamel Marg, Kathmandu, Nepal');
    api.getVendor.mockResolvedValue(
      vendor({ kind: 'foreign', pan: 'EIN-1234567', country: 'US', address: null }),
    );
    const foreign = await detail();
    expect(foreign).toContain('United States');
    expect(foreign).toContain('Tax ID');
    expect(foreign).toContain('EIN-1234567');
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

describe('vendor logo', () => {
  /** The markup of the "Vendor logo" group: from its opening tag to the profile facts after it. */
  const logoGroup = (out: string) => {
    const start = out.indexOf('aria-label="Vendor logo"');
    expect(start).toBeGreaterThan(-1);
    return out.slice(start, out.indexOf('<dl', start));
  };

  it('uses ids whose seeded colours differ from each other and from the unseeded one', () => {
    expect(new Set([avatarColour(ID), avatarColour(ACCOUNT), avatarColour(null)]).size).toBe(3);
  });

  it('each list row draws its own logo, or initials seeded from its own id', async () => {
    api.listVendors.mockResolvedValue({
      items: [vendor({ logoDocumentId: LOGO }), vendor({ id: ACCOUNT, legalName: 'Foreign Ltd' })],
      total: 2,
    });
    const out = await list();
    expect(out).toContain(`src="${imagePath(LOGO)}"`);
    expect(out.match(/<img/g)).toHaveLength(1);
    expect(out).toContain(`--avatar-fill:${avatarColour(ID)}`);
    expect(out).toContain(`--avatar-fill:${avatarColour(ACCOUNT)}`);
  });

  it('the detail draws the logo seeded from the vendor id, and lets a writer replace it', async () => {
    api.getVendor.mockResolvedValue(vendor({ logoDocumentId: LOGO }));
    const group = logoGroup(await detail());
    expect(group).toContain(`--avatar-fill:${avatarColour(ID)}`);
    expect(group).toContain(`src="${imagePath(LOGO)}"`);
    expect(group).toContain('type="file"');
  });

  it('is the picture only without vendor.write', async () => {
    session.roles = ['finance'];
    api.getVendor.mockResolvedValue(vendor({ logoDocumentId: LOGO }));
    const out = await detail();
    expect(logoGroup(out)).toContain(`src="${imagePath(LOGO)}"`);
    expect(logoGroup(out)).not.toContain('type="file"');
    expect(out).not.toContain(`/vendors/${ID}/edit`);
  });

  it('is the picture only once the vendor can no longer be edited', async () => {
    api.getVendor.mockResolvedValue(vendor({ status: 'archived' }));
    const out = await detail();
    expect(logoGroup(out)).not.toContain('type="file"');
    expect(logoGroup(out)).not.toContain('<img');
  });
});

describe('live saved grants decide Add vendor', () => {
  const live = (...permissions: string[]) =>
    me.getMe.mockResolvedValue({
      permissions: permissions.map((permission) => ({ permission, scope: 'all' })),
    });
  const DENIED = 'Your roles do not include adding vendors';

  it('shows Add vendor on the list to a role whose saved grants add vendor.write (defaults do not)', async () => {
    session.roles = ['finance'];
    live('vendor.read', 'vendor.write');
    api.listVendors.mockResolvedValue({ items: [vendor()], total: 1 });
    expect(await list()).toContain('Add vendor');
  });

  it('hides Add vendor on the list once vendor.write is removed from the saved grants', async () => {
    session.roles = ['procurement'];
    live('vendor.read');
    api.listVendors.mockResolvedValue({ items: [vendor()], total: 1 });
    expect(await list()).not.toContain('Add vendor');
  });

  it('opens the new vendor form to a role whose saved grants add vendor.write', async () => {
    session.roles = ['finance'];
    live('vendor.read', 'vendor.write');
    const out = html(await NewVendorPage());
    expect(out).toContain('<form');
    expect(out).not.toContain(DENIED);
  });

  it('shuts the new vendor form once vendor.write is removed from the saved grants', async () => {
    session.roles = ['procurement'];
    live('vendor.read');
    const out = html(await NewVendorPage());
    expect(out).toContain(DENIED);
    expect(out).not.toContain('<form');
  });

  it('hides Add vendor and shuts the form when the live grants cannot be read, whatever the role', async () => {
    me.getMe.mockRejectedValue(new Error('offline'));
    api.listVendors.mockResolvedValue({ items: [vendor()], total: 1 });
    for (const roles of [['procurement'], ['finance']]) {
      session.roles = roles;
      expect(await list()).not.toContain('Add vendor');
      const out = html(await NewVendorPage());
      expect(out).toContain(DENIED);
      expect(out).not.toContain('<form');
    }
  });
});

describe('vendor edit', () => {
  const can = (write: boolean) => ({
    write,
    activate: false,
    suspend: false,
    block: false,
    archive: false,
  });
  const edit = async () => html(await EditVendorPage({ params: Promise.resolve({ id: ID }) }));

  it('shows the form when the vendor says the caller may write it', async () => {
    api.getVendor.mockResolvedValue(vendor({ can: can(true) }));
    const out = await edit();
    expect(out).toContain('<form');
    expect(out).not.toContain('You cannot edit this vendor');
  });

  it('shows the no-edit note and no form when the vendor says the caller may not write it', async () => {
    api.getVendor.mockResolvedValue(vendor({ can: can(false) }));
    const out = await edit();
    expect(out).toContain('You cannot edit this vendor');
    expect(out).toContain(`href="/vendors/${ID}"`);
    expect(out).not.toContain('<form');
  });

  it('keeps the read-only note for a blocked vendor, whatever its flag says', async () => {
    api.getVendor.mockResolvedValue(vendor({ status: 'blocked', can: can(false) }));
    const out = await edit();
    expect(out).toContain('This vendor can no longer be edited.');
    expect(out).not.toContain('<form');
  });
});
