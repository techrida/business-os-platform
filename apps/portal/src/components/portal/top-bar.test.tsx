import type { VendorPortalCapability } from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { TopBar } from './top-bar';

let pathname = '/';
vi.mock('next/navigation', () => ({ usePathname: () => pathname }));

describe('TopBar across customer and vendor portals', () => {
  it.each([
    ['/invoices/invoice-1', 'Invoices'],
    ['/payments/new', 'Payments'],
    ['/milestones/order-1', 'Milestones'],
  ])('keeps the customer billing navigation and active area at %s', (path, active) => {
    pathname = path;
    const html = renderToStaticMarkup(<TopBar />);
    expect(html).toContain('aria-label="Customer portal"');
    for (const label of ['Quotations', 'Milestones', 'Invoices', 'Payments']) {
      expect(html).toContain(`>${label}</a>`);
    }
    expect(html).toMatch(new RegExp(`aria-current="page"[^>]*>${active}</a>`));
    expect(html).not.toContain('aria-label="Vendor portal"');
    expect(html).not.toContain('href="/vendor');
    expect(html).toMatch(/<form(?=[^>]*method="post")(?=[^>]*action="\/auth\/logout")/);
  });

  it.each<{ capability: VendorPortalCapability; links: string[] }>([
    {
      capability: 'full',
      links: ['Onboarding', 'Purchase orders', 'Bills', 'RFQs', 'Bank account'],
    },
    { capability: 'read_only', links: ['Onboarding', 'Purchase orders', 'Bills'] },
    { capability: 'onboarding_only', links: ['Onboarding'] },
    { capability: 'none', links: [] },
  ])('keeps vendor navigation within $capability', ({ capability, links }) => {
    pathname = '/vendor/bills/bill-1';
    const html = renderToStaticMarkup(<TopBar kind="vendor" capability={capability} />);
    expect(html).toContain('Vendor portal');
    for (const label of ['Onboarding', 'Purchase orders', 'Bills', 'RFQs', 'Bank account']) {
      expect(html.includes(`>${label}</a>`)).toBe(links.includes(label));
    }
    expect(html).not.toContain('aria-label="Customer portal"');
    for (const href of ['/', '/milestones', '/invoices', '/payments']) {
      expect(html).not.toContain(`href="${href}"`);
    }
    if (links.includes('Bills')) {
      expect(html).toMatch(/aria-current="page"[^>]*>Bills<\/a>/);
    }
    expect(html).toMatch(/<form(?=[^>]*method="post")(?=[^>]*action="\/auth\/logout")/);
  });
});
