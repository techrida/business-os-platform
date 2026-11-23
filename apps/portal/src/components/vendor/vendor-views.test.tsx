import { forbiddenPortalKeys } from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { BillList } from './bill-list';
import { BillView } from './bill-view';
import { OnboardingView } from './onboarding-view';
import { PurchaseOrderList } from './po-list';
import { PurchaseOrderView } from './po-view';
import { VendorNav } from './vendor-nav';
import { VendorNoAccess } from './vendor-no-access';
import { VendorNotFound } from './vendor-not-found';
import { sampleBill, sampleOnboarding, samplePo, samplePoListItem } from './vendor-fixtures';
import { TopBar } from '../portal/top-bar';

let pathname = '/vendor';
vi.mock('next/navigation', () => ({ usePathname: () => pathname }));

// The real viewer, with the download route it was given written beside it: its Download is a button that fetches
// (R4c2, TR-Q4), so the route no longer shows as a link.
vi.mock('@/components/ui/document-viewer', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/components/ui/document-viewer')>();
  return {
    ...real,
    ViewDocument: (props: Parameters<typeof real.ViewDocument>[0]) => (
      <span data-download-url={props.downloadUrl}>
        <real.ViewDocument {...props} />
      </span>
    ),
  };
});

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('fixtures', () => {
  it('carry no key a vendor must not see', () => {
    for (const data of [sampleOnboarding(), samplePo(), samplePoListItem(), sampleBill()]) {
      expect(forbiddenPortalKeys(data)).toEqual([]);
    }
  });
});

describe('OnboardingView', () => {
  it('tells the vendor when its details changed, by whom, and to upload the documents again', () => {
    const view = sampleOnboarding({
      detailsChanged: { at: '2026-11-23T18:30:00.000Z', by: 'Sita Founder' },
    });
    const t = text(renderToStaticMarkup(<OnboardingView view={view} />));
    // 18:30 UTC is already 24 November in Kathmandu (UTC+5:45).
    expect(t).toMatch(/Details changed on .*24.* by Sita Founder; upload the documents again\./);
    const quiet = text(renderToStaticMarkup(<OnboardingView view={sampleOnboarding()} />));
    expect(quiet).not.toContain('Details changed');
  });

  it('shows the status and every checklist item with its own state', () => {
    const html = renderToStaticMarkup(<OnboardingView view={sampleOnboarding()} />);
    const t = text(html);
    expect(t).toContain('Documents needed');
    for (const label of [
      'PAN certificate',
      'VAT certificate',
      'Tax clearance certificate',
      'Company registration',
      'Bank proof',
    ]) {
      expect(t).toContain(label);
    }
    for (const state of ['Accepted', 'Received', 'Rejected', 'Expired', 'Not uploaded']) {
      expect(t).toContain(state);
    }
    // The tax clearance's expiry is a fact the vendor needs; the day reads in plain words.
    expect(t).toContain('15 Jul 2027');
    expect(html).toContain('<caption');
  });

  it('says what a vendor in each status can do', () => {
    const pending = text(renderToStaticMarkup(<OnboardingView view={sampleOnboarding()} />));
    expect(pending).toMatch(/orders and bills open once/i);
    const approved = text(
      renderToStaticMarkup(
        <OnboardingView view={sampleOnboarding({ status: 'approved', capability: 'full' })} />,
      ),
    );
    expect(approved).toContain('Approved');
    expect(approved).not.toMatch(/orders and bills open once/i);
    const suspended = text(
      renderToStaticMarkup(
        <OnboardingView
          view={sampleOnboarding({ status: 'suspended', capability: 'read_only' })}
        />,
      ),
    );
    expect(suspended).toMatch(/view your orders and bills/i);
  });

  it('shows an empty checklist as a sentence, not an empty table', () => {
    const html = renderToStaticMarkup(
      <OnboardingView view={sampleOnboarding({ documents: [] })} />,
    );
    expect(html).not.toContain('<table');
    expect(text(html)).toContain('No documents are required yet');
  });
});

describe('PurchaseOrderList', () => {
  it('lists number, version, status, date and a lakh-grouped total, with a plain link per row', () => {
    const html = renderToStaticMarkup(
      <PurchaseOrderList
        items={[
          samplePoListItem(),
          samplePoListItem({ id: '1f8fad5b-d9cb-469f-a165-70867728950e', status: 'cancelled' }),
        ]}
      />,
    );
    expect(html).toContain('href="/vendor/purchase-orders/0f8fad5b-d9cb-469f-a165-70867728950e"');
    expect(text(html)).toContain('PO-2082-0007');
    expect(text(html)).toContain('NPR 12,50,000.50');
    expect(text(html)).toContain('08 Nov 2026');
    expect(text(html)).toContain('Cancelled');
    expect(html).toContain('<caption');
  });

  it('shows an empty state when there are no orders', () => {
    const html = renderToStaticMarkup(<PurchaseOrderList items={[]} />);
    expect(text(html)).toContain('No purchase orders yet');
    expect(html).not.toContain('<table');
  });
});

describe('PurchaseOrderView', () => {
  it('shows the issued version, server totals, lines with received quantity, and a PDF Download that stays in the portal', () => {
    const html = renderToStaticMarkup(<PurchaseOrderView view={samplePo()} capability="full" />);
    const t = text(html);
    expect(t).toContain('PO-2082-0007');
    expect(t).toContain('Version 2');
    expect(t).toContain('Partly received');
    expect(t).toContain('NPR 12,50,000.50');
    expect(t).toContain('30 days');
    // Quantities read without the four trailing decimals; unit prices come from the server.
    expect(t).toContain('120');
    expect(t).not.toContain('120.0000');
    expect(t).toContain('2.5');
    expect(t).toContain('NPR 11,96,000.25');
    expect(html).toContain(
      'data-download-url="/vendor/purchase-orders/0f8fad5b-d9cb-469f-a165-70867728950e/pdf"',
    );
    expect(html).not.toContain(
      'href="/vendor/purchase-orders/0f8fad5b-d9cb-469f-a165-70867728950e/pdf"',
    );
    expect(html).toMatch(/<button[^>]*>.*Download<\/button>/);
    expect(html).toContain('View PDF');
    expect(html).not.toContain('Download PDF');
    expect(html).not.toContain('/pdf/preview');
    // No `download` attribute and no prefetching client link: the Download button fetches and keeps an error in the page.
    expect(html).not.toContain('download=');
    expect(t).toContain('PO-2082-0007-v2.pdf');
  });

  it('says the PDF is not ready when the file is null, and offers no link', () => {
    const html = renderToStaticMarkup(
      <PurchaseOrderView view={samplePo({ file: null })} capability="full" />,
    );
    expect(html).not.toContain('/pdf"');
    expect(html).not.toContain('View PDF');
    expect(text(html)).toContain('The PDF is not ready yet');
  });

  it('shows a cancelled order as cancelled and keeps a very long description wrappable', () => {
    const html = renderToStaticMarkup(
      <PurchaseOrderView view={samplePo({ status: 'cancelled' })} capability="full" />,
    );
    expect(text(html)).toContain('Cancelled');
    expect(text(html)).toContain('five-year onsite warranty');
  });
});

describe('BillList and BillView', () => {
  it('lists bills with the coarse status in words and a link to each', () => {
    const items = [
      sampleBill(),
      sampleBill({
        id: '4c9a0b7e-6f1d-4b8a-8d52-1f0e9a7c4b22',
        status: 'under_review',
        payments: [],
      }),
      sampleBill({ id: '5c9a0b7e-6f1d-4b8a-8d52-1f0e9a7c4b22', status: 'rejected' }),
      sampleBill({ id: '6c9a0b7e-6f1d-4b8a-8d52-1f0e9a7c4b22', status: 'received' }),
    ];
    const html = renderToStaticMarkup(<BillList items={items} />);
    const t = text(html);
    for (const label of ['Approved for payment', 'Being checked', 'Rejected', 'Received']) {
      expect(t).toContain(label);
    }
    expect(html).toContain('href="/vendor/bills/3c9a0b7e-6f1d-4b8a-8d52-1f0e9a7c4b22"');
    expect(t).toContain('INV/2082/114');
    expect(t).toContain('NPR 11,80,000.00');
  });

  it('shows an empty state when there are no bills', () => {
    const html = renderToStaticMarkup(<BillList items={[]} />);
    expect(text(html)).toContain('No bills yet');
  });

  it('shows the payable total, the TDS amount and each payment as the server sent them', () => {
    const html = renderToStaticMarkup(<BillView view={sampleBill()} />);
    const t = text(html);
    expect(t).toContain('BILL-2082-0031');
    expect(t).toContain('NPR 11,80,000.00');
    expect(t).toContain('NPR 65,000.00');
    expect(t).toContain('FT26311XYZ');
    expect(t).toContain('NPR 5,00,000.00');
    expect(t).toContain('09 Nov 2026');
    // The balance is never worked out in the browser: no "balance" or "outstanding" figure.
    expect(t).not.toMatch(/balance|outstanding|remaining/i);
  });

  it('says no payment has been made yet when there are none', () => {
    const html = renderToStaticMarkup(<BillView view={sampleBill({ payments: [] })} />);
    expect(text(html)).toContain('No payments have been made against this bill yet');
    expect(html).not.toContain('FT26311XYZ');
  });
});

describe('vendor views with the company display setting', () => {
  const display = {
    numberSystems: { NPR: 'international', INR: 'south_asian', USD: 'international' },
    dateFormat: 'dd/MM/yyyy',
  } as const;

  it('draws order and bill amounts and dates with the setting passed in', () => {
    const render = (node: React.ReactElement) => text(renderToStaticMarkup(node));
    const list = render(<PurchaseOrderList items={[samplePoListItem()]} display={display} />);
    expect(list).toContain('NPR 1,250,000.50');
    expect(list).toContain('08/11/2026');
    expect(list).not.toContain('12,50,000.50');
    const po = render(<PurchaseOrderView view={samplePo()} display={display} capability="full" />);
    expect(po).toContain('NPR 1,250,000.50');
    expect(po).toContain('08/11/2026');
    const bills = render(<BillList items={[sampleBill()]} display={display} />);
    expect(bills).toContain('NPR 1,180,000.00');
    expect(bills).toContain('02/11/2026');
    const bill = render(<BillView view={sampleBill()} display={display} />);
    expect(bill).toContain('07/11/2026');
  });
});

describe('VendorNoAccess and VendorNotFound', () => {
  it('the no-access notice is rendered in place with a sign-out form, and does not redirect', () => {
    const html = renderToStaticMarkup(<VendorNoAccess />);
    expect(html).toContain('action="/auth/logout"');
    expect(html).toContain('method="post"');
    expect(text(html)).toContain('Your vendor account cannot use this page');
  });

  it('the not-found page is one fixed answer that names nothing', () => {
    const html = renderToStaticMarkup(<VendorNotFound />);
    expect(text(html)).toContain('We could not find that page');
    expect(html).toContain('href="/vendor"');
  });
});

describe('VendorNav and TopBar', () => {
  it('a vendor who can only onboard sees the onboarding link and nothing else', () => {
    pathname = '/vendor';
    const html = renderToStaticMarkup(<VendorNav capability="onboarding_only" />);
    expect(text(html)).toContain('Onboarding');
    expect(text(html)).not.toContain('Purchase orders');
    expect(text(html)).not.toContain('Bills');
    expect(html).toContain('aria-current="page"');
  });

  it('an approved or suspended vendor sees orders and bills, and the current area is marked', () => {
    pathname = '/vendor/purchase-orders/0f8fad5b-d9cb-469f-a165-70867728950e';
    for (const capability of ['full', 'read_only'] as const) {
      const html = renderToStaticMarkup(<VendorNav capability={capability} />);
      expect(text(html)).toContain('Purchase orders');
      expect(text(html)).toContain('Bills');
      expect(html.match(/aria-current="page"/g)).toHaveLength(1);
      expect(html).toMatch(/<a[^>]*aria-current="page"[^>]*>Purchase orders<\/a>/);
    }
  });

  it('a blocked vendor gets no links at all', () => {
    expect(renderToStaticMarkup(<VendorNav capability="none" />)).toBe('');
  });

  it('the top bar shows vendor links only for vendors, and customers keep their bar', () => {
    pathname = '/vendor';
    const vendor = renderToStaticMarkup(<TopBar kind="vendor" capability="full" />);
    expect(text(vendor)).toContain('Vendor portal');
    expect(text(vendor)).toContain('Purchase orders');
    expect(vendor).toContain('action="/auth/logout"');
    const customer = renderToStaticMarkup(<TopBar />);
    expect(text(customer)).toContain('Customer portal');
    expect(text(customer)).not.toContain('Purchase orders');
  });
});
