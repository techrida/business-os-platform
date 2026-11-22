import { describe, expect, it } from 'vitest';

import { renderPurchaseOrderHtml } from './purchase-order-html';
import { PurchaseOrderRenderViewSchema, type PurchaseOrderRenderView } from './purchase-order-view';

const sample = (over: Partial<PurchaseOrderRenderView> = {}): PurchaseOrderRenderView =>
  PurchaseOrderRenderViewSchema.parse({
    number: 'PO-2083/84-00007',
    version: 1,
    issueDate: '2026-11-09',
    issueDateBs: '2083-07-24',
    currency: 'NPR',
    buyer: { legalName: 'Techrida Pvt. Ltd.', panVatNo: '301234567' },
    vendor: {
      legalName: 'Himal Solar Pvt. Ltd.',
      panVatNo: '600123456',
      addressLines: ['Baneshwor-10', 'Kathmandu'],
      phone: '+977 1-4123456',
    },
    paymentTermsDays: 30,
    advancePercent: '25',
    requiredBy: '2026-12-01',
    deliveryLocation: 'Teku warehouse',
    lines: [
      {
        lineNo: 1,
        description: 'Solar panel',
        uom: 'pcs',
        quantity: '12.5',
        unitPrice: '150400.00',
        taxCode: 'VAT13',
        amount: '1880000.00',
        taxAmount: '244400.00',
      },
    ],
    totals: { subtotal: '1880000.00', taxAmount: '244400.00', total: '2124400.00' },
    taxSummary: [{ code: 'VAT13', base: '1880000.00', tax: '244400.00' }],
    ...over,
  });

describe('renderPurchaseOrderHtml', () => {
  it('prints money with lakh grouping: NPR 21,24,400.00, never western grouping', () => {
    const html = renderPurchaseOrderHtml(sample());
    expect(html).toContain('NPR 21,24,400.00');
    expect(html).toContain('NPR 18,80,000.00');
    expect(html).toContain('NPR 2,44,400.00');
    expect(html).toContain('NPR 1,50,400.00');
    expect(html).not.toContain('2,124,400');
    expect(html).not.toContain('1,880,000');
  });

  it('groups digits by the number system: lakh for south_asian, million for international', () => {
    const south = renderPurchaseOrderHtml(sample(), {
      numberSystems: { NPR: 'south_asian', INR: 'south_asian', USD: 'south_asian' },
    });
    expect(south).toContain('NPR 21,24,400.00');
    expect(south).not.toContain('2,124,400');

    const intl = renderPurchaseOrderHtml(sample(), {
      numberSystems: { NPR: 'international', INR: 'international', USD: 'international' },
    });
    expect(intl).toContain('NPR 2,124,400.00');
    expect(intl).toContain('NPR 1,880,000.00');
    expect(intl).toContain('NPR 244,400.00');
    expect(intl).toContain('NPR 150,400.00');
    expect(intl).not.toContain('21,24,400');
  });

  it('applies the number system to a foreign currency too', () => {
    const usd = sample({ currency: 'USD' });
    expect(
      renderPurchaseOrderHtml(usd, {
        numberSystems: { NPR: 'south_asian', INR: 'south_asian', USD: 'south_asian' },
      }),
    ).toContain('USD 21,24,400.00');
    expect(
      renderPurchaseOrderHtml(usd, {
        numberSystems: { NPR: 'international', INR: 'international', USD: 'international' },
      }),
    ).toContain('USD 2,124,400.00');
    // Left out, the currency keeps its own style.
    expect(renderPurchaseOrderHtml(usd)).toContain('USD 2,124,400.00');
  });

  it('is titled Purchase Order with the number, version, both calendars and the parties', () => {
    const html = renderPurchaseOrderHtml(sample());
    expect(html).toContain('<h1>Purchase Order</h1>');
    expect(html).toContain('PO-2083/84-00007');
    expect(html).toContain('Version 1');
    expect(html).toContain('Techrida Pvt. Ltd.');
    expect(html).toContain('PAN/VAT 301234567');
    expect(html).toContain('Himal Solar Pvt. Ltd.');
    expect(html).toContain('PAN 600123456');
  });

  it('prints the vendor address one line each and its phone, between the name and the PAN', () => {
    const html = renderPurchaseOrderHtml(sample());
    const vendorBlock = html.slice(html.indexOf('<h2>Vendor</h2>'), html.indexOf('<h2>Buyer</h2>'));
    expect(vendorBlock).toContain('<div class="addr">Baneshwor-10</div>');
    expect(vendorBlock).toContain('<div class="addr">Kathmandu</div>');
    expect(vendorBlock).toContain('<div>Phone +977 1-4123456</div>');
    expect(vendorBlock).not.toContain('Nepal');
    const order = ['Himal Solar', 'Baneshwor-10', 'Kathmandu', 'Phone', 'PAN 600123456'].map((t) =>
      vendorBlock.indexOf(t),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // The buyer block prints no address or phone.
    const buyerBlock = html.slice(
      html.indexOf('<h2>Buyer</h2>'),
      html.indexOf('<table class="meta">'),
    );
    expect(buyerBlock).not.toContain('class="addr"');
    expect(buyerBlock).not.toContain('Phone');
  });

  it('prints a foreign vendor with its country line and an international phone', () => {
    const html = renderPurchaseOrderHtml(
      sample({
        vendor: {
          legalName: 'Pacific Inverters Inc.',
          panVatNo: null,
          addressLines: ['1 Market St', 'San Francisco', 'United States'],
          phone: '+1 415 555 2671',
        },
      }),
    );
    expect(html).toContain('<div class="addr">United States</div>');
    expect(html).toContain('<div>Phone +1 415 555 2671</div>');
  });

  it('prints no address or phone line for a vendor without them', () => {
    const html = renderPurchaseOrderHtml(
      sample({
        vendor: {
          legalName: 'Himal Solar Pvt. Ltd.',
          panVatNo: null,
          addressLines: [],
          phone: null,
        },
      }),
    );
    expect(html).not.toContain('class="addr"');
    expect(html).not.toContain('Phone');
  });

  it('prints the frozen BS issue date and the converted delivery date in the one long BS form', () => {
    const html = renderPurchaseOrderHtml(sample());
    expect(html).toContain('<span class="bs">(24 Kartik 2083 BS)</span>');
    expect(html).not.toContain('2083-07-24');
    // The delivery date has no frozen BS form, so it is converted (01 Dec 2026 is 15 Mangsir 2083).
    expect(html).toContain('<span class="bs">(15 Mangsir 2083 BS)</span>');
  });

  it('shows the payment and delivery terms when present', () => {
    const html = renderPurchaseOrderHtml(sample());
    expect(html).toContain('30 days');
    expect(html).toContain('25%');
    expect(html).toContain('Delivery required by');
    expect(html).toContain('Teku warehouse');
  });

  it('leaves out the advance and delivery rows when there are none', () => {
    const html = renderPurchaseOrderHtml(
      sample({ advancePercent: null, requiredBy: null, deliveryLocation: null }),
    );
    expect(html).not.toContain('Advance');
    expect(html).not.toContain('Delivery required by');
    expect(html).not.toContain('Delivery location');
  });

  it('prints each line with its tax code and a tax row per code', () => {
    const html = renderPurchaseOrderHtml(sample());
    expect(html).toContain('<td>VAT13</td>');
    expect(html).toContain('Tax VAT13 on NPR 18,80,000.00');
    expect(html).toContain('<td class="num">12.5</td>');
  });

  it('shows the version of an amendment', () => {
    const html = renderPurchaseOrderHtml(sample({ version: 3 }));
    expect(html).toContain('Version 3');
    expect(html).toContain('version 3');
  });

  it('formats a foreign currency in its own style', () => {
    const html = renderPurchaseOrderHtml(sample({ currency: 'USD' }));
    expect(html).toContain('USD');
    expect(html).not.toContain('NPR');
  });

  it('escapes every text and is self-contained', () => {
    const html = renderPurchaseOrderHtml(
      sample({
        vendor: {
          legalName: '<script>alert(1)</script> & Sons',
          panVatNo: null,
          addressLines: ['<b>Lane</b> & Co', 'Kathmandu'],
          phone: '+977 <i>1</i>',
        },
      }),
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('<i>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; Sons');
    expect(html).toContain('&lt;b&gt;Lane&lt;/b&gt; &amp; Co');
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/https?:\/\//);
  });

  describe('the company logo', () => {
    const PNG = 'data:image/png;base64,iVBORw0KGgo=';

    it('draws the frozen logo top-left of the header, named after the buyer, and allows only data images', () => {
      const html = renderPurchaseOrderHtml(sample(), { logoDataUrl: PNG });
      expect(html).toContain(
        `<div class="head">\n    <div>\n      <img class="logo" src="${PNG}" alt="Techrida Pvt. Ltd.">\n      <div class="legal">Techrida Pvt. Ltd.</div>`,
      );
      expect(html).toContain(
        `content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"`,
      );
      expect(html).toMatch(/\.logo \{[^}]*max-height: 56px/);
      expect(html.match(/<img /g)).toHaveLength(1);
    });

    it('keeps the text header and the no-image CSP when there is no logo', () => {
      const plain = renderPurchaseOrderHtml(sample());
      expect(renderPurchaseOrderHtml(sample(), { logoDataUrl: null })).toBe(plain);
      expect(plain).not.toContain('<img');
      expect(plain).toContain(`content="default-src 'none'; style-src 'unsafe-inline'"`);
      expect(plain).toContain(
        '<div class="head">\n    <div>\n      <div class="legal">Techrida Pvt. Ltd.</div>',
      );
    });

    it.each([
      ['an SVG', 'data:image/svg+xml;base64,PHN2Zz4='],
      ['a URL', 'https://example.com/logo.png'],
      ['markup', 'data:image/png;base64,AAAA" onerror="alert(1)'],
    ])('never inlines %s: it prints as if there were no logo', (_name, logoDataUrl) => {
      const html = renderPurchaseOrderHtml(sample(), { logoDataUrl });
      expect(html).toBe(renderPurchaseOrderHtml(sample()));
      expect(html).not.toContain('<img');
    });
  });
});
