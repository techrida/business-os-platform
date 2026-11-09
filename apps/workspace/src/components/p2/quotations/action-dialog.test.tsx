import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ErrorSummary } from './action-dialog';

describe('ErrorSummary reload action', () => {
  const props = {
    error: 'This record changed. Reload before trying again.',
    reload: true,
    reloadHref: '/procurement/orders/order-1',
    summaryRef: createRef<HTMLDivElement>(),
  };

  it('uses the supplied document label and reload destination', () => {
    const html = renderToStaticMarkup(
      <ErrorSummary {...props} reloadLabel="Reload this purchase order" />,
    );
    expect(html).toContain('href="/procurement/orders/order-1"');
    expect(html).toContain('Reload this purchase order');
    expect(html).not.toContain('Reload this quotation');
  });

  it('keeps the existing quotation label when no label is supplied', () => {
    expect(renderToStaticMarkup(<ErrorSummary {...props} />)).toContain('Reload this quotation');
  });

  it('offers no reload action when the refusal does not call for one', () => {
    expect(renderToStaticMarkup(<ErrorSummary {...props} reload={false} />)).not.toContain('<a ');
  });

  it('renders nothing without an error', () => {
    expect(renderToStaticMarkup(<ErrorSummary {...props} error={undefined} />)).toBe('');
  });
});
