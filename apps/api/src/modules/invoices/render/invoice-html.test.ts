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
    const south = renderInvoiceHtml(sample(), {
      numberSystems: { NPR: 'south_asian', INR: 'south_asian', USD: 'south_asian' },
    });
    expect(south).toContain('NPR 20,18,180.00');
    expect(south).not.toContain('2,018,180');

    const intl = renderInvoiceHtml(sample(), {
      numberSystems: { NPR: 'international', INR: 'international', USD: 'international' },
    });
    expect(intl).toContain('NPR 2,018,180.00');
    expect(intl).toContain('NPR 1,880,000.00');
    expect(intl).toContain('NPR 232,180.00');
    expect(intl).toContain('VAT 13% (13%) on NPR 1,786,000.00');
    expect(intl).not.toContain('20,18,180');
  });

  it('applies the number system to a foreign currency too', () => {
    const usd = sample({ currency: 'USD' });
    expect(
      renderInvoiceHtml(usd, {
        numberSystems: { NPR: 'south_asian', INR: 'south_asian', USD: 'south_asian' },
      }),
    ).toContain('USD 20,18,180.00');
    expect(
      renderInvoiceHtml(usd, {
        numberSystems: { NPR: 'international', INR: 'international', USD: 'international' },
      }),
    ).toContain('USD 2,018,180.00');
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
    expect(html).toContain('(24 Kartik 2083 BS)');
    expect(html).not.toContain('2083-07-24');
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

  it('labels the number and the party by document kind, so a note never says "Invoice"', () => {
    const tax = renderInvoiceHtml(sample({ kind: 'tax_invoice' }));
    const credit = renderInvoiceHtml(sample({ kind: 'credit_note', number: 'CN-2083/84-00001' }));
    const debit = renderInvoiceHtml(sample({ kind: 'debit_note', number: 'DN-2083/84-00001' }));
    expect(tax).toContain('Invoice to');
    expect(tax).toContain('Invoice no.');
    for (const [html, number] of [
      [credit, 'Credit note no.'],
      [debit, 'Debit note no.'],
    ] as const) {
      expect(html).toContain('Issued to');
      expect(html).toContain(number);
      expect(html).not.toContain('Invoice to');
      expect(html).not.toContain('Invoice no.');
    }
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

  describe('the company logo', () => {
    const PNG = 'data:image/png;base64,iVBORw0KGgo=';
    const CSP_NO_IMAGES = `content="default-src 'none'; style-src 'unsafe-inline'"`;

    it('draws the frozen logo top-left of the header, named after the seller, and allows only data images', () => {
      const html = renderInvoiceHtml(sample(), { logoDataUrl: PNG });
      expect(html).toContain(
        `<header class="head">\n    <div class="identity"><img class="logo" src="${PNG}" alt="Techrida Pvt. Ltd."><div class="brand legal">Techrida Pvt. Ltd.</div></div>`,
      );
      expect(html).toContain(
        `content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"`,
      );
      expect(html).toMatch(/\.logo \{[^}]*max-height: 56px/);
      expect(html.match(/<img /g)).toHaveLength(1);
    });

    it('keeps the text header and the no-image CSP when there is no logo', () => {
      const plain = renderInvoiceHtml(sample());
      expect(renderInvoiceHtml(sample(), { logoDataUrl: null })).toBe(plain);
      expect(plain).not.toContain('<img');
      expect(plain).toContain(CSP_NO_IMAGES);
      expect(plain).toContain(
        '<header class="head">\n    <div class="brand legal">Techrida Pvt. Ltd.</div>\n    <div class="doc">',
      );
    });

    it.each([
      ['an SVG', 'data:image/svg+xml;base64,PHN2Zz4='],
      ['a URL', 'https://example.com/logo.png'],
      ['markup', 'data:image/png;base64,AAAA" onerror="alert(1)'],
    ])('never inlines %s: it prints as if there were no logo', (_name, logoDataUrl) => {
      const html = renderInvoiceHtml(sample(), { logoDataUrl });
      expect(html).toBe(renderInvoiceHtml(sample()));
      expect(html).not.toContain('<img');
    });
  });
});

describe('renderInvoiceHtml: words, signatory and contact (U16-Q4)', () => {
  const contact = {
    phones: ['+97714000000'],
    email: 'billing@techrida.example',
    signatoryName: 'Sita <Sharma>',
    signatoryTitle: 'Finance Manager',
  };

  it('prints an E.164 phone in the Nepal form and a number saved as free text as it was saved', () => {
    const html = renderInvoiceHtml(sample(), {
      sellerContact: { ...contact, phones: ['+9779812345678', '01-4000000'] },
    });
    expect(html).toContain('Phones +977 9812345678, 01-4000000');
  });

  it('spells the total in the number system of the print', () => {
    expect(renderInvoiceHtml(sample())).toContain(
      'Amount in words: Twenty Lakh Eighteen Thousand One Hundred Eighty Rupees Only',
    );
    expect(
      renderInvoiceHtml(sample(), {
        numberSystems: { NPR: 'international', INR: 'international', USD: 'international' },
      }),
    ).toContain('Amount in words: Two Million Eighteen Thousand One Hundred Eighty Rupees Only');
  });

  it('prints the signatory and the contact lines, escaped, in the footer order of the screens', () => {
    const html = renderInvoiceHtml(sample(), { sellerContact: contact });
    expect(html).toContain('<span class="name">Sita &lt;Sharma&gt;</span>');
    expect(html).toContain('<span>Finance Manager</span>');
    const foot = html.slice(html.indexOf('<footer'));
    const order = [
      'Techrida Pvt. Ltd.',
      'Phone +977 1-4000000',
      'Durbar Marg 1',
      'Email billing@',
      'PAN/VAT 301234567',
    ];
    const at = order.map((t) => foot.indexOf(t));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('keeps the signatory label, with no name, phone or email, when there is no contact', () => {
    const html = renderInvoiceHtml(sample());
    expect(html).toContain('Authorised signatory');
    expect(html).not.toContain('class="name"');
    expect(html).not.toContain('Email ');
    expect(html).not.toContain('Phone ');
  });
});
