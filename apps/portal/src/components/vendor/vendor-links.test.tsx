import type { VendorKycDocType, VendorVisiblePoStatus } from '@bos/contracts';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

import { Redirect, vendorSession } from '../../app/(vendor)/vendor/_upload/test-kit';
import { OnboardingView } from './onboarding-view';
import { PurchaseOrderView } from './po-view';
import { sampleBill, sampleOnboarding, samplePo } from './vendor-fixtures';
import { VendorNav } from './vendor-nav';

const m = vi.hoisted(() => ({
  getSession: vi.fn(),
  getVendorOnboarding: vi.fn(),
  listVendorBills: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/vendor',
  redirect: (to: string) => {
    throw new Redirect(to);
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('@/lib/session', () => ({ getSession: m.getSession }));
vi.mock('@/lib/api.vendor', () => ({
  getVendorOnboarding: m.getVendorOnboarding,
  listVendorBills: m.listVendorBills,
}));

const { default: BillsPage } = await import('../../app/(vendor)/vendor/bills/page');

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((x) => x[1]);

describe('VendorNav links', () => {
  it('shows RFQs and Bank account to a full vendor only', () => {
    const full = renderToStaticMarkup(<VendorNav capability="full" />);
    expect(hrefs(full)).toEqual([
      '/vendor',
      '/vendor/purchase-orders',
      '/vendor/bills',
      '/vendor/rfqs',
      '/vendor/bank-account',
    ]);
    expect(text(full)).toContain('RFQs');
    expect(text(full)).toContain('Bank account');
  });

  it('keeps read-only vendors on Purchase orders and Bills, without RFQs or Bank account', () => {
    const html = renderToStaticMarkup(<VendorNav capability="read_only" />);
    expect(hrefs(html)).toEqual(['/vendor', '/vendor/purchase-orders', '/vendor/bills']);
    expect(text(html)).not.toContain('RFQs');
    expect(text(html)).not.toContain('Bank account');
  });

  it('shows an onboarding-only vendor the onboarding link alone', () => {
    const html = renderToStaticMarkup(<VendorNav capability="onboarding_only" />);
    expect(hrefs(html)).toEqual(['/vendor']);
  });

  it('shows a blocked vendor nothing', () => {
    expect(renderToStaticMarkup(<VendorNav capability="none" />)).toBe('');
  });
});

describe('OnboardingView send-a-document links', () => {
  it('links every checklist row to the upload page for its own document, with a distinct name', () => {
    const view = sampleOnboarding();
    const html = renderToStaticMarkup(<OnboardingView view={view} />);
    expect(hrefs(html)).toEqual(
      view.documents.map((d) => `/vendor/onboarding/upload?doc=${d.docType}`),
    );
    const labels = [...html.matchAll(/<a [^>]*>(.*?)<\/a>/g)].map((x) => text(x[1] ?? '').trim());
    expect(labels).toHaveLength(view.documents.length);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels[0]).toBe('Send a document for PAN certificate');
    // The visible words are the same on every row; only the hidden suffix tells them apart.
    expect(html).toMatch(/Send a document<span class="[^"]*">\s*for PAN certificate<\/span>/);
  });

  it('url-encodes the document type', () => {
    const odd = 'a b&c' as VendorKycDocType;
    const html = renderToStaticMarkup(
      <OnboardingView
        view={sampleOnboarding({
          documents: [{ docType: odd, state: 'missing', validUntil: null }],
        })}
      />,
    );
    expect(hrefs(html)).toEqual(['/vendor/onboarding/upload?doc=a%20b%26c']);
  });

  it.each(['onboarding_only', 'read_only', 'full'] as const)(
    'offers the links to a %s vendor',
    (capability) => {
      const html = renderToStaticMarkup(<OnboardingView view={sampleOnboarding({ capability })} />);
      expect(html).toContain('Send a document');
    },
  );

  it('offers no link to a blocked vendor, and still lists the documents', () => {
    const html = renderToStaticMarkup(
      <OnboardingView view={sampleOnboarding({ status: 'blocked', capability: 'none' })} />,
    );
    expect(html).not.toContain('Send a document');
    expect(html).not.toContain('<a ');
    expect(text(html)).toContain('PAN certificate');
  });
});

describe('PurchaseOrderView submit-a-bill link', () => {
  const link = (status: VendorVisiblePoStatus) =>
    hrefs(
      renderToStaticMarkup(<PurchaseOrderView view={samplePo({ status })} capability="full" />),
    ).filter((h) => h?.startsWith('/vendor/bills'));

  it.each(['issued', 'partially_received', 'fully_received'] as const)(
    'links to a new bill for the order when it is %s',
    (status) => {
      expect(link(status)).toEqual(['/vendor/bills/new?po=0f8fad5b-d9cb-469f-a165-70867728950e']);
      const html = renderToStaticMarkup(
        <PurchaseOrderView view={samplePo({ status })} capability="full" />,
      );
      expect(text(html)).toContain('Submit a bill');
    },
  );

  it.each(['closed', 'short_closed', 'cancelled'] as const)(
    'offers no bill link when the order is %s',
    (status) => {
      expect(link(status)).toEqual([]);
      const html = renderToStaticMarkup(
        <PurchaseOrderView view={samplePo({ status })} capability="full" />,
      );
      expect(text(html)).not.toContain('Submit a bill');
    },
  );

  it('keeps the bill link when the PDF is not ready', () => {
    const html = renderToStaticMarkup(
      <PurchaseOrderView view={samplePo({ file: null })} capability="full" />,
    );
    expect(text(html)).toContain('Submit a bill');
  });
});

describe('Bills page submit-a-bill link', () => {
  const render = async () => renderToStaticMarkup((await BillsPage()) as ReactElement);

  beforeEach(() => {
    for (const f of Object.values(m)) f.mockReset();
    m.getSession.mockResolvedValue(vendorSession());
    m.listVendorBills.mockResolvedValue([sampleBill()]);
    m.getVendorOnboarding.mockResolvedValue(
      sampleOnboarding({ status: 'approved', capability: 'full' }),
    );
  });

  it('shows the link to a full vendor, above the list', async () => {
    const html = await render();
    expect(hrefs(html)).toContain('/vendor/bills/new');
    expect(text(html)).toContain('Submit a bill');
    expect(html).toContain('<table');
  });

  it.each(['onboarding_only', 'read_only', 'none'] as const)(
    'hides the link from a %s vendor',
    async (capability) => {
      m.getVendorOnboarding.mockResolvedValue(sampleOnboarding({ capability }));
      const html = await render();
      expect(text(html)).not.toContain('Submit a bill');
      expect(html).toContain('<table');
    },
  );

  it('hides the link, and keeps the list, when the onboarding read fails', async () => {
    m.getVendorOnboarding.mockRejectedValue(new ApiError(500, 'boom'));
    const html = await render();
    expect(text(html)).not.toContain('Submit a bill');
    expect(html).toContain('<table');
  });

  it('still answers 403 and 404 from the bills read as before', async () => {
    m.listVendorBills.mockRejectedValue(new ApiError(403, 'no'));
    expect(text(await render())).toContain('cannot use this page');
    m.listVendorBills.mockRejectedValue(new ApiError(404, 'gone'));
    await expect(render()).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('sends a visitor without a session to sign in and back', async () => {
    m.getSession.mockResolvedValue(null);
    await expect(render()).rejects.toThrow('redirect /auth/login?returnTo=%2Fvendor%2Fbills');
    expect(m.getVendorOnboarding).not.toHaveBeenCalled();
  });
});
