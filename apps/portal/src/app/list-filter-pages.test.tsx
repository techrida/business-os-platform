import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { sampleListItem } from '@/app/(portal)/invoices/_components/invoice-fixtures';
import { sampleRfqListItem } from '@/components/vendor/rfq-fixtures';
import {
  sampleBill,
  sampleOnboarding,
  samplePoListItem,
} from '@/components/vendor/vendor-fixtures';
import { session } from '@/lib/billing-test-support';

const m = vi.hoisted(() => ({
  getSession: vi.fn(),
  getVendorOnboarding: vi.fn(),
  listPortalInvoices: vi.fn(),
  listPortalPayments: vi.fn(),
  listVendorPurchaseOrders: vi.fn(),
  listVendorRfqs: vi.fn(),
  listVendorBills: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/here',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/session', () => ({ getSession: m.getSession }));
vi.mock('@/lib/api.billing', () => ({
  listPortalInvoices: m.listPortalInvoices,
  listPortalPayments: m.listPortalPayments,
}));
vi.mock('@/lib/api.vendor', () => ({
  getVendorOnboarding: m.getVendorOnboarding,
  listVendorPurchaseOrders: m.listVendorPurchaseOrders,
  listVendorRfqs: m.listVendorRfqs,
  listVendorBills: m.listVendorBills,
}));

const { default: InvoicesPage } = await import('./(portal)/invoices/page');
const { default: PaymentsPage } = await import('./(portal)/payments/page');
const { default: PurchaseOrdersPage } = await import('./(vendor)/vendor/purchase-orders/page');
const { default: RfqsPage } = await import('./(vendor)/vendor/rfqs/page');
const { default: BillsPage } = await import('./(vendor)/vendor/bills/page');

type Params = Record<string, string | string[]>;
type Page = (props: { searchParams: Promise<Params> }) => Promise<unknown>;

const html = async (page: Page, params: Params = {}) =>
  renderToStaticMarkup((await page({ searchParams: Promise.resolve(params) })) as ReactElement);
const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const count = (markup: string) => /aria-live="polite"[^>]*>([^<]*)</.exec(markup)?.[1];
// Inputs inside <template> are React Aria's inert collection copy and are never submitted.
const hidden = (markup: string, name: string) =>
  [
    ...markup
      .replace(/<template>.*?<\/template>/gs, '')
      .matchAll(new RegExp(`<input[^>]*type="hidden"[^>]*name="${name}"[^>]*>`, 'g')),
  ].length;

const payment = (over: Record<string, unknown>) => ({
  id: '1f8fad5b-d9cb-469f-a165-70867728950e',
  status: 'submitted',
  number: null,
  method: 'bank_transfer',
  currency: 'NPR',
  amount: '1000.00',
  receivedOn: '2026-11-09',
  bankReference: 'TXN-1',
  ...over,
});

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.getSession.mockResolvedValue({ ...session, orgKind: 'customer' });
  m.getVendorOnboarding.mockResolvedValue(
    sampleOnboarding({ status: 'approved', capability: 'full' }),
  );
});

// Shared expectations: no Apply button, a GET search form, the count region, the Clear link.
function expectFilterChrome(markup: string, label: string) {
  expect(markup).toContain('method="get"');
  expect(markup).toContain(`aria-label="${label}"`);
  expect(markup).not.toMatch(/type="submit"/);
  expect(text(markup)).not.toMatch(/\bApply\b/);
  expect(markup).toContain('aria-live="polite"');
}

describe('portal invoices list filters', () => {
  const rows = [
    sampleListItem({ id: '1f8fad5b-d9cb-469f-a165-70867728950e', number: 'INV-001' }),
    sampleListItem({
      id: '2f8fad5b-d9cb-469f-a165-70867728950e',
      kind: 'credit_note',
      number: 'CN-002',
    }),
    sampleListItem({
      id: '3f8fad5b-d9cb-469f-a165-70867728950e',
      kind: 'debit_note',
      number: 'DN-003',
    }),
  ];
  beforeEach(() => m.listPortalInvoices.mockResolvedValue(rows));

  it('shows every row and the toolbar when nothing is selected', async () => {
    const markup = await html(InvoicesPage);
    expectFilterChrome(markup, 'Search invoices');
    expect(count(markup)).toBe('3 invoices');
    for (const n of ['INV-001', 'CN-002', 'DN-003']) expect(markup).toContain(n);
    expect(m.listPortalInvoices).toHaveBeenCalledWith(expect.objectContaining({ id: session.id }));
  });

  it('keeps only the selected types when the param repeats, and submits them without JavaScript', async () => {
    const markup = await html(InvoicesPage, { kind: ['credit_note', 'debit_note'] });
    expect(count(markup)).toBe('2 invoices');
    expect(markup).not.toContain('INV-001');
    expect(markup).toContain('CN-002');
    expect(markup).toContain('DN-003');
    expect(hidden(markup, 'kind')).toBe(2);
  });

  it('searches the invoice number, ignoring case and a one-character term', async () => {
    expect(count(await html(InvoicesPage, { q: 'cn-0' }))).toBe('1 invoice');
    expect(count(await html(InvoicesPage, { q: 'c' }))).toBe('3 invoices');
  });

  it('ignores an unknown type instead of failing the page', async () => {
    expect(count(await html(InvoicesPage, { kind: 'bogus' }))).toBe('3 invoices');
  });

  it('names the hiding filters and links to Clear filters, keeping other params', async () => {
    const markup = await html(InvoicesPage, { kind: 'credit_note', q: 'zzz', view: 'x' });
    expect(count(markup)).toBe('No invoices found');
    expect(text(markup)).toContain('No invoices match');
    expect(text(markup)).toContain('Search “zzz”');
    expect(text(markup)).toContain('Type: Credit note');
    expect(markup).toContain('href="/invoices?view=x"');
    expect(text(markup)).toContain('Clear filters');
  });

  it('keeps the original empty state, without a toolbar, when the customer has no invoices', async () => {
    m.listPortalInvoices.mockResolvedValue([]);
    const markup = await html(InvoicesPage, { q: 'abc' });
    expect(text(markup)).toContain('No invoices yet');
    expect(markup).not.toContain('role="search"');
  });
});

describe('portal payments list filters', () => {
  beforeEach(() =>
    m.listPortalPayments.mockResolvedValue([
      payment({ id: '1f8fad5b-d9cb-469f-a165-70867728950e', bankReference: 'AAA-111' }),
      payment({
        id: '2f8fad5b-d9cb-469f-a165-70867728950e',
        status: 'verified',
        number: 'RCT-77',
        method: 'cheque',
        bankReference: 'BBB-222',
      }),
      payment({
        id: '3f8fad5b-d9cb-469f-a165-70867728950e',
        status: 'rejected',
        bankReference: 'CCC-333',
      }),
    ]),
  );

  it('filters by repeated status values', async () => {
    const markup = await html(PaymentsPage, { status: ['submitted', 'rejected'] });
    expectFilterChrome(markup, 'Search payments');
    expect(count(markup)).toBe('2 payments');
    expect(markup).toContain('AAA-111');
    expect(markup).toContain('CCC-333');
    expect(markup).not.toContain('BBB-222');
  });

  it('searches receipt number, reference and the method as the customer reads it', async () => {
    expect(count(await html(PaymentsPage, { q: 'rct-7' }))).toBe('1 payment');
    expect(count(await html(PaymentsPage, { q: 'ccc' }))).toBe('1 payment');
    expect(count(await html(PaymentsPage, { q: 'cheque' }))).toBe('1 payment');
  });

  it('combines status and search, and names both when nothing is left', async () => {
    const markup = await html(PaymentsPage, { status: 'verified', q: 'AAA' });
    expect(count(markup)).toBe('No payments found');
    expect(text(markup)).toContain('Status: Verified');
    expect(text(markup)).toContain('Search “AAA”');
    expect(markup).toContain('href="/payments"');
  });

  it('still shows the submitted confirmation next to the filters', async () => {
    expect(text(await html(PaymentsPage, { submitted: '1' }))).toContain('We have your payment');
  });
});

describe('vendor purchase orders list filters', () => {
  beforeEach(() =>
    m.listVendorPurchaseOrders.mockResolvedValue([
      samplePoListItem({ id: '1f8fad5b-d9cb-469f-a165-70867728950e', number: 'PO-A1' }),
      samplePoListItem({
        id: '2f8fad5b-d9cb-469f-a165-70867728950e',
        number: 'PO-B2',
        status: 'closed',
      }),
    ]),
  );

  it('filters by status and number', async () => {
    const markup = await html(PurchaseOrdersPage, { status: ['closed', 'cancelled'] });
    expectFilterChrome(markup, 'Search purchase orders');
    expect(count(markup)).toBe('1 purchase order');
    expect(markup).toContain('PO-B2');
    expect(markup).not.toContain('PO-A1');
    expect(count(await html(PurchaseOrdersPage, { q: 'po-a' }))).toBe('1 purchase order');
  });

  it('shows Clear filters with the status names when nothing matches', async () => {
    const markup = await html(PurchaseOrdersPage, { status: 'cancelled' });
    expect(text(markup)).toContain('No purchase orders match');
    expect(text(markup)).toContain('Status: Cancelled');
    expect(markup).toContain('href="/vendor/purchase-orders"');
  });

  it('keeps the plain empty state when the vendor has no orders', async () => {
    m.listVendorPurchaseOrders.mockResolvedValue([]);
    const markup = await html(PurchaseOrdersPage);
    expect(text(markup)).toContain('No purchase orders yet');
    expect(markup).not.toContain('role="search"');
  });
});

describe('vendor bills list filters', () => {
  beforeEach(() =>
    m.listVendorBills.mockResolvedValue([
      sampleBill({
        id: '1f8fad5b-d9cb-469f-a165-70867728950e',
        number: 'BILL-1',
        status: 'received',
      }),
      sampleBill({
        id: '2f8fad5b-d9cb-469f-a165-70867728950e',
        number: 'BILL-2',
        vendorInvoiceNo: 'ZX/9',
        status: 'rejected',
      }),
    ]),
  );

  it('filters by status, and searches our number or the vendor invoice number', async () => {
    const markup = await html(BillsPage, { status: 'rejected' });
    expectFilterChrome(markup, 'Search bills');
    expect(count(markup)).toBe('1 bill');
    expect(markup).toContain('BILL-2');
    expect(markup).not.toContain('BILL-1');
    expect(count(await html(BillsPage, { q: 'zx/' }))).toBe('1 bill');
    expect(count(await html(BillsPage, { q: 'bill-' }))).toBe('2 bills');
  });

  it('shows Clear filters when nothing matches and keeps the submit-a-bill link', async () => {
    const markup = await html(BillsPage, { status: 'approved_for_payment' });
    expect(text(markup)).toContain('No bills match');
    expect(text(markup)).toContain('Status: Approved for payment');
    expect(markup).toContain('href="/vendor/bills"');
    expect(markup).toContain('href="/vendor/bills/new"');
  });
});

describe('vendor RFQ list filters', () => {
  beforeEach(() =>
    m.listVendorRfqs.mockResolvedValue([
      sampleRfqListItem({
        id: '1f8fad5b-d9cb-469f-a165-70867728950e',
        number: 'RFQ-OPEN',
        deadline: '2099-01-01T00:00:00.000Z',
      }),
      sampleRfqListItem({
        id: '2f8fad5b-d9cb-469f-a165-70867728950e',
        number: 'RFQ-PAST',
        deadline: '2020-01-01T00:00:00.000Z',
      }),
    ]),
  );

  it('splits open from deadline-passed requests', async () => {
    const open = await html(RfqsPage, { status: 'open' });
    expectFilterChrome(open, 'Search requests');
    expect(count(open)).toBe('1 request');
    expect(open).toContain('RFQ-OPEN');
    expect(open).not.toContain('RFQ-PAST');
    const closed = await html(RfqsPage, { status: 'closed' });
    expect(closed).toContain('RFQ-PAST');
    expect(closed).not.toContain('RFQ-OPEN');
    expect(count(await html(RfqsPage, { status: ['open', 'closed'] }))).toBe('2 requests');
  });

  it('searches by number and names the filters when nothing matches', async () => {
    expect(count(await html(RfqsPage, { q: 'rfq-pa' }))).toBe('1 request');
    const markup = await html(RfqsPage, { status: 'open', q: 'PAST' });
    expect(text(markup)).toContain('No requests match');
    expect(text(markup)).toContain('Status: Open for quotations');
    expect(markup).toContain('href="/vendor/rfqs"');
  });
});
