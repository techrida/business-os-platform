import type { QuotationListItem } from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { money } from '@/lib/kernel-format';

import OverviewPage from '../page';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const GONE = '33333333-3333-4333-8333-333333333333';

const mocks = vi.hoisted(() => ({
  granted: new Set<string>(),
  requireStaffSession: vi.fn(),
  getNumberSystems: vi.fn(),
  getMe: vi.fn(),
  getInbox: vi.fn(),
  getUnreadCount: vi.fn(),
  listNotifications: vi.fn(),
  loadPeople: vi.fn(),
  listCustomers: vi.fn(),
  getLeadSummary: vi.fn(),
  listOpportunitiesPage: vi.fn(),
  getQuotationsSummary: vi.fn(),
  listQuotationsPage: vi.fn(),
  listActivitiesPage: vi.fn(),
}));
vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('@/lib/display-settings', () => ({ getNumberSystems: mocks.getNumberSystems }));
vi.mock('@/lib/api', () => ({ getMe: mocks.getMe }));
vi.mock('@/lib/api-kernel', () => ({
  getInbox: mocks.getInbox,
  getUnreadCount: mocks.getUnreadCount,
  listNotifications: mocks.listNotifications,
}));
vi.mock('@/components/p2/crm/people', () => ({
  canAssignFollowUps: () => false,
  loadPeople: mocks.loadPeople,
}));
vi.mock('@/components/p2/customers/api', () => ({ listCustomers: mocks.listCustomers }));
vi.mock('@/components/p2/customers/permissions', () => ({
  permissionChecker: () => (permission: string) => mocks.granted.has(permission),
}));
vi.mock('@/components/p2/crm/leads-api', () => ({ getLeadSummary: mocks.getLeadSummary }));
vi.mock('@/components/p2/crm/opportunities-api', () => ({
  listOpportunitiesPage: mocks.listOpportunitiesPage,
}));
vi.mock('@/components/p2/crm/activities-api', () => ({
  listActivitiesPage: mocks.listActivitiesPage,
}));
vi.mock('@/components/p2/quotations/api', () => ({
  getQuotationsSummary: mocks.getQuotationsSummary,
  listQuotationsPage: mocks.listQuotationsPage,
}));

const quotation = {
  id: '55555555-5555-4555-8555-555555555551',
  number: 'QT-2082-0001',
  customerId: OTHER,
  opportunityId: OTHER,
  currentVersionId: OTHER,
  ownerUserId: null,
  status: 'submitted',
  version: 1,
  createdAt: '2026-11-08T05:45:00.000Z',
  updatedAt: '2026-11-08T05:45:00.000Z',
  customerName: 'Himal Traders',
  currency: 'NPR',
  total: '1000.00',
  validUntil: '2026-12-08',
  ownerName: 'Sita Rai',
  canEdit: true,
} satisfies QuotationListItem;

const activity = (createdByUserId: string | null, createdByName: string | null = null) => ({
  id: '66666666-6666-4666-8666-666666666666',
  kind: 'call',
  subject: 'Pricing follow-up',
  body: null,
  leadId: OTHER,
  opportunityId: null,
  customerId: null,
  contactId: null,
  quotationId: null,
  dueAt: null,
  assigneeUserId: null,
  completedAt: null,
  cancelledAt: null,
  planned: false,
  createdByUserId,
  createdByName,
  occurredAt: '2026-11-18T05:45:00.000Z',
  version: 1,
});

async function render(): Promise<string> {
  return renderToStaticMarkup(await OverviewPage());
}

/** `<dt>label</dt><dd class="..">value</dd>` of a stat card. */
const card = (label: string, value: number) => new RegExp(`${label}</dt><dd[^>]*>${value}</dd>`);

beforeEach(() => {
  mocks.granted = new Set();
  mocks.requireStaffSession.mockReset().mockResolvedValue({ accessToken: 'tok', roles: ['sales'] });
  mocks.getNumberSystems.mockReset().mockResolvedValue(undefined);
  mocks.getMe.mockReset().mockResolvedValue({ userId: ME });
  mocks.getInbox.mockReset().mockResolvedValue([]);
  mocks.getUnreadCount.mockReset().mockResolvedValue({ count: 2 });
  mocks.listNotifications.mockReset().mockResolvedValue([
    {
      id: '77777777-7777-4777-8777-777777777777',
      title: 'Draft tax_invoice 242d0b45 was approved',
      body: 'Draft tax_invoice 242d0b45 was approved.',
      link: '/inbox/x',
      readAt: null,
      createdAt: '2026-11-18T05:45:00.000Z',
    },
  ]);
  mocks.loadPeople.mockReset().mockResolvedValue({
    owners: [{ userId: ME, displayName: 'Amanda Vance', email: 'amanda@x.test' }],
  });
  mocks.listCustomers.mockReset().mockResolvedValue({ items: [], total: 24 });
  mocks.getLeadSummary.mockReset().mockResolvedValue({
    total: 21,
    byStage: { new: 2, contacted: 3, qualified: 1, converted: 5, lost: 4, on_hold: 6 },
  });
  mocks.listOpportunitiesPage.mockReset().mockResolvedValue({ items: [], total: 7 });
  mocks.getQuotationsSummary.mockReset().mockResolvedValue({
    total: 12,
    byStatus: { submitted: 3 },
  });
  mocks.listQuotationsPage.mockReset().mockResolvedValue({ items: [quotation], total: 1 });
  mocks.listActivitiesPage
    .mockReset()
    .mockResolvedValue({ items: [activity(OTHER, 'Mina Rai')], total: 1 });
});

describe('overview page', () => {
  it('greets the caller by first name and shows every card its read supports', async () => {
    const html = await render();
    expect(html).toMatch(/Good (morning|afternoon|evening), Amanda</);
    expect(html).toMatch(card('Customers', 24));
    expect(html).toMatch(card('Open leads', 6));
    expect(html).toMatch(card('Open opportunities', 7));
    expect(html).toMatch(card('Pending quotations', 3));
    expect(html).toMatch(card('Pending approvals', 0));
    expect(html).toMatch(card('Unread notifications', 2));
    // Only active stages are counted as open opportunities.
    const stages = (mocks.listOpportunitiesPage.mock.calls[0]?.[1] as { stage: string[] }).stage;
    expect(stages).not.toContain('won');
    expect(stages).not.toContain('lost');
    expect(stages).not.toContain('on_hold');
  });

  it('keeps Welcome back when the name cannot be resolved or is an email', async () => {
    mocks.loadPeople.mockResolvedValue({ owners: [] });
    expect(await render()).toContain('Welcome back');
    mocks.loadPeople.mockResolvedValue({
      owners: [{ userId: ME, displayName: 'amanda@x.test', email: 'amanda@x.test' }],
    });
    expect(await render()).toContain('Welcome back');
  });

  it('leaves out a card whose read was refused or has no total, never showing a zero', async () => {
    mocks.listCustomers.mockRejectedValue(new Error('GET /v1/customers failed with 403'));
    mocks.getLeadSummary.mockRejectedValue(new Error('403'));
    mocks.getQuotationsSummary.mockRejectedValue(new Error('403'));
    let html = await render();
    expect(html).not.toContain('Customers</dt>');
    expect(html).not.toContain('Open leads</dt>');
    expect(html).not.toContain('Pending quotations</dt>');
    expect(html).toMatch(card('Open opportunities', 7));

    mocks.listCustomers.mockReset().mockResolvedValue({ items: [], total: null });
    html = await render();
    expect(html).not.toContain('Customers</dt>');
  });

  it('shows recent quotations with a formatted amount, a status and a link to all', async () => {
    const html = await render();
    expect(html).toContain('Recent quotations');
    expect(html).toContain('QT-2082-0001');
    expect(html).toContain('Himal Traders');
    expect(html).toContain('Sita Rai');
    expect(html).toContain(money('1000.00', 'NPR'));
    expect(html).toContain('href="/quotations"');
    expect(mocks.listQuotationsPage.mock.calls[0]?.[1]).toEqual({ limit: 5, offset: 0 });
  });

  it('omits the recent quotations panel when quotations cannot be read', async () => {
    mocks.listQuotationsPage.mockRejectedValue(new Error('403'));
    const html = await render();
    expect(html).not.toContain('Recent quotations');
    expect(html).not.toContain('Explore all');
  });

  it('words an activity as who did what, and names no one it cannot resolve', async () => {
    let html = await render();
    expect(html).toContain('Mina Rai logged a call');
    expect(html).toContain('href="/leads/22222222-2222-4222-8222-222222222222"');

    mocks.listActivitiesPage.mockResolvedValue({ items: [activity(GONE)], total: 1 });
    html = await render();
    expect(html).toContain('Call logged');
    expect(html).not.toContain(GONE);

    mocks.listActivitiesPage.mockRejectedValue(new Error('403'));
    expect(await render()).not.toContain('Recent activities');
  });

  it('shows notification titles in words, without the raw type or id fragment', async () => {
    const html = await render();
    expect(html).toContain('Tax invoice draft was approved');
    expect(html).not.toContain('tax_invoice');
    expect(html).not.toContain('242d0b45');
  });

  it('renders only the quick action tiles the caller may use', async () => {
    let html = await render();
    expect(html).not.toContain('Quick actions');

    mocks.granted = new Set(['crm.lead.write', 'customer.write']);
    html = await render();
    expect(html).toContain('Quick actions');
    expect(html).toContain('href="/leads/new"');
    expect(html).toContain('href="/customers/new"');
    expect(html).not.toContain('Add user');
    expect(html).not.toContain('href="/opportunities"');
  });
});
