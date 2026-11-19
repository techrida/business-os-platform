import { CUSTOMER_VIEW_FORBIDDEN_WORDS } from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { sampleListItem, sampleView } from './quotation-fixtures';
import { QuotationList } from './quotation-list';
import { canRespond, formatDay, isPastValidUntil, todayInKathmandu } from './quotation-status';
import { QuotationView } from './quotation-view';

/**
 * Every word in the markup: text, attribute values and class names alike, split on anything that
 * is not a letter and on camelCase, lower-cased. Whole words only, so "separate" is not "rate".
 */
function wordsOf(markup: string): Set<string> {
  const spaced = markup.replace(/([a-z])([A-Z])/g, '$1 $2');
  return new Set(spaced.split(/[^A-Za-z]+/).map((w) => w.toLowerCase()));
}

function forbiddenIn(markup: string): string[] {
  const words = wordsOf(markup);
  return CUSTOMER_VIEW_FORBIDDEN_WORDS.filter((w) => words.has(w));
}

const TODAY = '2026-11-10';

describe('QuotationView markup', () => {
  it('shows a USD quotation with every field filled and no internal word anywhere', () => {
    const html = renderToStaticMarkup(<QuotationView view={sampleView()} today={TODAY} />);
    expect(forbiddenIn(html)).toEqual([]);
    // Not vacuous: the fields really rendered.
    for (const text of [
      'QT-2082-0042',
      'Big Kahuna Burger Ltd.',
      'Techrida Pvt. Ltd.',
      'Managed switch, 48 port',
      'USD 3,390.00',
      'Site access between 9am and 6pm.',
      'Civil works and painting.',
      'Net 30',
      'Advance',
      'aaaaaaaa',
    ]) {
      expect(html).toContain(text);
    }
  });

  it('shows an NPR quotation with no internal word other than its own currency code', () => {
    const html = renderToStaticMarkup(
      <QuotationView view={sampleView({ currency: 'NPR' })} today={TODAY} />,
    );
    // "NPR" here is the quotation's currency, which the customer must see. The forbidden word
    // means an NPR equivalent of a foreign-currency quotation, which the USD case above rules out.
    expect(forbiddenIn(html.replace(/\bNPR\b/g, ''))).toEqual([]);
    expect(html).toContain('NPR 3,390.00');
  });

  it('shows precise milestone shares and customer-readable due dates', () => {
    const view = sampleView({
      paymentSchedule: [
        { label: 'Advance', percent: '33.3333', dueDescription: 'On order' },
        { label: 'Delivery', percent: '66.6667', dueDescription: '2026-11-19' },
      ],
    });
    const html = renderToStaticMarkup(<QuotationView view={view} today={TODAY} />);
    expect(html).toContain('33.3333%');
    expect(html).toContain('66.6667%');
    expect(html).toContain('On order');
    expect(html).toContain('19 Nov 2026');
  });

  it('renders View PDF and a plain Download link to the BFF route, and neither without a file', () => {
    const html = renderToStaticMarkup(<QuotationView view={sampleView()} today={TODAY} />);
    expect(html).toContain('View PDF');
    expect(html).not.toContain('Download PDF');
    expect(html).toContain(`href="/quotations/${sampleView().id}/document"`);
    // The preview route is fetched by the dialog on open; nothing links to it or requests it at render.
    expect(html).not.toContain('/document/preview');
    expect(html).not.toContain('download=');
    const none = renderToStaticMarkup(
      <QuotationView view={sampleView({ file: null })} today={TODAY} />,
    );
    expect(none).not.toContain('/document"');
    expect(none).not.toContain('View PDF');
  });
});

describe('QuotationList markup', () => {
  it('lists number, status, total and valid-until, with no internal word', () => {
    const html = renderToStaticMarkup(
      <QuotationList
        items={[sampleListItem(), sampleListItem({ status: 'accepted', revisionNo: 1 })]}
        today={TODAY}
      />,
    );
    expect(forbiddenIn(html)).toEqual([]);
    expect(html).toContain('QT-2082-0042');
    expect(html).toContain('USD 2,690,999.99');
    expect(html).toContain('23 Nov 2026');
    expect(html).toContain(`href="/quotations/${sampleListItem().id}"`);
  });
});

describe('quotation status helpers', () => {
  it('a quotation is valid through its valid-until day, in Kathmandu', () => {
    expect(isPastValidUntil('2026-11-10', '2026-11-10')).toBe(false);
    expect(isPastValidUntil('2026-11-09', '2026-11-10')).toBe(true);
    // 2026-11-09 18:30 UTC is already 2026-11-10 00:15 in Kathmandu.
    expect(todayInKathmandu(new Date('2026-11-09T18:30:00Z'))).toBe('2026-11-10');
    expect(formatDay('2026-11-23')).toBe('23 Nov 2026');
  });

  it('only a sent, unexpired quotation can be answered; expiry says why accept is off', () => {
    expect(canRespond(sampleView(), TODAY)).toEqual({ open: true });
    expect(canRespond(sampleView({ validUntil: '2026-11-09' }), TODAY)).toMatchObject({
      open: false,
      expired: true,
    });
    expect(canRespond(sampleView({ status: 'expired' }), TODAY)).toMatchObject({
      open: false,
      expired: true,
    });
    for (const status of ['accepted', 'rejected', 'superseded'] as const) {
      expect(canRespond(sampleView({ status }), TODAY)).toMatchObject({
        open: false,
        expired: false,
      });
    }
  });
});
