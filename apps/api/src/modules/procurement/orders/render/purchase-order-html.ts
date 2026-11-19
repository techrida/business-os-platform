// Renders a `PurchaseOrderRenderView` as one self-contained HTML page for Gotenberg (Chromium) to print as an A4 PDF
// (P4 unit P3b). Same rules as the quotation and invoice templates: inline CSS only, no external URL, script, image or
// font file, and a CSP that forbids anything else, so a render never reaches the network. The function takes the
// allow-list view and nothing else, so it cannot print an NPR value or a rate. Money goes through `@bos/locale`
// `formatMoney`, so NPR has lakh grouping (`NPR 20,18,180.00`).
import { formatCustomerDate, formatMoney, toBs } from '@bos/locale';

import type { PurchaseOrderRenderView } from './purchase-order-view';

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Noon in Kathmandu (UTC+05:45) on the calendar day, so no timezone shifts the day. */
const kathmanduNoon = (isoDate: string): Date => new Date(`${isoDate}T12:00:00+05:45`);

/** The Gregorian date with the Bikram Sambat date beside it (the given one, or converted when none is given). */
function dateCell(isoDate: string, bs: string | null): string {
  const gregorian = escapeHtml(formatCustomerDate(isoDate));
  if (bs !== null) return `${gregorian} <span class="bs">(${escapeHtml(bs)} BS)</span>`;
  try {
    const converted = toBs(kathmanduNoon(isoDate));
    const text = `${String(converted.day).padStart(2, '0')} ${converted.monthNameEn} ${converted.year} BS`;
    return `${gregorian} <span class="bs">(${escapeHtml(text)})</span>`;
  } catch (error) {
    // Outside the converter's range (BS 2000 to 2090): show the Gregorian date alone.
    if (error instanceof RangeError) return gregorian;
    throw error;
  }
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
  .muted { color: #555; }
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

/** One party's block: legal name and PAN. */
function partyBlock(
  heading: string,
  p: PurchaseOrderRenderView['vendor'],
  text: (v: string) => string,
) {
  return `<h2>${heading}</h2>
      <div class="legal">${text(p.legalName)}</div>
      ${p.panVatNo ? `<div class="muted">PAN ${text(p.panVatNo)}</div>` : ''}`;
}

/** Returns the full HTML document for one issued version of a purchase order. Every text is escaped. */
export function renderPurchaseOrderHtml(view: PurchaseOrderRenderView): string {
  const fmt = (amount: string): string => escapeHtml(formatMoney(amount, view.currency));
  const text = (value: string): string => escapeHtml(value);

  const meta: [string, string][] = [
    ['PO no.', text(view.number)],
    ['Version', String(view.version)],
    ['Issue date', dateCell(view.issueDate, view.issueDateBs)],
    ['Currency', text(view.currency)],
    ['Payment terms', `${view.paymentTermsDays} days`],
  ];
  if (view.advancePercent !== null) meta.push(['Advance', `${text(view.advancePercent)}%`]);
  if (view.requiredBy !== null)
    meta.push(['Delivery required by', dateCell(view.requiredBy, null)]);
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Purchase Order ${text(view.number)} - version ${view.version}</title>
<style>${CSS}</style>
</head>
<body>
  <div class="head">
    <div>
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
