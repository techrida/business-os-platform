import { QUOTATION_STATUSES } from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { quotationStatusMeta } from './status';
import { QuotationStatusBadge } from './status-badge';

describe('QuotationStatusBadge', () => {
  it('prints the label as text, so colour is never the only signal', () => {
    for (const status of QUOTATION_STATUSES) {
      const html = renderToStaticMarkup(<QuotationStatusBadge status={status} />);
      expect(html, status).toContain(quotationStatusMeta(status).label);
    }
  });

  it('keeps a rejection source visible in text when it is known', () => {
    const customer = renderToStaticMarkup(
      <QuotationStatusBadge status="rejected" rejectionSource="customer" />,
    );
    const internal = renderToStaticMarkup(
      <QuotationStatusBadge status="rejected" rejectionSource="internal" />,
    );
    expect(customer).toContain('Rejected by customer');
    expect(internal).toContain('Rejected internally');
  });

  it('ignores a rejection source on any other status', () => {
    const html = renderToStaticMarkup(
      <QuotationStatusBadge status="sent" rejectionSource="customer" />,
    );
    expect(html).not.toContain('Rejected');
  });

  it('draws a decorative icon beside the label for every status', () => {
    for (const status of QUOTATION_STATUSES) {
      const html = renderToStaticMarkup(<QuotationStatusBadge status={status} />);
      expect(html, status).toContain('<svg');
      expect(html, status).toContain('aria-hidden="true"');
    }
  });
});
