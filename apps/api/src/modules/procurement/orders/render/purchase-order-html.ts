// Renders a `PurchaseOrderRenderView` as one self-contained HTML page for Gotenberg (Chromium) to print as an A4 PDF
// (P4 unit P3b). Same rules as the quotation and invoice templates: inline CSS only, no external URL, script, image or
// font file, and a CSP that forbids anything else, so a render never reaches the network. The function takes the
// allow-list view and nothing else, so it cannot print an NPR value or a rate. Money goes through `@bos/locale`
// `formatMoney`, so NPR has lakh grouping (`NPR 20,18,180.00`).
//
// The one image allowed is the company logo frozen at render (U12), and only as a data URL that passes the logo schema
// here; the CSP then allows `img-src data:` and nothing more. With no logo the page is exactly as before.
import {
  bsLongOfDay,
  DEFAULT_CUSTOMER_DATE_FORMAT,
  DEFAULT_NUMBER_SYSTEMS,
  formatBsLong,
  formatCustomerDate,
  formatMoney,
  type CustomerDateFormat,
  type NumberSystems,
} from '@bos/locale';

import { documentCsp, printableLogo } from '../../../invoices/render/frozen-logo';
import type { PurchaseOrderRenderView } from './purchase-order-view';

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * The Gregorian date with the Bikram Sambat date beside it, in the one long BS form (`24 Kartik 2083 BS`, U16-Q5), as
 * on the invoice. The issue date's BS form is the one frozen at issue; any other date is converted. Outside the
 * converter's range (BS 2000 to 2090) the Gregorian date shows alone.
 */
function dateCell(
  isoDate: string,
  bsFrozen: string | null,
  dateFormat: CustomerDateFormat,
): string {
  const gregorian = escapeHtml(formatCustomerDate(isoDate, dateFormat));
  const bs = bsFrozen !== null ? formatBsLong(bsFrozen) : bsLongOfDay(isoDate);
  return bs === null ? gregorian : `${gregorian} <span class="bs">(${escapeHtml(bs)})</span>`;
}

const CSS = `
  @page { size: A4; margin: 16mm 14mm 18mm; }
  * { box-sizing: border-box; }
  html { font-size: 10pt; }
  body {
    font-family: 'Noto Sans', 'Noto Sans Devanagari', sans-serif;
    color: #1a1a1a;
    line-height: 1.4;
    margin: 0;
  }
  h1 { font-size: 20pt; margin: 0; letter-spacing: 0.02em; }
  h2 { font-size: 10pt; margin: 14pt 0 4pt; text-transform: uppercase; letter-spacing: 0.06em; color: #444; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16pt; }
  .head .doc { text-align: right; }
  .head .number { font-size: 11pt; font-weight: 600; margin-top: 2pt; }
  .badge { display: inline-block; margin-top: 4pt; padding: 1pt 8pt; border: 1pt solid #666; border-radius: 3pt; font-weight: 600; font-size: 8.5pt; }
  .legal { font-weight: 600; font-size: 11pt; }
  .logo { display: block; max-height: 56px; max-width: 60mm; margin-bottom: 6pt; }
  .muted { color: #555; }
  .addr { white-space: pre-wrap; }
  .parties { display: flex; gap: 24pt; margin-top: 14pt; }
  .parties > div { flex: 1; }
  .meta { width: 100%; border-collapse: collapse; margin-top: 12pt; }
  .meta td { padding: 2pt 0; vertical-align: top; }
  .meta td:first-child { width: 28%; color: #555; }
  .bs { color: #555; font-size: 9pt; }
  table.items { width: 100%; border-collapse: collapse; margin-top: 14pt; }
  table.items thead { display: table-header-group; }
  table.items th { text-align: left; background: #f1f1f1; border-bottom: 1pt solid #888; padding: 4pt 5pt; font-size: 9pt; }
  table.items td { padding: 4pt 5pt; border-bottom: 0.5pt solid #ccc; vertical-align: top; }
  tr { page-break-inside: avoid; }
  .num { text-align: right; white-space: nowrap; }
  .desc { white-space: pre-wrap; }
  .totals { margin-top: 10pt; margin-left: auto; width: 60%; border-collapse: collapse; page-break-inside: avoid; }
  .totals td { padding: 3pt 5pt; }
  .totals tr.grand td { border-top: 1pt solid #333; font-weight: 700; font-size: 11pt; }
  .foot { margin-top: 18pt; font-size: 8.5pt; color: #666; }
`;

/**
 * One party's block: legal name, the address lines (one per line; the street keeps its own line breaks), the phone
 * and the PAN. The buyer has no address or phone here; a vendor without them prints neither.
 */
function partyBlock(
  heading: string,
  p: { legalName: string; panVatNo: string | null; addressLines?: string[]; phone?: string | null },
  text: (v: string) => string,
) {
  const address = (p.addressLines ?? []).map((line) => `<div class="addr">${text(line)}</div>`);
  return `<h2>${heading}</h2>
      <div class="legal">${text(p.legalName)}</div>
      ${address.join('\n      ')}
      ${p.phone ? `<div>Phone ${text(p.phone)}</div>` : ''}
      ${p.panVatNo ? `<div class="muted">PAN ${text(p.panVatNo)}</div>` : ''}`;
}

export interface RenderPurchaseOrderOptions {
  /** The company's `format.number_systems`, by currency. Left out, NPR/INR keep lakh grouping and USD thousands. */
  numberSystems?: NumberSystems;
  /** The company's `format.date`. Left out, the default `19 Nov 2026`. */
  dateFormat?: CustomerDateFormat;
  /** The logo frozen at render. Printed only when it is a valid logo data URL; otherwise the text header alone. */
  logoDataUrl?: string | null;
}

/** Returns the full HTML document for one issued version of a purchase order. Every text is escaped. */
export function renderPurchaseOrderHtml(
  view: PurchaseOrderRenderView,
  opts: RenderPurchaseOrderOptions = {},
): string {
  const dateFormat = opts.dateFormat ?? DEFAULT_CUSTOMER_DATE_FORMAT;
  const fmt = (amount: string): string =>
    escapeHtml(
      formatMoney(amount, view.currency, {
        numberSystems: opts.numberSystems ?? DEFAULT_NUMBER_SYSTEMS,
      }),
    );
  const text = (value: string): string => escapeHtml(value);
  const logo = printableLogo(opts.logoDataUrl);
  // The logo sits top-left above the buyer's name; the alt text is that name, as the version prints it.
  const logoImg = logo
    ? `\n      <img class="logo" src="${escapeHtml(logo)}" alt="${text(view.buyer.legalName)}">`
    : '';

  const meta: [string, string][] = [
    ['PO no.', text(view.number)],
    ['Version', String(view.version)],
    ['Issue date', dateCell(view.issueDate, view.issueDateBs, dateFormat)],
    ['Currency', text(view.currency)],
    ['Payment terms', `${view.paymentTermsDays} days`],
  ];
  if (view.advancePercent !== null) meta.push(['Advance', `${text(view.advancePercent)}%`]);
  if (view.requiredBy !== null)
    meta.push(['Delivery required by', dateCell(view.requiredBy, null, dateFormat)]);
  if (view.deliveryLocation !== null) meta.push(['Delivery location', text(view.deliveryLocation)]);

  const rows = view.lines
    .map(
      (l) => `
      <tr>
        <td>${l.lineNo}</td>
        <td class="desc">${text(l.description)}</td>
        <td>${text(l.uom)}</td>
        <td class="num">${text(l.quantity)}</td>
        <td class="num">${fmt(l.unitPrice)}</td>
        <td>${text(l.taxCode)}</td>
        <td class="num">${fmt(l.amount)}</td>
        <td class="num">${fmt(l.taxAmount)}</td>
      </tr>`,
    )
    .join('');

  const taxRows = view.taxSummary
    .map(
      (t) =>
        `<tr><td>Tax ${text(t.code)} on ${fmt(t.base)}</td><td class="num">${fmt(t.tax)}</td></tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${documentCsp(logo)}">
<title>Purchase Order ${text(view.number)} - version ${view.version}</title>
<style>${CSS}</style>
</head>
<body>
  <div class="head">
    <div>${logoImg}
      <div class="legal">${text(view.buyer.legalName)}</div>
      ${view.buyer.panVatNo ? `<div class="muted">PAN/VAT ${text(view.buyer.panVatNo)}</div>` : ''}
    </div>
    <div class="doc">
      <h1>Purchase Order</h1>
      <div class="number">${text(view.number)}</div>
      <div class="badge">Version ${view.version}</div>
    </div>
  </div>

  <div class="parties">
    <div>${partyBlock('Vendor', view.vendor, text)}</div>
    <div>${partyBlock('Buyer', view.buyer, text)}</div>
  </div>

  <table class="meta">
    ${meta.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}
  </table>

  <table class="items">
    <thead>
      <tr>
        <th>#</th><th>Description</th><th>Unit</th>
        <th class="num">Qty</th><th class="num">Unit price</th><th>Tax code</th>
        <th class="num">Amount</th><th class="num">Tax</th>
      </tr>
    </thead>
    <tbody>${rows}
    </tbody>
  </table>

  <table class="totals">
    <tr><td>Subtotal</td><td class="num">${fmt(view.totals.subtotal)}</td></tr>
    ${taxRows}
    <tr class="grand"><td>Total</td><td class="num">${fmt(view.totals.total)}</td></tr>
  </table>

  <div class="foot">Purchase Order ${text(view.number)} &middot; version ${view.version} &middot; ${text(view.buyer.legalName)}</div>
</body>
</html>
`;
}
