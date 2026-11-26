import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import OverviewPage from './page';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireStaffSession: vi.fn(),
  getInboxPage: vi.fn(),
  getUnreadCount: vi.fn(),
  getInbox: vi.fn(),
  listNotifications: vi.fn(),
  getMeOrNull: vi.fn(),
  getMe: vi.fn(),
  listCustomers: vi.fn(),
  getLeadSummary: vi.fn(),
  listOpportunitiesPage: vi.fn(),
  getQuotationsSummary: vi.fn(),
  listQuotationsPage: vi.fn(),
  listActivitiesPage: vi.fn(),
}));

vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('@/lib/display-settings', () => ({ getNumberSystems: async () => 'western' }));
// `getUnreadCount` and `getInbox` stay in the mock so a page that still calls them is counted, not crashed.
vi.mock('@/lib/api-kernel', () => ({
  getInboxPage: mocks.getInboxPage,
  getInbox: mocks.getInbox,
  getUnreadCount: mocks.getUnreadCount,
  listNotifications: mocks.listNotifications,
}));
vi.mock('@/lib/live-permissions', () => ({ getMeOrNull: mocks.getMeOrNull }));
vi.mock('@/lib/api', () => ({ getMe: mocks.getMe }));
vi.mock('@/components/p2/customers/api', () => ({ listCustomers: mocks.listCustomers }));
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
vi.mock('./unread-stat', () => ({ UnreadStat: () => null }));

const ITEM = {
  requestId: '11111111-1111-4111-8111-111111111111',
  documentType: 'quotation',
  documentNumber: 'QT-1',
  title: 'Quote',
  amount: null,
  currency: null,
  step: 1,
  createdAt: '2026-11-08T05:45:00.000Z',
};

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.requireStaffSession.mockResolvedValue({ accessToken: 'tok', roles: ['sales'] });
  mocks.getInboxPage.mockResolvedValue({ items: [ITEM], total: 7 });
  mocks.listNotifications.mockResolvedValue([]);
  mocks.getMeOrNull.mockResolvedValue({ displayName: 'Asha', permissions: [] });
  mocks.getMe.mockResolvedValue({ displayName: 'Asha', permissions: [] });
  for (const m of [
    mocks.listCustomers,
    mocks.getLeadSummary,
    mocks.listOpportunitiesPage,
    mocks.getQuotationsSummary,
    mocks.listQuotationsPage,
    mocks.listActivitiesPage,
  ]) {
    m.mockRejectedValue(new Error('not in this test'));
  }
});

describe('home page reads', () => {
  it('reads /v1/me once through the memoised call, and no unread count', async () => {
    renderToStaticMarkup(await OverviewPage());
    expect(mocks.getMeOrNull).toHaveBeenCalledTimes(1);
    expect(mocks.getMeOrNull).toHaveBeenCalledWith('tok');
    expect(mocks.getMe).not.toHaveBeenCalled();
    expect(mocks.getUnreadCount).not.toHaveBeenCalled();
  });

  it('takes the approvals count and the first five rows from one inbox page read', async () => {
    const html = renderToStaticMarkup(await OverviewPage());
    expect(mocks.getInboxPage).toHaveBeenCalledTimes(1);
    expect(mocks.getInboxPage).toHaveBeenCalledWith(expect.anything(), { limit: 5 });
    expect(mocks.getInbox).not.toHaveBeenCalled();
    expect(html).toContain('7 approvals to review');
  });
});
