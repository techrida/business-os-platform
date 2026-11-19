import {
  CUSTOMER_VIEW_FORBIDDEN_WORDS,
  CustomerQuotationViewSchema,
  type CustomerQuotationView,
} from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { renderQuotationHtml } from './quotation-html.js';

const address = {
  line1: '1 Durbar Marg',
  city: 'Kathmandu',
  district: 'Kathmandu',
  postalCode: '44600',
  country: 'NP',
};

const sample = (currency: 'USD' | 'NPR', over: Partial<CustomerQuotationView> = {}) =>
  CustomerQuotationViewSchema.parse({
    id: '11111111-1111-4111-8111-111111111111',
    number: 'QT-2082-0042',
    revisionNo: 2,
    status: 'sent',
    issueDate: '2026-11-08',
    validUntil: '2026-11-23',
    currency,
    issuer: { legalName: 'Techrida Pvt. Ltd.', panVatNo: '301234567', address },
    customer: { legalName: 'Himal Traders Pvt. Ltd.', panVatNo: 'ABC-12345', address },
    contact: { fullName: 'Sita Rai', email: 'sita@himal.example' },
    scope: 'Supply and install 12 panels\nIncludes commissioning',
    assumptions: 'Site access is available',
    exclusions: null,
    deliveryTimeline: '6 weeks',
    paymentTermName: 'Net 30',
    paymentSchedule: [
      { label: 'Advance', percent: '60', dueDescription: 'On order' },
      { label: 'Balance', percent: '40' },
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

/**
 * The NPR currency code is a legitimate word on a quotation, so strip it before the forbidden-word scan. The
 * <style> block goes too: the CSS property `margin` is layout, not content a customer reads.
 */
const withoutCurrencyCode = (html: string) =>
  html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/\bNPR\b/g, '');

const forbiddenIn = (html: string) =>
  CUSTOMER_VIEW_FORBIDDEN_WORDS.filter((w) =>
    new RegExp(`\\b${w}\\b`, 'i').test(withoutCurrencyCode(html)),
  );

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
    expect(html).toContain('http-equiv="Content-Security-Policy"');
  });

  it('shows the parties, the number with its revision, and the dates', () => {
    const html = renderQuotationHtml(sample('USD'));
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
        { label: 'Advance', percent: '33.3333', dueDescription: 'On order' },
        { label: 'Delivery', percent: '33.3333', dueDescription: '2026-11-19' },
        { label: 'Balance', percent: '33.3334', dueDescription: '2026-11-23' },
      ],
    });
    expect(html).toContain('<td>Advance</td><td>33.3333%</td><td class="muted">On order</td>');
    expect(html).toContain('<td>Delivery</td><td>33.3333%</td><td class="muted">19 Nov 2026</td>');
    expect(html).toContain('<td>Balance</td><td>33.3334%</td><td class="muted">23 Nov 2026</td>');
  });

  it('shows the BS date next to the date, and leaves it out on request', () => {
    // Kartik 1, 2083 fell on 18 Oct 2026, so 8 Nov 2026 is 22 Kartik 2083 and 23 Nov is 7 Mangsir.
    const html = renderQuotationHtml(sample('USD'));
    expect(html).toContain('08 Nov 2026 <span class="bs">(22 Kartik 2083 BS)</span>');
    expect(html).toContain('(07 Mangsir 2083 BS)');
    expect(renderQuotationHtml(sample('USD'), { showBsDate: false })).not.toContain('BS');
  });

  it('formats USD with western grouping and NPR with lakh grouping', () => {
    const usd = renderQuotationHtml(sample('USD'));
    expect(usd).toContain('USD 4,068,000.00');
    expect(usd).toContain('USD 45,000.00');
    const npr = renderQuotationHtml(sample('NPR'));
    expect(npr).toContain('NPR 40,68,000.00');
    expect(npr).toContain('NPR 12,50,000.00');
    expect(npr).not.toContain('NPR 4,068,000.00');
  });

  it('shows the VAT line by percent and base, and the discount only when there is one', () => {
    const html = renderQuotationHtml(sample('USD'));
    expect(html).toContain('VAT (13%)');
    expect(html).toContain('USD 468,000.00');
    expect(html).toContain('Discount');
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
    expect(forbiddenIn('<style>td { margin: 0 }</style><td>Margin 5%</td>')).toEqual(['margin']);
  });

  it('escapes markup in every text field', () => {
    const evil = '<b>x</b>';
    const addr = { ...address, line1: evil, city: evil };
    const html = renderQuotationHtml(
      sample('USD', {
        number: 'QT-<b>x</b>',
        issuer: { legalName: evil, panVatNo: '301234567', address: addr },
        customer: { legalName: evil, panVatNo: 'ABC-12345', address: addr },
        contact: { fullName: evil, email: evil },
        scope: evil,
        assumptions: evil,
        exclusions: evil,
        deliveryTimeline: evil,
        paymentTermName: evil,
        paymentSchedule: [{ label: evil, percent: '100', dueDescription: evil }],
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
    expect(html.match(/&lt;b&gt;x&lt;\/b&gt;/g)!.length).toBeGreaterThanOrEqual(18);
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
});
