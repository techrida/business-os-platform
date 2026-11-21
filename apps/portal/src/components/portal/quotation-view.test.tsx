import { CUSTOMER_VIEW_FORBIDDEN_WORDS } from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

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

// The real viewer, with the download route it was given written beside it: its Download is a button that fetches
// (R4c2, TR-Q4), so the route no longer shows as a link.
vi.mock('@/components/ui/document-viewer', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/components/ui/document-viewer')>();
  return {
    ...real,
    ViewDocument: (props: Parameters<typeof real.ViewDocument>[0]) => (
      <span data-download-url={props.downloadUrl}>
        <real.ViewDocument {...props} />
      </span>
    ),
  };
});

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

  it('shows the tax rate once when the tax code name already carries it', () => {
    const view = sampleView({
      taxSummary: [{ label: 'VAT 13%', percent: '13', tax: '390.00' }],
    } as never);
    const html = renderToStaticMarkup(<QuotationView view={view} today={TODAY} />);
    expect(html).toContain('VAT 13%');
    expect(html).not.toContain('VAT 13% 13%');
  });

  it('draws no empty Terms card when the quotation has no terms and no payment schedule', () => {
    const view = sampleView({
      scope: null,
      assumptions: null,
      exclusions: null,
      termsAndConditions: null,
      deliveryTimeline: null,
      paymentTermName: null,
      paymentSchedule: [],
    });
    const html = renderToStaticMarkup(<QuotationView view={view} today={TODAY} />);
    expect(html).not.toContain('>Terms<');
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
        { label: 'Advance', percent: '33.3333', amount: '1129.99', dueDescription: 'On order' },
        { label: 'Delivery', percent: '66.6667', amount: '2260.01', dueDescription: '2026-11-19' },
      ],
    });
    const html = renderToStaticMarkup(<QuotationView view={view} today={TODAY} />);
    expect(html).toContain('33.3333%');
    expect(html).toContain('66.6667%');
    expect(html).toContain('On order');
    expect(html).toContain('19 Nov 2026');
  });

  it("shows each milestone's amount exactly as the API sent it, never recomputed (D36)", () => {
    // 3,390.00 at 40/60 would be 1,356.00 and 2,034.00; these amounts differ on purpose, so a screen that
    // recomputed from the percents would show the wrong figures.
    const view = sampleView({
      paymentSchedule: [
        { label: 'Advance', percent: '40', amount: '1000.00' },
        { label: 'Balance', percent: '60', amount: '2390.00' },
      ],
    });
    const html = renderToStaticMarkup(<QuotationView view={view} today={TODAY} />);
    expect(html).toContain('USD 1,000.00');
    expect(html).toContain('USD 2,390.00');
    expect(html).not.toContain('1,356.00');
    expect(html).not.toContain('2,034.00');
  });

  it('renders View PDF and a Download button for the BFF route, and neither without a file', () => {
    const html = renderToStaticMarkup(<QuotationView view={sampleView()} today={TODAY} />);
    expect(html).toContain('View PDF');
    expect(html).not.toContain('Download PDF');
    expect(html).toContain(`data-download-url="/quotations/${sampleView().id}/document"`);
    expect(html).not.toContain(`href="/quotations/${sampleView().id}/document"`);
    expect(html).toMatch(/<button[^>]*>.*Download<\/button>/);
    // The preview route is fetched by the dialog on open; nothing links to it or requests it at render.
    expect(html).not.toContain('/document/preview');
    expect(html).not.toContain('download=');
    const none = renderToStaticMarkup(
      <QuotationView view={sampleView({ file: null })} today={TODAY} />,
    );
    expect(none).not.toContain('/document"');
    expect(none).not.toContain('View PDF');
  });

  it('says the PDF is being prepared, is delayed after a failed render, or offers it when ready', () => {
    const pending = renderToStaticMarkup(
      <QuotationView view={sampleView({ file: null, renderFailed: false })} today={TODAY} />,
    );
    expect(pending).toContain('The PDF copy is being prepared.');
    expect(pending).not.toContain('delayed');
    // An older payload without the flag reads as pending.
    const { renderFailed: _r, ...older } = sampleView({ file: null });
    expect(renderToStaticMarkup(<QuotationView view={older} today={TODAY} />)).toContain(
      'The PDF copy is being prepared.',
    );

    const failed = renderToStaticMarkup(
      <QuotationView view={sampleView({ file: null, renderFailed: true })} today={TODAY} />,
    );
    expect(failed).toContain('This PDF is delayed. Our team has been told.');
    expect(failed).not.toContain('being prepared');
    expect(failed).not.toMatch(/retry|try again/i);
    expect(failed).not.toContain('View PDF');

    const ready = renderToStaticMarkup(
      <QuotationView view={sampleView({ renderFailed: true })} today={TODAY} />,
    );
    expect(ready).toContain('View PDF');
    expect(ready).not.toContain('delayed');
    expect(ready).not.toContain('being prepared');
  });
});

describe('QuotationView display setting', () => {
  const international = { NPR: 'international', INR: 'south_asian', USD: 'international' } as const;

  it('draws amounts and dates with the setting the version was sent with', () => {
    const base = sampleView();
    const view = sampleView({
      currency: 'NPR',
      issueDate: '2026-11-19',
      validUntil: '2026-11-30',
      totals: { ...base.totals, total: '2018180.00' },
      display: { numberSystems: international, dateFormat: 'dd/MM/yyyy' },
    });
    const html = renderToStaticMarkup(<QuotationView view={view} today={TODAY} />);
    expect(html).toContain('NPR 2,018,180.00');
    expect(html).toContain('19/11/2026');
    expect(html).toContain('30/11/2026');
    expect(html).not.toContain('20,18,180.00');
    expect(html).not.toContain('19 Nov 2026');
  });

  it('says when an expired quotation lapsed in the same date format', () => {
    const view = sampleView({
      validUntil: '2026-11-09',
      display: { numberSystems: international, dateFormat: 'dd/MM/yyyy' },
    });
    const result = canRespond(view, TODAY);
    expect(result).toMatchObject({ open: false, expired: true });
    expect(result.open === false && result.reason).toContain('09/11/2026');
  });

  it('draws a list with the display it is given, and the defaults without one', () => {
    const items = [
      sampleListItem({ currency: 'NPR', total: '2018180.00', validUntil: '2026-11-23' }),
    ];
    const given = renderToStaticMarkup(
      <QuotationList
        items={items}
        today={TODAY}
        display={{ numberSystems: international, dateFormat: 'yyyy-MM-dd' }}
      />,
    );
    expect(given).toContain('NPR 2,018,180.00');
    expect(given).toContain('2026-11-23');
    const defaults = renderToStaticMarkup(<QuotationList items={items} today={TODAY} />);
    expect(defaults).toContain('NPR 20,18,180.00');
    expect(defaults).toContain('23 Nov 2026');
  });
});

describe('QuotationView terms as rich text', () => {
  it('draws lists as real lists, nested ones inside their item', () => {
    const view = sampleView({
      scope: '<p>Includes:</p><ul><li>Cabling<ul><li>Cat6</li></ul></li><li>Racks</li></ul>',
      assumptions: '<ol><li>Access granted</li><li>Power on site</li></ol>',
    });
    const html = renderToStaticMarkup(<QuotationView view={view} today={TODAY} />);
    expect(html).toContain('<p>Includes:</p>');
    expect(html).toContain('<ul><li>Cabling<ul><li>Cat6</li></ul></li><li>Racks</li></ul>');
    expect(html).toContain('<ol><li>Access granted</li><li>Power on site</li></ol>');
  });

  it('leaves out scripts, links and handlers a stored term might carry', () => {
    const view = sampleView({
      termsAndConditions:
        '<p onclick="steal()">Pay <strong>on time</strong>. See <a href="https://evil.test/x">the site</a></p><script>alert(1)</script><p><img src=x onerror=alert(2)>End</p>',
    });
    const html = renderToStaticMarkup(<QuotationView view={view} today={TODAY} />);
    expect(html).toContain('<p>Pay <strong>on time</strong>. See the site</p>');
    expect(html).toContain('End');
    for (const bad of ['<script', 'alert(1)', 'evil.test', 'onclick', 'onerror', '<img']) {
      expect(html).not.toContain(bad);
    }
  });

  it('still draws wording saved as plain text, escaped, one paragraph per block', () => {
    const view = sampleView({ exclusions: 'Civil works <b>& painting</b>.\n\nPermits.' });
    const html = renderToStaticMarkup(<QuotationView view={view} today={TODAY} />);
    expect(html).toContain('<p>Civil works &lt;b&gt;&amp; painting&lt;/b&gt;.</p><p>Permits.</p>');
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
