import { formatMoney, type Currency } from '@bos/locale';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { PreviewResult } from '@/components/p2/quote-builder/schemas';
import { TotalsPanel } from '@/components/p2/quote-builder/totals-panel';

import { NumberSystemProvider, useNumberSystem } from './number-system-context';

function Amount({ currency }: { currency: Currency }) {
  const numberSystem = useNumberSystem();
  return <span>{formatMoney('2018180', currency, { numberSystem })}</span>;
}

describe('NumberSystemProvider', () => {
  it('defaults to South Asian grouping without a provider', () => {
    expect(renderToStaticMarkup(<Amount currency="NPR" />)).toContain('NPR 20,18,180.00');
  });

  it.each(['NPR', 'USD'] as const)('groups %s as international when the tenant says so', (c) => {
    const html = renderToStaticMarkup(
      <NumberSystemProvider value="international">
        <Amount currency={c} />
      </NumberSystemProvider>,
    );
    expect(html).toContain(`${c} 2,018,180.00`);
  });

  it('applies the tenant grouping to a quote-builder panel', () => {
    const preview: PreviewResult = {
      totals: {
        subtotal: '2018180.00',
        discountAmount: '0.00',
        taxableAmount: '2018180.00',
        taxAmount: '262363.40',
        total: '2280543.40',
        effectiveDiscountPct: '0',
      },
      taxSummary: [],
      route: { steps: [], blocked: false },
    };
    const panel = <TotalsPanel currency="NPR" state="ready" preview={preview} />;
    expect(renderToStaticMarkup(panel)).toContain('NPR 20,18,180.00');
    expect(
      renderToStaticMarkup(
        <NumberSystemProvider value="international">{panel}</NumberSystemProvider>,
      ),
    ).toContain('NPR 2,018,180.00');
  });
});
