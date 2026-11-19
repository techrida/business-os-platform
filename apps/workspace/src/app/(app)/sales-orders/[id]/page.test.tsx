import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

import { IDS, salesOrderDetail, scheduleLine } from '../_lib/fixtures';

import SalesOrderPage from './page';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

// Include the dialog portal in the static render to verify its form fields and action footer.
vi.mock('@radix-ui/react-dialog', async (importOriginal) => {
  const radix = await importOriginal<typeof import('@radix-ui/react-dialog')>();
  return {
    ...radix,
    Root: (props: ComponentProps<typeof radix.Root>) => <radix.Root {...props} open />,
    Portal: ({ children }: ComponentProps<typeof radix.Portal>) => children,
  };
});

const mocks = vi.hoisted(() => ({
  requireStaffSession: vi.fn(),
  getSalesOrder: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('@/lib/api-billing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-billing')>()),
  getSalesOrder: mocks.getSalesOrder,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  notFound: mocks.notFound,
  redirect: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const render = async (id: string = IDS.order): Promise<string> =>
  renderToStaticMarkup(await SalesOrderPage({ params: Promise.resolve({ id }) }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['accountant'] });
  mocks.getSalesOrder.mockResolvedValue(salesOrderDetail());
});

describe('sales order detail', () => {
  it('shows the number, status, lines, totals and the NPR snapshot from the server', async () => {
    const html = await render();
    expect(html).toContain('SO-2083/84-00001');
    expect(html).toContain('Confirmed');
    expect(html).toContain('Website build');
    expect(html).toContain('50,45,450.00');
    expect(html).toContain('6,55,908.50');
    expect(html).toContain('57,01,358.50');
    expect(html).toContain('Exchange rate');
    expect(html).toContain('2026-11-08');
    expect(html).toContain('2083/84');
    expect(html).toContain(`/quotations/${IDS.quotation}`);
    expect(html).toContain(`/customers/${IDS.customer}`);
  });

  it('shows the schedule lines with a status in words and what each one offers', async () => {
    const html = await render();
    expect(html).toContain('Advance 60%');
    expect(html).toContain('Ready to bill');
    expect(html).toContain('Planned');
    // advance is billable: Draft invoice. milestone and uat are planned: Mark billable.
    expect(html.match(/Draft invoice/g)?.length).toBeGreaterThanOrEqual(1);
    expect(html.match(/Mark billable/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain('name="expectedVersion" value="3"');
  });

  it('picks the evidence for a milestone from the order evidence and says that is the way', async () => {
    const html = await render();
    expect(html).toContain(`<option value="${IDS.po}"`);
    expect(html).toContain(`<option value="${IDS.contract}"`);
    expect(html).toContain('Customer purchase order');
    expect(html).toMatch(/evidence (already )?attached to this order/i);
  });

  it('lists the evidence, or says there is none', async () => {
    expect(await render()).toContain('Contract');
    mocks.getSalesOrder.mockResolvedValue(salesOrderDetail({ evidence: [] }));
    const html = await render();
    expect(html).toContain('No evidence is attached to this order.');
    expect(html).toContain('no evidence attached to this order yet');
  });

  it('labels evidence in the list and billing selector without displaying opaque document keys', async () => {
    const html = await render();
    expect(html).toContain('Document 1');
    expect(html).toContain('Customer purchase order · Document 1</option>');
    expect(html).toContain('Contract · Document 2</option>');
    const text = html.replace(/<[^>]*>/g, '');
    for (const item of salesOrderDetail().evidence) expect(text).not.toContain(item.documentId);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });

  it('links a drafted or invoiced line to its invoice and offers no second draft', async () => {
    mocks.getSalesOrder.mockResolvedValue(
      salesOrderDetail({
        schedule: [
          scheduleLine({
            id: IDS.advance,
            seq: 1,
            status: 'drafted',
            invoiceId: IDS.invoice,
            can: { openInvoice: true },
          }),
          scheduleLine({
            id: IDS.milestone,
            seq: 2,
            status: 'invoiced',
            trigger: 'milestone',
            invoiceId: IDS.invoice,
            can: { openInvoice: true },
          }),
        ],
      }),
    );
    const html = await render();
    expect(html).toContain(`href="/invoices/${IDS.invoice}"`);
    expect(html).toContain('Invoice drafted');
    expect(html).toContain('Invoiced');
    expect(html).not.toContain('Draft invoice</button>');
    expect(html).not.toContain('Mark billable');
  });

  it('says whether delivery is released', async () => {
    expect(await render()).toContain('Not released');
    mocks.getSalesOrder.mockResolvedValue(salesOrderDetail({ deliveryReleased: true }));
    expect(await render()).toContain('Released');
  });

  it('shows no action buttons to a role that may only read', async () => {
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['management'] });
    mocks.getSalesOrder.mockResolvedValue(
      salesOrderDetail({ can: { markBillable: false, draftInvoice: false } }),
    );
    const html = await render();
    expect(html).toContain('Advance 60%');
    expect(html).not.toContain('Draft invoice');
    expect(html).not.toContain('Mark billable');
  });

  it('shows a draft order without a number and offers nothing to do on it', async () => {
    mocks.getSalesOrder.mockResolvedValue(
      salesOrderDetail({
        order: { number: null, status: 'draft', confirmedAt: null, fiscalYear: null },
      }),
    );
    const html = await render();
    expect(html).toContain('Draft sales order');
    expect(html).not.toContain('Mark billable');
    expect(html).not.toContain('Draft invoice');
  });

  it('wraps a very long description instead of widening the page', async () => {
    const long = 'Integration '.repeat(60).trim();
    mocks.getSalesOrder.mockResolvedValue(
      salesOrderDetail({
        lines: [
          {
            lineNo: 1,
            catalogItemId: null,
            description: long,
            uom: 'job',
            quantity: '1.0000',
            unitPrice: '10.00',
            taxCodeId: IDS.tax,
            gross: '10.00',
            discountAlloc: '0.00',
            taxable: '10.00',
          },
        ],
      }),
    );
    expect(await render()).toContain(long);
  });

  it('is a 404 for an id that cannot be an order and for an order the API does not know', async () => {
    await expect(render('not-an-id')).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mocks.getSalesOrder).not.toHaveBeenCalled();
    mocks.getSalesOrder.mockRejectedValue(new ApiError(404, 'x'));
    await expect(render()).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('shows the no-access pattern on 403 and a reloadable error on 500', async () => {
    mocks.getSalesOrder.mockRejectedValue(
      new ApiError(403, 'x', { error: { code: 'forbidden', message: 'm', correlationId: 'c' } }),
    );
    expect(await render()).toContain('Your roles do not include sales orders');

    mocks.getSalesOrder.mockRejectedValue(new ApiError(500, 'x'));
    const html = await render();
    expect(html).toContain('This sales order did not load');
    expect(html).toContain(`href="/sales-orders/${IDS.order}"`);
  });
});
