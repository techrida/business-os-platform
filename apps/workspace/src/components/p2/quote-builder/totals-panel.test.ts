import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { PreviewResult } from './schemas';
import { TotalsPanel } from './totals-panel';

const ID = '44444444-4444-4444-8444-444444444444';

// Deliberately not what a client could compute from any lines (the figures do not add up):
// if the panel did any maths of its own, these exact strings could not appear.
const preview: PreviewResult = {
  totals: {
    subtotal: '7777777.77',
    discountAmount: '123456.78',
    taxableAmount: '7654320.99',
    taxAmount: '995061.73',
    total: '8649382.72',
    effectiveDiscountPct: '1.5873',
  },
  taxSummary: [
    { taxCodeId: ID, label: 'VAT 13%', rate: '13', base: '7654320.99', tax: '995061.73' },
  ],
  route: { steps: [], blocked: false },
};

const html = (props: Parameters<typeof TotalsPanel>[0]) =>
  renderToStaticMarkup(createElement(TotalsPanel, props));

describe('TotalsPanel', () => {
  it('renders only the values the server returned, with lakh grouping', () => {
    const out = html({ currency: 'NPR', state: 'ready', preview });
    for (const shown of [
      'NPR 77,77,777.77',
      'NPR 1,23,456.78',
      'NPR 9,95,061.73',
      'NPR 86,49,382.72',
      'VAT 13%',
    ]) {
      expect(out).toContain(shown);
    }
  });

  it('shows no amount at all until the server has answered', () => {
    for (const state of ['needs_save', 'error', 'incomplete'] as const) {
      const out = html({ currency: 'NPR', state, message: 'Something to read' });
      expect(out).not.toMatch(/\d{1,3}(,\d{2})*,\d{3}\.\d{2}/);
      expect(out).toContain('Something to read');
    }
    const first = html({ currency: 'NPR', state: 'loading' });
    expect(first).not.toMatch(/\d\.\d{2}/);
  });

  it('marks earlier totals as out of date while a new preview is on the way', () => {
    const out = html({ currency: 'NPR', state: 'loading', preview });
    expect(out).toContain('NPR 86,49,382.72');
    expect(out).toContain('Updating');
  });
});
