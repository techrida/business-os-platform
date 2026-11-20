// The portal milestones pages (F1-Q34): the order list and one order's billing schedule, rendered from the BFF's
// parsed answer. A 404 or 403 on one order shows the not-found page (no existence leak), no session sends the visitor
// to sign in, and each milestone shows its label, share, amount, planned date, status word and invoice link.
import type { PortalSalesOrder } from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import { DEFAULT_PORTAL_DISPLAY } from '@/lib/display';

const ORDER = '1f8fad5b-d9cb-469f-a165-70867728950e';
const INVOICE = '2f8fad5b-d9cb-469f-a165-70867728950e';

const m = vi.hoisted(() => ({
  getSession: vi.fn(),
  listPortalSalesOrders: vi.fn(),
  getPortalSalesOrder: vi.fn(),
  redirect: vi.fn((to: string): never => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
  notFound: vi.fn((): never => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => m.redirect(to),
  notFound: () => m.notFound(),
}));
vi.mock('@/lib/session', () => ({ getSession: m.getSession }));
vi.mock('@/lib/portal-display', () => ({
  getPortalDisplay: () => Promise.resolve(DEFAULT_PORTAL_DISPLAY),
}));
vi.mock('@/lib/api.billing', () => ({
  listPortalSalesOrders: m.listPortalSalesOrders,
  getPortalSalesOrder: m.getPortalSalesOrder,
}));

const { default: MilestonesPage } = await import('./page');
const { default: OrderMilestonesPage } = await import('./[id]/page');

const order = (): PortalSalesOrder => ({
  id: ORDER,
  number: 'SO-2083/84-00001',
  status: 'confirmed',
  confirmedAt: '2026-11-02T04:00:00.000Z',
  currency: 'NPR',
  total: '1130.00',
  milestones: [
    {
      seq: 1,
      label: 'Advance 40%',
      percent: '40',
      amount: '452.00',
      plannedDate: null,
      status: 'invoiced',
      invoice: { id: INVOICE, number: 'INV-2083/84-00001', dueDate: '2026-12-03' },
    },
    {
      seq: 2,
      label: 'UAT 60%',
      percent: '60',
      amount: '678.00',
      plannedDate: '2026-12-15',
      status: 'upcoming',
      invoice: null,
    },
  ],
});

const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  m.getSession.mockResolvedValue({ accessToken: 'access', orgKind: 'customer' });
});

describe('milestones list', () => {
  it('lists each confirmed order with how many milestones are invoiced', async () => {
    m.listPortalSalesOrders.mockResolvedValue([order()]);
    const html = renderToStaticMarkup(await MilestonesPage());
    expect(html).toContain(`href="/milestones/${ORDER}"`);
    expect(text(html)).toContain('1 of 2 invoiced');
  });

  it('says so when there are no orders yet', async () => {
    m.listPortalSalesOrders.mockResolvedValue([]);
    expect(text(renderToStaticMarkup(await MilestonesPage()))).toContain('No orders yet');
  });

  it('sends a visitor without a session to sign in', async () => {
    m.getSession.mockResolvedValue(null);
    await expect(MilestonesPage()).rejects.toThrow(
      'NEXT_REDIRECT /auth/login?returnTo=%2Fmilestones',
    );
  });
});

describe('one order', () => {
  it("shows the order's milestones with status words and the invoice link", async () => {
    m.getPortalSalesOrder.mockResolvedValue(order());
    const html = renderToStaticMarkup(await OrderMilestonesPage(params(ORDER)));
    const t = text(html);
    expect(t).toContain('Order SO-2083/84-00001');
    expect(t).toContain('Advance 40%');
    expect(t).toContain('40%');
    expect(t).toContain('Invoiced');
    expect(t).toContain('Upcoming');
    expect(html).toContain(`href="/invoices/${INVOICE}"`);
  });

  it.each([404, 403])(
    'shows not found for a %s, never whether the order exists',
    async (status) => {
      m.getPortalSalesOrder.mockRejectedValue(new ApiError(status, 'x', undefined));
      await expect(OrderMilestonesPage(params(ORDER))).rejects.toThrow('NEXT_NOT_FOUND');
    },
  );

  it('shows not found for an id that is not a UUID, without calling the API', async () => {
    await expect(OrderMilestonesPage(params('nope'))).rejects.toThrow('NEXT_NOT_FOUND');
    expect(m.getPortalSalesOrder).not.toHaveBeenCalled();
  });
});
