import { describe, expect, it } from 'vitest';

import { ownsPortalPath } from './top-bar-nav';

const quotations = ['/', '/quotations'];

describe('ownsPortalPath', () => {
  it('gives the landing page and quotation pages to Quotations', () => {
    expect(ownsPortalPath(quotations, '/')).toBe(true);
    expect(ownsPortalPath(quotations, '/quotations/abc')).toBe(true);
  });

  it('does not let "/" claim every path', () => {
    expect(ownsPortalPath(quotations, '/invoices')).toBe(false);
    expect(ownsPortalPath(quotations, '/payments/new')).toBe(false);
  });

  it('matches a page and the pages under it, not a lookalike', () => {
    expect(ownsPortalPath(['/invoices'], '/invoices')).toBe(true);
    expect(ownsPortalPath(['/invoices'], '/invoices/abc')).toBe(true);
    expect(ownsPortalPath(['/invoices'], '/invoices-old')).toBe(false);
  });
});
