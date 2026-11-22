import {
  defaultPortalDisplay,
  CUSTOMER_VIEW_FORBIDDEN_WORDS,
  CustomerQuotationViewSchema,
  DOCUMENT_LAYOUTS,
  DocumentStyleSnapshotSchema,
  EMPTY_SNAPSHOT_COMPANY_PROFILE,
  deriveBrandPalette,
  type SnapshotCompanyProfile,
  type CustomerQuotationView,
  type DocumentLayout,
  type DocumentStyleSnapshot,
} from '@bos/contracts';
import { amountInWords } from '@bos/locale';
import { describe, expect, it } from 'vitest';

import { NEUTRALS } from './layouts/shared.js';
import { renderQuotationHtml } from './quotation-html.js';

const address = { line: '1 Durbar Marg', city: 'Kathmandu' };

const sample = (currency: 'USD' | 'NPR', over: Partial<CustomerQuotationView> = {}) =>
  CustomerQuotationViewSchema.parse({
    id: '11111111-1111-4111-8111-111111111111',
    display: defaultPortalDisplay(),
    number: 'QT-2082-0042',
    revisionNo: 2,
    status: 'sent',
    issueDate: '2026-11-08',
    validUntil: '2026-11-23',
    currency,
    issuer: { legalName: 'Techrida Pvt. Ltd.', panVatNo: '301234567', country: 'NP', address },
    customer: {
      legalName: 'Himal Traders Pvt. Ltd.',
      panVatNo: 'ABC-12345',
      country: 'NP',
      address,
    },
    contact: { fullName: 'Sita Rai', email: 'sita@himal.example' },
    scope: 'Supply and install 12 panels\nIncludes commissioning',
    assumptions: 'Site access is available',
    exclusions: null,
    termsAndConditions: null,
    deliveryTimeline: '6 weeks',
    paymentTermName: 'Net 30',
    paymentSchedule: [
      { label: 'Advance', percent: '60', amount: '366120.00', dueDescription: 'On order' },
      { label: 'Balance', percent: '40', amount: '244080.00' },
    ],
    lines: [
      {
        lineNo: 1,
        description: 'Solar panel 550W',
        uom: 'pcs',
        quantity: '12',
        unitPrice: '45000.00',
        amount: '540000.00',
      },
      {
        lineNo: 2,
        description: 'Mounting kit',
        uom: 'set',
        quantity: '2.5',
        unitPrice: '1250000.00',
        amount: '3125000.00',
      },
    ],
    totals: {
      subtotal: '3665000.00',
      discountAmount: '65000.00',
      taxableAmount: '3600000.00',
      taxAmount: '468000.00',
      total: '4068000.00',
    },
    taxSummary: [{ label: 'VAT', percent: '13', base: '3600000.00', tax: '468000.00' }],
    file: null,
    ...over,
  });

// A 1x1 transparent PNG: passes LogoDataUrlSchema.
const LOGO =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const PROFILE: SnapshotCompanyProfile = {
  displayName: 'Techrida',
  logoDataUrl: null,
  phones: ['+97714000000', '+9779800000000'],
  email: 'hello@techrida.example',
  website: 'techrida.example',
  panVatNo: '609876543',
  signatoryName: 'Amanda Vance',
  signatoryTitle: 'Director',
};

const snapshot = (
  layout: DocumentLayout,
  primaryColour = '#1d4ed8',
  over: Partial<DocumentStyleSnapshot> = {},
): DocumentStyleSnapshot => ({
  style: { layout, primaryColour },
  profile: PROFILE,
  numberSystem: 'south_asian',
  capturedAt: '2026-11-19T00:00:00.000Z',
  ...over,
});

const COLOURS = ['#1d4ed8', '#be123c'] as const;
const CASES = DOCUMENT_LAYOUTS.flatMap((layout) =>
  COLOURS.map((colour) => [layout, colour] as const),
);

/**
 * The NPR currency code is a legitimate word on a quotation, so strip it before the forbidden-word scan. The
 * <style> block goes too (the CSS property `margin` is layout, not content a customer reads), and so does the
 * logo's base64, whose `+` and `/` are word boundaries.
 */
const withoutCurrencyCode = (html: string) =>
  html
    .replace(/<style>[\s\S]*?<\/style>/g, '')
    .replace(/src="data:[^"]*"/g, '')
    .replace(/\bNPR\b/g, '');

const forbiddenIn = (html: string) =>
  CUSTOMER_VIEW_FORBIDDEN_WORDS.filter((w) =>
    new RegExp(`\\b${w}\\b`, 'i').test(withoutCurrencyCode(html)),
  );

/** The text as a reader sees it: line-break opportunities removed. */
const withoutWbr = (html: string) => html.replace(/<wbr>/g, '');

const cssOf = (html: string) => (html.match(/<style>([\s\S]*?)<\/style>/) ?? ['', ''])[1]!;

describe('renderQuotationHtml', () => {
  it('renders a self-contained A4 document with the Noto font stack', () => {
    const html = renderQuotationHtml(sample('USD'));
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain("font-family: 'Noto Sans', 'Noto Sans Devanagari', sans-serif");
    expect(html).toMatch(/@page\s*\{[^}]*size:\s*A4/);
    // Nothing is fetched: no URL, no stylesheet link, no script, no image, no CSS url().
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toMatch(/<(link|script|img|iframe|object|embed)\b/i);
    expect(html).not.toMatch(/url\(|@import|\bsrc=|\bhref=/i);
    expect(html).toContain(
      `http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"`,
    );
  });

  it('shows the parties, the number with its revision, and the dates', () => {
    const html = withoutWbr(renderQuotationHtml(sample('USD')));
    for (const text of [
      'QT-2082-0042 Rev 2',
      'Techrida Pvt. Ltd.',
      '301234567',
      'Himal Traders Pvt. Ltd.',
      'ABC-12345',
      'Sita Rai',
      'sita@himal.example',
      '1 Durbar Marg',
      'Net 30',
      '6 weeks',
      'Solar panel 550W',
      'Advance',
      'On order',
      '60%',
    ]) {
      expect(html, text).toContain(text);
    }
    expect(html).toContain('08 Nov 2026');
    expect(html).toContain('23 Nov 2026');
  });

  it('prints four-decimal shares and formats dated milestones in the PDF template', () => {
    const html = renderQuotationHtml({
      ...sample('USD'),
      paymentSchedule: [
        { label: 'Advance', percent: '33.3333', amount: '333.33', dueDescription: 'On order' },
        { label: 'Delivery', percent: '33.3333', amount: '333.33', dueDescription: '2026-11-19' },
        { label: 'Balance', percent: '33.3334', amount: '333.34', dueDescription: '2026-11-23' },
      ],
    });
    expect(html).toContain(
      '<td>Advance</td><td>33.3333%</td><td class="num">USD 333.33</td><td class="muted">On order</td>',
    );
    expect(html).toContain(
      '<td>Delivery</td><td>33.3333%</td><td class="num">USD 333.33</td><td class="muted">19 Nov 2026</td>',
    );
    expect(html).toContain(
      '<td>Balance</td><td>33.3334%</td><td class="num">USD 333.34</td><td class="muted">23 Nov 2026</td>',
    );
  });

  it('shows the BS date next to the date, and leaves it out on request', () => {
    // Kartik 1, 2083 fell on 18 Oct 2026, so 8 Nov 2026 is 22 Kartik 2083 and 23 Nov is 7 Mangsir.
    const html = renderQuotationHtml(sample('USD'));
    expect(html).toContain('08 Nov 2026 <span class="bs">(22 Kartik 2083 BS)</span>');
    expect(html).toContain('(07 Mangsir 2083 BS)');
    expect(renderQuotationHtml(sample('USD'), { showBsDate: false })).not.toContain('BS');
  });

  it('groups money by the snapshot number system, South Asian when there is no snapshot', () => {
    // Without a snapshot each currency uses its default (D30): NPR and INR lakh grouping, USD thousands.
    const usd = renderQuotationHtml(sample('USD'));
    expect(usd).toContain('USD 4,068,000.00');
    expect(usd).toContain('45,000.00');
    const npr = renderQuotationHtml(sample('NPR'));
    expect(npr).toContain('NPR 40,68,000.00');
    expect(npr).toContain('12,50,000.00');
    expect(npr).not.toContain('4,068,000.00');
    const intl = renderQuotationHtml(sample('NPR'), {
      snapshot: snapshot('banded', '#1d4ed8', { numberSystem: 'international' }),
    });
    expect(intl).toContain('NPR 4,068,000.00');
    expect(intl).toContain('1,250,000.00');
    expect(intl).not.toContain('40,68,000.00');
  });

  it('applies a legacy single-system snapshot to every currency and a per-currency map to each', () => {
    const legacy = renderQuotationHtml(sample('USD'), {
      snapshot: snapshot('banded', '#1d4ed8', { numberSystem: 'south_asian' }),
    });
    expect(legacy).toContain('USD 40,68,000.00');
    const mapped = renderQuotationHtml(sample('USD'), {
      snapshot: snapshot('banded', '#1d4ed8', {
        numberSystems: { NPR: 'international', INR: 'south_asian', USD: 'south_asian' },
      }),
    });
    expect(mapped).toContain('USD 40,68,000.00');
    expect(mapped).toContain('Forty Lakh Sixty Eight Thousand Dollars Only');
    const npr = renderQuotationHtml(sample('NPR'), {
      snapshot: snapshot('banded', '#1d4ed8', {
        numberSystems: { NPR: 'international', INR: 'south_asian', USD: 'south_asian' },
      }),
    });
    expect(npr).toContain('NPR 4,068,000.00');
    expect(npr).toContain('Four Million Sixty Eight Thousand Rupees Only');
  });

  it('names the currency once in the item headers and prints bare figures in the rows', () => {
    const html = renderQuotationHtml(sample('NPR'));
    expect(html).toContain('Unit price (NPR)');
    expect(html).toContain('Amount (NPR)');
    expect(html).toContain('<td class="num">5,40,000.00</td>');
  });

  it('shows the VAT line by percent and base, and the discount only when there is one', () => {
    const html = renderQuotationHtml(sample('USD'));
    expect(html).toContain('VAT (13%)');
    expect(html).toContain('USD 468,000.00');
    expect(html).toContain('Discount');
    expect(html).toContain('Total due');
    const noDiscount = renderQuotationHtml(
      sample('USD', {
        totals: {
          subtotal: '3600000.00',
          discountAmount: '0.00',
          taxableAmount: '3600000.00',
          taxAmount: '468000.00',
          total: '4068000.00',
        },
      }),
    );
    expect(noDiscount).not.toContain('Discount');
  });

  it('shows the quantity as given', () => {
    expect(renderQuotationHtml(sample('USD'))).toMatch(/>2\.5</);
  });

  it('says so when there are no lines instead of printing an empty table', () => {
    expect(renderQuotationHtml(sample('USD', { lines: [] }))).toContain(
      'No items on this quotation.',
    );
  });

  it('carries none of the forbidden internal words, in a USD and an NPR document', () => {
    for (const currency of ['USD', 'NPR'] as const) {
      const html = renderQuotationHtml(sample(currency));
      expect(forbiddenIn(html), currency).toEqual([]);
    }
    // The scan itself works: a planted word is found.
    expect(forbiddenIn('<td>Unit cost</td>')).toEqual(['cost']);
    expect(forbiddenIn('<td>Exchange rate</td>')).toEqual(['rate']);
    expect(forbiddenIn('<td>NPR 5.00</td>')).toEqual([]);
    expect(forbiddenIn('<style>td { margin: 0 }</style><td>Margin 5%</td>')).toEqual(['margin']);
  });

  it('escapes markup in every text field', () => {
    const evil = '<b>x</b>';
    const addr = { line: evil, city: evil };
    const html = renderQuotationHtml(
      sample('USD', {
        number: 'QT-<b>x</b>',
        issuer: { legalName: evil, panVatNo: '301234567', country: 'NP', address: addr },
        customer: { legalName: evil, panVatNo: 'ABC-12345', country: 'NP', address: addr },
        contact: { fullName: evil, email: evil },
        scope: evil,
        assumptions: evil,
        exclusions: evil,
        termsAndConditions: evil,
        deliveryTimeline: evil,
        paymentTermName: evil,
        paymentSchedule: [{ label: evil, percent: '100', amount: '100.00', dueDescription: evil }],
        lines: [
          {
            lineNo: 1,
            description: `${evil} & "q" 'a'`,
            uom: evil,
            quantity: '1',
            unitPrice: '1.00',
            amount: '1.00',
          },
        ],
        taxSummary: [{ label: evil, percent: '13', base: '1.00', tax: '0.13' }],
      }),
    );
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('</b>');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt; &amp; &quot;q&quot; &#39;a&#39;');
    // Every field was escaped, not just one of them.
    expect(html.match(/&lt;b&gt;x&lt;\/b&gt;/g)!.length).toBeGreaterThanOrEqual(19);
  });

  it('prints the terms and conditions after the delivery timeline, and nothing when there are none', () => {
    const terms = 'Payment within 15 days.\nPrices exclude freight.';
    const html = renderQuotationHtml(sample('USD', { termsAndConditions: terms }));
    expect(html).toContain('<h2>Terms and conditions</h2>');
    expect(html).toContain('<p>Payment within 15 days.<br>Prices exclude freight.</p>');
    expect(html.indexOf('<h2>Delivery timeline</h2>')).toBeGreaterThan(-1);
    expect(html.indexOf('<h2>Terms and conditions</h2>')).toBeGreaterThan(
      html.indexOf('<h2>Delivery timeline</h2>'),
    );
    expect(renderQuotationHtml(sample('USD'))).not.toContain('Terms and conditions');
  });

  it('marks a version that is no longer open to accept', () => {
    expect(renderQuotationHtml(sample('USD'))).not.toContain('class="status"');
    const html = renderQuotationHtml(sample('USD', { status: 'superseded' }));
    expect(html).toContain('class="status"');
    expect(html).toContain('Superseded');
  });

  it('omits empty sections instead of printing blanks', () => {
    const html = renderQuotationHtml(
      sample('USD', {
        scope: null,
        assumptions: null,
        exclusions: null,
        deliveryTimeline: null,
        paymentSchedule: [],
        paymentTermName: null,
        contact: null,
      }),
    );
    for (const heading of ['Scope', 'Assumptions', 'Exclusions', 'Payment schedule', 'Delivery']) {
      expect(html, heading).not.toContain(heading);
    }
  });

  it('falls back to the default layout for a layout it does not know', () => {
    const bad = snapshot('banded');
    const html = renderQuotationHtml(sample('USD'), {
      snapshot: { ...bad, style: { ...bad.style, layout: 'constructor' as DocumentLayout } },
    });
    expect(html).toContain('<body class="layout-banded">');
  });
});

describe.each(CASES)('layout %s in %s', (layout, colour) => {
  const palette = deriveBrandPalette(colour);
  const render = (view = sample('NPR'), over: Partial<DocumentStyleSnapshot> = {}) =>
    renderQuotationHtml(view, { snapshot: snapshot(layout, colour, over) });

  it('uses the layout and the palette primary', () => {
    const html = render();
    expect(html).toContain(`<body class="layout-${layout}">`);
    expect(cssOf(html)).toContain(palette.primary);
  });

  it('takes every hex colour from the palette or the neutral list', () => {
    const allowed = new Set<string>([
      ...Object.values<string>(palette as unknown as Record<string, string>),
      ...Object.values(NEUTRALS),
    ]);
    const found = cssOf(render()).match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(found.length).toBeGreaterThan(0);
    expect(found.filter((hex) => !allowed.has(hex.toLowerCase()))).toEqual([]);
  });

  it('prints the terms and conditions in every layout', () => {
    const html = render(sample('NPR', { termsAndConditions: 'Goods remain ours until paid.' }));
    expect(html).toContain('<h2>Terms and conditions</h2>');
    expect(html).toContain('Goods remain ours until paid.');
    expect(render()).not.toContain('Terms and conditions');
  });

  describe('rich wording', () => {
    const FIELDS = [
      'scope',
      'assumptions',
      'exclusions',
      'termsAndConditions',
      'deliveryTimeline',
    ] as const;
    const NO_WORDING = {
      scope: null,
      assumptions: null,
      exclusions: null,
      termsAndConditions: null,
      deliveryTimeline: null,
    } as const;
    const RICH =
      '<p>Intro <strong>bold</strong> and <em>slanted</em></p><ul><li>First bullet<ul><li>Nested bullet</li></ul></li><li>Second bullet</li></ul><ol><li>Step one</li><li>Step two</li></ol>';
    const HOSTILE =
      '<p>Safe words</p><script>alert(1)</script><p><a href="javascript:alert(1)">click</a></p><img src=x onerror=alert(1)><ul><li onclick="x()">item</li></ul>';

    it.each(FIELDS)('draws %s as lists and emphasis', (field) => {
      const html = render(sample('NPR', { ...NO_WORDING, [field]: RICH }));
      expect(html).toContain('<strong>bold</strong>');
      expect(html).toContain('<em>slanted</em>');
      expect(html).toContain(
        '<ul><li>First bullet<ul><li>Nested bullet</li></ul></li><li>Second bullet</li></ul>',
      );
      expect(html).toContain('<ol><li>Step one</li><li>Step two</li></ol>');
      expect(html).toContain('<div class="rich">');
    });

    it.each(FIELDS)('never lets markup through in %s', (field) => {
      const html = render(sample('NPR', { ...NO_WORDING, [field]: HOSTILE }));
      expect(html).toContain('Safe words');
      expect(html).toContain('<li>item</li>');
      expect(html).not.toContain('<script');
      expect(html).not.toContain('<a ');
      expect(html).not.toContain('onerror');
      expect(html).not.toContain('onclick');
      expect(html).not.toContain('javascript:');
      expect(html).not.toContain('alert(1)');
      expect(html).not.toContain('<img src=x');
    });

    it('draws legacy plain text as an escaped paragraph with line breaks', () => {
      const html = render(
        sample('NPR', { ...NO_WORDING, termsAndConditions: 'Line one\nLine <b>two</b> & more' }),
      );
      expect(html).toContain('<p>Line one<br>Line &lt;b&gt;two&lt;/b&gt; &amp; more</p>');
      expect(html).not.toContain('<b>');
      expect(html).not.toContain('<br>Line <b');
    });

    it('prints no section for an empty field', () => {
      for (const empty of [null, '', '   ', '<p></p>', '<p><script>alert(1)</script></p>']) {
        const html = render(sample('NPR', { ...NO_WORDING, termsAndConditions: empty }));
        expect(html, String(empty)).not.toContain('Terms and conditions');
        expect(html, String(empty)).not.toContain('class="rich"');
      }
    });

    it('keeps the signatory in one unbreakable box with the last wording section', () => {
      const html = render(sample('NPR', { ...NO_WORDING, termsAndConditions: RICH }));
      const keep = html.slice(html.indexOf('<div class="sign-keep">'));
      expect(keep.indexOf('<h2>Terms and conditions</h2>')).toBeGreaterThan(-1);
      expect(keep.indexOf('<h2>Terms and conditions</h2>')).toBeLessThan(
        keep.indexOf('<section class="sign">'),
      );
      const css = cssOf(html);
      expect(css).toMatch(/\.sign-keep \{ break-inside: avoid; \}/);
      expect(css).toMatch(/\.rich li \{[^}]*break-inside: avoid;/);
      expect(css).toMatch(/\.rich li \{[^}]*orphans: 2; widows: 2;/);
    });
  });

  it('prints the amount in words in both number systems', () => {
    const view = sample('NPR');
    const lakh = render(view);
    expect(lakh).toContain('Amount in words:');
    expect(lakh).toContain('Forty Lakh Sixty Eight Thousand Rupees Only');
    expect(lakh).toContain(amountInWords('4068000.00', 'NPR', 'south_asian'));
    const intl = render(view, { numberSystem: 'international' });
    expect(intl).toContain(amountInWords('4068000.00', 'NPR', 'international'));
    expect(intl).toContain('Four Million Sixty Eight Thousand Rupees Only');
  });

  it('prints the footer contacts, the signatory and the wordmark', () => {
    const html = render();
    const foot = withoutWbr(html.match(/<footer class="foot">([\s\S]*?)<\/footer>/)?.[1] ?? '');
    for (const text of [
      '+977 1-4000000',
      '+977 9800000000',
      'hello@techrida.example',
      'techrida.example',
      'PAN/VAT No. 609876543',
      '1 Durbar Marg',
    ]) {
      expect(foot, text).toContain(text);
    }
    expect(html).toContain('Amanda Vance');
    expect(html).toContain('Director');
    expect(html).toContain('<span class="wordmark">Techrida</span>');
  });

  // FX9: the customer's address prints as line, city, country; the country is left out when it is the issuing
  // entity's own (the issuer's country, not a fixed one). The issuer's own address keeps its country.
  describe('the customer address', () => {
    const pokhara = { line: 'Lakeside', city: 'Pokhara' };
    const mumbai = { line: 'Bandra West', city: 'Mumbai' };
    const withParties = (issuerCountry: 'NP' | 'IN', customer: CustomerQuotationView['customer']) =>
      withoutWbr(
        render(
          sample('NPR', {
            issuer: { ...sample('NPR').issuer, country: issuerCountry },
            customer,
          }),
        ),
      );
    const customer = (country: 'NP' | 'IN', a: { line: string; city: string }) => ({
      ...sample('NPR').customer,
      country,
      address: a,
    });

    it('prints line and city without the country for a customer in the entity own country', () => {
      const html = withParties('NP', customer('NP', pokhara));
      expect(html).toContain('<div>Lakeside</div><div>Pokhara</div>');
      expect(html).not.toContain('<div>Pokhara</div><div>');
    });

    it('prints the country name for a foreign customer', () => {
      const html = withParties('NP', customer('IN', mumbai));
      expect(html).toContain('<div>Bandra West</div><div>Mumbai</div><div>India</div>');
    });

    it('measures "foreign" from the issuing entity country', () => {
      expect(withParties('IN', customer('NP', pokhara))).toContain(
        '<div>Lakeside</div><div>Pokhara</div><div>Nepal</div>',
      );
      const domestic = withParties('IN', customer('IN', mumbai));
      expect(domestic).toContain('<div>Bandra West</div><div>Mumbai</div>');
      expect(domestic).not.toContain('<div>Mumbai</div><div>');
    });

    it('keeps the country in the issuer address', () => {
      const html = withParties('NP', customer('NP', pokhara));
      const foot = html.match(/<footer class="foot">([\s\S]*?)<\/footer>/)?.[1] ?? '';
      expect(foot).toContain('1 Durbar Marg, Kathmandu, Nepal');
    });
  });

  it('breaks an email or website only after @ or before a dot or hyphen, never inside a word', () => {
    const view = sample('NPR', {
      contact: { fullName: 'Sita Rai', email: 'accounts@himalayanbuild.example' },
    });
    const html = render(view, {
      profile: {
        ...PROFILE,
        email: 'accounts@himalayanbuild.example',
        website: 'www.acme-systems.example',
      },
    });
    const foot = html.match(/<footer class="foot">([\s\S]*?)<\/footer>/)?.[1] ?? '';
    expect(foot).toContain('accounts@<wbr>himalayanbuild<wbr>.example');
    expect(foot).toContain('www<wbr>.acme<wbr>-systems<wbr>.example');
    // The customer's contact email gets the same treatment.
    expect(html.replace(/<footer[\s\S]*?<\/footer>/, '')).toContain(
      'accounts@<wbr>himalayanbuild<wbr>.example',
    );
    // Splitting inside a word is left to `break-word` (a last resort), never `anywhere`, on the footer and emails.
    const css = cssOf(html);
    expect(css).toMatch(/\.party \.email, \.foot \{ overflow-wrap: break-word; \}/);
    const anywhereSelectors = [...css.matchAll(/([^{}]+)\{\s*overflow-wrap:\s*anywhere;/g)].map(
      (m) => m[1]!,
    );
    expect(anywhereSelectors.join(' ')).not.toMatch(/\.foot\b/);
  });

  it('falls back to the entity PAN and the legal name when the profile is empty', () => {
    const html = render(sample('NPR'), { profile: EMPTY_SNAPSHOT_COMPANY_PROFILE });
    expect(html).toContain('PAN/VAT No. 301234567');
    expect(html).toContain('<span class="wordmark">Techrida Pvt. Ltd.</span>');
    expect(html).toContain('Authorised signatory');
  });

  it('prints a valid logo as a data URL and omits the image when there is none', () => {
    const withLogo = render(sample('NPR'), { profile: { ...PROFILE, logoDataUrl: LOGO } });
    expect(withLogo).toContain(`<img src="${LOGO}"`);
    expect(withLogo).toContain('img-src data:');
    expect(withLogo.match(/\bsrc="([^"]*)"/g)).toEqual([`src="${LOGO}"`]);
    expect(withLogo).not.toContain('class="wordmark"');
    const without = render();
    expect(without).not.toMatch(/<img\b/);
    expect(without).not.toContain('img-src');
  });

  it('prints the logo of a snapshot stored before logos became documents (U12), read back through the schema', () => {
    const stored: unknown = JSON.parse(
      JSON.stringify(snapshot('banded', '#1d4ed8', { profile: { ...PROFILE, logoDataUrl: LOGO } })),
    );
    const parsed = DocumentStyleSnapshotSchema.parse(stored);
    const html = renderQuotationHtml(sample('NPR'), { snapshot: parsed });
    expect(html).toContain(`<img src="${LOGO}"`);
  });

  it('drops a logo that is not a schema-valid data URL', () => {
    const html = render(sample('NPR'), {
      profile: { ...PROFILE, logoDataUrl: 'javascript:alert(1)//data:image/png;base64,AA==' },
    });
    expect(html).not.toMatch(/<img\b/);
  });

  it('escapes hostile text in the description, customer and profile', () => {
    const evil = `<script>alert("x")</script>'"`;
    const html = render(
      sample('NPR', {
        customer: {
          legalName: evil,
          panVatNo: null,
          country: 'NP',
          address: { ...address, line: evil },
        },
        contact: { fullName: evil, email: null },
        lines: [
          {
            lineNo: 1,
            description: evil,
            uom: 'pcs',
            quantity: '1',
            unitPrice: '1.00',
            amount: '1.00',
          },
        ],
      }),
      {
        profile: {
          ...PROFILE,
          logoDataUrl: LOGO,
          displayName: evil,
          phones: [evil],
          website: evil,
          signatoryName: evil,
          signatoryTitle: evil,
        },
      },
    );
    expect(html).not.toMatch(/<script\b/i);
    expect(html).toContain('alt="&lt;script&gt;alert(&quot;x&quot;)');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&#39;&quot;');
  });

  it('prints nothing internal and fetches nothing', () => {
    const html = render(sample('NPR'), { profile: { ...PROFILE, logoDataUrl: LOGO } });
    expect(forbiddenIn(html)).toEqual([]);
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toMatch(/url\(\s*['"]?http/i);
    expect(html).not.toMatch(/<(script|link|iframe|object|embed)\b/i);
    expect(html).not.toContain('11111111-1111-4111-8111-111111111111');
  });
});
