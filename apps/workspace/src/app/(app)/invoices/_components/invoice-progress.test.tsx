import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { InvoiceProgress } from './invoice-progress';

describe('InvoiceProgress', () => {
  it('renders a discarded timeline instead of hiding progress', () => {
    const html = renderToStaticMarkup(
      <InvoiceProgress invoice={{ kind: 'tax_invoice', status: 'discarded' }} />,
    );
    expect(html).toContain('aria-label="Invoice progress"');
    expect(html).toContain('Draft');
    expect(html).toContain('Prepared');
    expect(html).toContain('Discarded');
  });

  it('renders the standard tax invoice stages for active statuses', () => {
    const html = renderToStaticMarkup(
      <InvoiceProgress invoice={{ kind: 'tax_invoice', status: 'submitted' }} />,
    );
    expect(html).toContain('Draft');
    expect(html).toContain('Approval');
    expect(html).toContain('Pending');
    expect(html).toContain('Ready to issue');
    expect(html).toContain('Issue');
  });

  it('uses the shorter two-stage timeline for proforma invoices', () => {
    const html = renderToStaticMarkup(
      <InvoiceProgress invoice={{ kind: 'proforma', status: 'draft' }} />,
    );
    expect(html).toContain('Draft');
    expect(html).toContain('Issue');
    expect(html).not.toContain('Approval');
  });
});
