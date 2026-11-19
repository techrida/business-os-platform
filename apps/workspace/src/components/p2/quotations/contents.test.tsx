import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { QuotationVersionDto } from '@bos/contracts';

import { QuotationContents } from './contents';
import { PAYMENT_TERM_ID, version } from './contents.fixture';

const TODAY = '2026-11-19';

function render(
  v: QuotationVersionDto,
  props: { internalVisible?: boolean; paymentTermsName?: string; today?: string } = {},
): string {
  return renderToStaticMarkup(
    <QuotationContents
      version={v}
      internalVisible={props.internalVisible ?? false}
      today={TODAY}
      {...props}
    />,
  );
}

/** The text of every cell in the table named `caption`, row by row. */
function rows(html: string, caption: string): string[][] {
  const table = new RegExp(`<caption[^>]*>${caption}</caption>(.*?)</table>`, 's').exec(html)?.[1];
  if (table === undefined) throw new Error(`No table ${caption}`);
  return [...table.matchAll(/<tr>(.*?)<\/tr>/gs)].map((tr) =>
    [...tr[1]!.matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/gs)].map((c) =>
      c[1]!
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    ),
  );
}

describe('line items', () => {
  it('renders each line from the DTO figures, with the tax label from the summary', () => {
    const html = render(version());
    expect(rows(html, 'Line items')).toEqual([
      ['Description', 'Qty', 'Unit price', 'Discount', 'Tax', 'Line total'],
      ['1. Site survey', '2 lot', 'NPR 1,250.50', 'NPR 101.00', 'VAT 13%', 'NPR 2,400.00'],
      ['2. Cabling', '10.5 m', 'NPR 99.99', 'NPR 0.00', 'Exempt 0%', 'NPR 1,049.90'],
    ]);
  });

  it('is a scrollable named region with column scopes, under a heading in order', () => {
    const html = render(version());
    expect(html).toContain('role="region"');
    expect(html).toContain('Line items (scrolls sideways on narrow screens)');
    expect(html).toContain('<th scope="col"');
    // h2 (Panel) comes before every h3 section.
    expect(html.indexOf('<h2')).toBeLessThan(html.indexOf('<h3'));
    expect(html).not.toContain('<h1');
    expect(html).not.toContain('<h4');
  });

  it('says so when there are no lines', () => {
    expect(render(version({ lines: [] }))).toContain('No line items.');
  });
});

describe('internal figures', () => {
  it('shows unit cost, cost total and margin when visible', () => {
    const html = render(version(), { internalVisible: true });
    expect(rows(html, 'Line items')[0]).toContain('Unit cost');
    expect(html).toContain('NPR 800.25');
    expect(html).toContain('NPR 2,231.40');
    expect(html).toContain('35.32%');
  });

  it('puts none of them in the HTML when not visible, even if the data carries them', () => {
    const html = render(version(), { internalVisible: false });
    expect(html).not.toContain('Unit cost');
    expect(html).not.toContain('Margin');
    expect(html).not.toContain('Internal cost');
    expect(html).not.toContain('800.25');
    expect(html).not.toContain('2,231.40');
    expect(html).not.toContain('35.32');
  });

  it('omits the columns when visible but the data has no figures', () => {
    const stripped = version({
      lines: version().lines.map((l) => ({ ...l, unitCost: null })),
      internalCostTotal: null,
      marginPct: null,
    });
    const html = render(stripped, { internalVisible: true });
    expect(html).not.toContain('Unit cost');
    expect(html).not.toContain('Margin');
  });
});

describe('payment schedule', () => {
  it('splits the total half-up with the remainder on the last row, summing exactly', () => {
    const v = version({
      totals: { ...version().totals, total: '100.01' },
      paymentSchedule: [
        { label: 'Advance', percent: '33.3333', dueDescription: 'On order' },
        { label: 'Delivery', percent: '33.3333' },
        { label: 'Handover', percent: '33.3334', dueDescription: '2026-12-31' },
      ],
    });
    const table = rows(render(v), 'Payment schedule');
    expect(table[0]).toEqual(['Milestone', 'Share', 'Amount', 'Due']);
    // 100.01 * 33.3333% = 33.3366... -> 33.34 (half-up); last row takes the rest.
    expect(table.slice(1)).toEqual([
      ['Advance', '33.3333%', 'NPR 33.34', 'On order'],
      ['Delivery', '33.3333%', 'NPR 33.34', '–'],
      ['Handover', '33.3334%', 'NPR 33.33', '31 Dec 2026'],
    ]);
    const sum = table
      .slice(1)
      .map((r) => Number(r[2]!.replace(/[^\d.]/g, '')))
      .reduce((a, b) => a + Math.round(b * 100), 0);
    expect(sum).toBe(10001);
  });

  it('rounds .005 up, not to even', () => {
    const v = version({
      totals: { ...version().totals, total: '0.05' },
      paymentSchedule: [
        { label: 'A', percent: '50' },
        { label: 'B', percent: '50' },
      ],
    });
    // 0.05 * 50% = 0.025 -> 0.03; remainder 0.02.
    expect(
      rows(render(v), 'Payment schedule')
        .slice(1)
        .map((r) => r[2]),
    ).toEqual(['NPR 0.03', 'NPR 0.02']);
  });

  it('keeps up to four decimals and drops padding zeros', () => {
    const v = version({
      paymentSchedule: [
        { label: 'A', percent: '12.5000' },
        { label: 'B', percent: '87.5' },
        { label: 'C', percent: '0.0001' },
      ],
    });
    expect(
      rows(render(v), 'Payment schedule')
        .slice(1)
        .map((r) => r[1]),
    ).toEqual(['12.5%', '87.5%', '0.0001%']);
  });

  it('is absent when there is no schedule', () => {
    const html = render(version());
    expect(html).not.toContain('Payment schedule');
    expect(html).not.toContain('Payment terms');
  });
});

describe('payment terms', () => {
  it('shows the name when given, and never the id', () => {
    const html = render(version({ paymentTermId: PAYMENT_TERM_ID }), {
      paymentTermsName: 'Net 30',
    });
    expect(html).toContain('Payment terms');
    expect(html).toContain('Net 30');
    expect(html).not.toContain(PAYMENT_TERM_ID);
  });

  it('is omitted when the name is absent, and the id is still not shown', () => {
    const html = render(version({ paymentTermId: PAYMENT_TERM_ID }));
    expect(html).not.toContain('Payment terms');
    expect(html).not.toContain(PAYMENT_TERM_ID);
  });
});

describe('validity', () => {
  it('formats dates and shows the expiry state', () => {
    const html = render(version({ validUntil: '2026-11-24' }));
    expect(html).toContain('08 Nov 2026');
    expect(html).toContain('24 Nov 2026');
    expect(html).toContain('Expires in 5 days');
  });

  it('marks an expired quotation', () => {
    expect(render(version({ validUntil: '2026-11-16', status: 'expired' }))).toContain(
      'Expired 3 days ago',
    );
  });

  it('shows no expiry for a closed quotation', () => {
    const html = render(version({ validUntil: '2026-11-16', status: 'accepted' }));
    expect(html).toContain('16 Nov 2026');
    expect(html).not.toContain('Expired');
  });
});

describe('free text sections', () => {
  it('renders each present section with its heading and omits the empty ones', () => {
    const html = render(
      version({
        scope: 'Survey and install.',
        assumptions: 'Power is available.',
        exclusions: null,
        deliveryTimeline: '   ',
      }),
    );
    expect(html).toContain('>Scope<');
    expect(html).toContain('Survey and install.');
    expect(html).toContain('>Assumptions<');
    expect(html).not.toContain('>Exclusions<');
    expect(html).not.toContain('>Delivery timeline<');
  });

  it('collapses long text behind Show more', () => {
    const html = render(version({ exclusions: 'Not included. '.repeat(40) }));
    expect(html).toContain('Show more');
    expect(html).toContain('aria-expanded="false"');
  });

  it('draws rich wording as lists and paragraphs and never lets a script through', () => {
    const html = render(
      version({
        scope: '<p>Includes:</p><ul><li>Survey</li><li>Install</li></ul><script>alert(1)</script>',
        termsAndConditions: '<ol><li>Pay in 30 days</li></ol>',
      }),
    );
    expect(html).toContain('<ul><li>Survey</li><li>Install</li></ul>');
    expect(html).toContain('<ol><li>Pay in 30 days</li></ol>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('alert(1)');
    expect(html).not.toContain('&lt;ul&gt;');
  });

  it('still shows wording saved as plain text, and skips rich wording with no words', () => {
    const html = render(version({ scope: 'Survey and install.', exclusions: '<p></p>' }));
    expect(html).toContain('<p>Survey and install.</p>');
    expect(html).not.toContain('>Exclusions<');
  });

  it('judges long on the words, not the markup', () => {
    const shortRich = '<p><strong>Net</strong> 30</p>'.repeat(3);
    expect(render(version({ scope: shortRich }))).not.toContain('Show more');
    const longRich = `<p>${'Install and test the cabling. '.repeat(10)}</p>`;
    expect(render(version({ scope: longRich }))).toContain('Show more');
  });
});
