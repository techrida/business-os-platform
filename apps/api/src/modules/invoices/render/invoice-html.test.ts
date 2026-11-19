import { describe, expect, it } from 'vitest';

import { renderInvoiceHtml } from './invoice-html';
import { InvoiceRenderViewSchema, type InvoiceRenderView } from './invoice-view';

const sample = (over: Partial<InvoiceRenderView> = {}): InvoiceRenderView =>
  InvoiceRenderViewSchema.parse({
    kind: 'tax_invoice',
    number: 'INV-2083/84-00001',
    issueDate: '2026-11-09',
    issueDateBs: '2083-07-24',
    dueDate: '2026-12-09',
    currency: 'NPR',
    seller: {
      legalName: 'Techrida Pvt. Ltd.',
      panVatNo: '301234567',
      address: 'Durbar Marg 1, Kathmandu, NP',
    },
    buyer: { legalName: 'Himal Traders Pvt. Ltd.', panVatNo: 'ABC-12345', address: 'Thamel 4' },
    copyNo: null,
    lines: [
      {
        lineNo: 1,
        description: 'Solar panel',
        uom: 'pcs',
        quantity: '12.5',
        unitPrice: '150400.00',
        amount: '1880000.00',
      },
    ],
    totals: {
      subtotal: '1880000.00',
      discountAmount: '94000.00',
      taxableAmount: '1786000.00',
      exemptAmount: '0.00',
      zeroRatedAmount: '0.00',
      taxAmount: '232180.00',
      total: '2018180.00',
    },
    taxSummary: [{ label: 'VAT 13%', percent: '13', base: '1786000.00', tax: '232180.00' }],
    ...over,
  });

describe('renderInvoiceHtml', () => {
  it('prints the golden total with lakh grouping: NPR 20,18,180.00', () => {
    const html = renderInvoiceHtml(sample());
    expect(html).toContain('NPR 20,18,180.00');
    expect(html).toContain('NPR 18,80,000.00');
    expect(html).toContain('NPR 2,32,180.00');
    // Never western grouping.
    expect(html).not.toContain('2,018,180');
  });

  it('groups digits by the number system: lakh for south_asian, million for international', () => {
    const south = renderInvoiceHtml(sample(), { numberSystem: 'south_asian' });
    expect(south).toContain('NPR 20,18,180.00');
    expect(south).not.toContain('2,018,180');

    const intl = renderInvoiceHtml(sample(), { numberSystem: 'international' });
    expect(intl).toContain('NPR 2,018,180.00');
    expect(intl).toContain('NPR 1,880,000.00');
    expect(intl).toContain('NPR 232,180.00');
    expect(intl).toContain('VAT 13% (13%) on NPR 1,786,000.00');
    expect(intl).not.toContain('20,18,180');
  });

  it('applies the number system to a foreign currency too', () => {
    const usd = sample({ currency: 'USD' });
    expect(renderInvoiceHtml(usd, { numberSystem: 'south_asian' })).toContain('USD 20,18,180.00');
    expect(renderInvoiceHtml(usd, { numberSystem: 'international' })).toContain('USD 2,018,180.00');
    // Left out, the currency keeps its own style.
    expect(renderInvoiceHtml(usd)).toContain('USD 2,018,180.00');
  });

  it('is titled Tax Invoice and shows the parties, PAN/VAT, number and both calendars', () => {
    const html = renderInvoiceHtml(sample());
    expect(html).toContain('<h1>Tax Invoice</h1>');
    expect(html).toContain('INV-2083/84-00001');
    expect(html).toContain('PAN/VAT 301234567');
    expect(html).toContain('PAN/VAT ABC-12345');
    expect(html).toContain('Himal Traders Pvt. Ltd.');
    expect(html).toContain('2083-07-24 BS');
    expect(html).toContain('Due date');
    expect(html).toContain('VAT 13% (13%) on NPR 17,86,000.00');
    expect(html).not.toContain('Proforma');
    expect(html).not.toContain('Copy of original');
  });

  it('formats the issue date and both due-date placements with the customer default', () => {
    const html = renderInvoiceHtml(
      sample({
        issueDate: '2026-08-19',
        issueDateBs: '2083-05-03',
        dueDate: '2026-09-19',
      }),
    );
    expect(html).toContain('19 Aug 2026');
    expect(html.match(/19 Sep 2026/g)).toHaveLength(2);
  });

  it('marks a reprint "Copy of original (n)" with n from the view', () => {
    expect(renderInvoiceHtml(sample({ copyNo: 1 }))).toContain('Copy of original (1)');
    expect(renderInvoiceHtml(sample({ copyNo: 3 }))).toContain('Copy of original (3)');
    expect(renderInvoiceHtml(sample({ copyNo: 3 }))).not.toContain('Copy of original (2)');
  });

  it('prints a proforma as "Proforma Invoice", never as a tax invoice', () => {
    const html = renderInvoiceHtml(sample({ kind: 'proforma', number: 'PI-2083/84-00001' }));
    expect(html).toContain('<h1>Proforma Invoice</h1>');
    expect(html).toContain('not a tax invoice');
    expect(html).not.toContain('<h1>Tax Invoice</h1>');
  });

  it('titles credit and debit notes by their kind', () => {
    const credit = renderInvoiceHtml(sample({ kind: 'credit_note', number: 'CN-2083/84-00001' }));
    const debit = renderInvoiceHtml(sample({ kind: 'debit_note', number: 'DN-2083/84-00001' }));
    expect(credit).toContain('<h1>Credit Note</h1>');
    expect(debit).toContain('<h1>Debit Note</h1>');
    expect(credit).toContain('<h2>Credit Note total</h2>');
    expect(credit).not.toContain('Invoice total');
    expect(debit).toContain('<h2>Debit Note total</h2>');
  });

  it('formats a foreign currency in its own style', () => {
    const html = renderInvoiceHtml(sample({ currency: 'USD' }));
    expect(html).toContain('USD');
    expect(html).not.toContain('NPR');
  });

  it('shows the discount and exempt rows only when they are not zero', () => {
    const plain = renderInvoiceHtml(
      sample({
        totals: {
          subtotal: '100.00',
          discountAmount: '0.00',
          taxableAmount: '100.00',
          exemptAmount: '0.00',
          zeroRatedAmount: '0.00',
          taxAmount: '13.00',
          total: '113.00',
        },
      }),
    );
    expect(plain).not.toContain('Discount');
    expect(plain).not.toContain('Exempt amount');
    expect(plain).not.toContain('Zero-rated');
    expect(renderInvoiceHtml(sample())).toContain('Discount');
  });

  it('escapes every text and is self-contained', () => {
    const html = renderInvoiceHtml(
      sample({
        buyer: { legalName: '<script>alert(1)</script> & Sons', panVatNo: null, address: null },
      }),
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; Sons');
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/https?:\/\//);
  });
});
