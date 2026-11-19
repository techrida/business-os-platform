import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { QuotationApprovalSummary } from './approval-summary';

const snapshot = (over: Record<string, unknown> = {}) => ({
  nprTotal: '2690999.99',
  effectiveDiscountPct: '13.0000',
  marginPct: '22.5000',
  nprDiscountAmount: '400000.00',
  currency: 'USD',
  fxRate: '133.500000',
  customerName: 'Big Kahuna Burger Ltd.',
  quotationNumber: 'QT-2082-0042',
  revisionNo: 2,
  discountApprovalRequired: true,
  ...over,
});

const steps = [
  { seq: 1, reason: 'Every quotation needs a Sales Manager' },
  { seq: 2, reason: 'Discount above 12%' },
];

function render(snap: unknown, s = steps) {
  return renderToStaticMarkup(<QuotationApprovalSummary request={{ snapshot: snap, steps: s }} />);
}

describe('QuotationApprovalSummary', () => {
  it('shows customer, number with revision, money in lakh grouping and the route reasons', () => {
    const html = render(snapshot());
    expect(html).toContain('QT-2082-0042');
    expect(html).toContain('Rev 2');
    expect(html).toContain('Big Kahuna Burger Ltd.');
    expect(html).toContain('NPR 26,90,999.99');
    expect(html).toContain('NPR 4,00,000.00');
    expect(html).toContain('22.5%');
    expect(html).toContain('Every quotation needs a Sales Manager');
    expect(html).toContain('Discount above 12%');
  });

  it('shows the currency and the rate when the document is not in NPR', () => {
    const html = render(snapshot());
    expect(html).toContain('USD');
    expect(html).toContain('1 USD = NPR 133.5');
  });

  it('leaves currency and rate out for an NPR document', () => {
    const html = render(snapshot({ currency: 'NPR', fxRate: '1' }));
    expect(html).not.toContain('Exchange rate');
    expect(html).not.toContain('1 NPR =');
  });

  it('highlights a discount over 12% with words as well as colour', () => {
    const html = render(snapshot());
    expect(html).toContain('13%');
    expect(html).toContain('Above the 12% limit');
  });

  it('does not highlight a discount of exactly 12%, or one below it', () => {
    const flag = { discountApprovalRequired: false };
    expect(render(snapshot({ effectiveDiscountPct: '12.0000', ...flag }))).not.toContain(
      'Above the 12%',
    );
    expect(render(snapshot({ effectiveDiscountPct: '4.5000', ...flag }))).not.toContain(
      'Above the 12%',
    );
  });

  it('follows the server flag over the rounded text: 12.0000 with the flag set is highlighted', () => {
    const html = render(
      snapshot({ effectiveDiscountPct: '12.0000', discountApprovalRequired: true }),
    );
    expect(html).toContain('Above the 12% limit');
  });

  it('says "Not recorded" for an unknown margin, never 0%', () => {
    const html = render(snapshot({ marginPct: null }));
    expect(html).toContain('Not recorded');
    expect(html).not.toContain('0%');
  });

  it('leaves the margin row out when the snapshot carries no margin (no cost permission)', () => {
    const { marginPct, ...noMargin } = snapshot();
    expect(marginPct).toBe('22.5000');
    const html = render(noMargin);
    expect(html).not.toContain('Margin');
    expect(html).not.toContain('Not recorded');
    expect(html).not.toContain('22.5%');
    // The rest of the summary still renders.
    expect(html).toContain('NPR 26,90,999.99');
    expect(html).toContain('Above the 12% limit');
    expect(html).not.toContain('Not in this snapshot');
  });

  it('shows "Not in this snapshot" and the stored values when it does not parse', () => {
    const html = render({ title: 'Quotation QT-1', amount: '1250000.00', currency: 'NPR' });
    expect(html).toContain('Not in this snapshot');
    expect(html).toContain('NPR 12,50,000.00');
    expect(html).toContain('<dl');
    expect(html).not.toContain('Above the 12%');
  });

  it('handles an empty or missing snapshot, and a snake_case one, without throwing', () => {
    expect(render(null)).toContain('Not in this snapshot');
    expect(render({})).toContain('Not in this snapshot');
    const { nprTotal, ...rest } = snapshot();
    expect(render({ ...rest, npr_total: nprTotal })).toContain('Not in this snapshot');
  });

  it('keeps long customer names and reasons as text', () => {
    const name = 'N'.repeat(300);
    const reason = 'r'.repeat(500);
    const html = render(snapshot({ customerName: name }), [{ seq: 1, reason }]);
    expect(html).toContain(name);
    expect(html).toContain(reason);
  });

  it('escapes markup in free text', () => {
    const html = render(snapshot({ customerName: '<img src=x onerror=alert(1)>' }));
    expect(html).not.toContain('<img');
  });
});
