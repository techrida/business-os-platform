// Renders an `InvoiceRenderView` as one self-contained HTML page for Gotenberg (Chromium) to print as an A4 PDF
// (P3 unit U11). Same rules as the quotation template: inline CSS only, no external URL, script, image or font file, and
// a CSP that forbids anything else, so a render never reaches the network. The function takes the whitelist view and
// nothing else, so it cannot print an NPR value or a rate. Money goes through `@bos/locale` `formatMoney`, so NPR has
// lakh grouping (`NPR 20,18,180.00`).
//
// A tax invoice says "Tax Invoice". A proforma says "Proforma Invoice" and that it is not a tax invoice. A reprint
// says "Copy of original (n)" beside the title.
import { Dec, formatKathmandu, formatMoney, toBs } from '@bos/locale';

import type { InvoiceRenderView } from './invoice-view';

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Noon in Kathmandu (UTC+05:45) on the calendar day, so no timezone shifts the day. */
const kathmanduNoon = (isoDate: string): Date => new Date(`${isoDate}T12:00:00+05:45`);

/** The Gregorian date with the Bikram Sambat date beside it. The issue date's BS form is the one frozen at issue. */
function dateCell(isoDate: string, bsFrozen: string | null): string {
  const gregorian = escapeHtml(formatKathmandu(kathmanduNoon(isoDate), 'date'));
  if (bsFrozen !== null) {
    return `${gregorian} <span class="bs">(${escapeHtml(bsFrozen)} BS)</span>`;
  }
  try {
    const bs = toBs(kathmanduNoon(isoDate));
    const text = `${String(bs.day).padStart(2, '0')} ${bs.monthNameEn} ${bs.year} BS`;
    return `${gregorian} <span class="bs">(${escapeHtml(text)})</span>`;
  } catch (error) {
    // Outside the converter's range (BS 2000 to 2090): show the Gregorian date alone.
    if (error instanceof RangeError) return gregorian;
    throw error;
  }
}

const TITLES: Record<InvoiceRenderView['kind'], string> = {
  tax_invoice: 'Tax Invoice',
  proforma: 'Proforma Invoice',
  credit_note: 'Credit Note',
  debit_note: 'Debit Note',
};

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
  .notice { margin-top: 10pt; padding: 4pt 8pt; border: 1pt solid #999; background: #f7f7f7; font-weight: 600; }
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

/** One party's block: legal name, PAN/VAT number and the address line frozen at issue. */
function partyBlock(heading: string, p: InvoiceRenderView['seller'], text: (v: string) => string) {
  return `<h2>${heading}</h2>
      <div class="legal">${text(p.legalName)}</div>
      ${p.panVatNo ? `<div class="muted">PAN/VAT ${text(p.panVatNo)}</div>` : ''}
      ${p.address ? `<div>${text(p.address)}</div>` : ''}`;
}

/** Returns the full HTML document for an issued invoice. Every text is escaped. */
export function renderInvoiceHtml(view: InvoiceRenderView): string {
  const fmt = (amount: string): string => escapeHtml(formatMoney(amount, view.currency));
  const text = (value: string): string => escapeHtml(value);
  const title = TITLES[view.kind];
  const copy = view.copyNo === null ? '' : `Copy of original (${view.copyNo})`;
  const nonZero = (amount: string): boolean => !new Dec(amount).isZero();

  const meta: [string, string][] = [
    ['Invoice no.', text(view.number)],
    ['Issue date', dateCell(view.issueDate, view.issueDateBs)],
  ];
  if (view.dueDate !== null) meta.push(['Due date', dateCell(view.dueDate, null)]);
  meta.push(['Currency', text(view.currency)]);

  const rows = view.lines
    .map(
      (l) => `
      <tr>
        <td>${l.lineNo}</td>
        <td class="desc">${text(l.description)}</td>
        <td>${text(l.uom)}</td>
        <td class="num">${text(l.quantity)}</td>
        <td class="num">${fmt(l.unitPrice)}</td>
        <td class="num">${fmt(l.amount)}</td>
      </tr>`,
    )
    .join('');

  // VAT by tax code: one row per code, on its own base, so an exempt or zero-rated code shows too.
  const taxRows = view.taxSummary
    .map(
      (t) =>
        `<tr><td>${text(t.label)} (${text(t.percent)}%) on ${fmt(t.base)}</td><td class="num">${fmt(t.tax)}</td></tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${title} ${text(view.number)}${copy ? ` - ${copy}` : ''}</title>
<style>${CSS}</style>
</head>
<body>
  <div class="head">
    <div>
      <div class="legal">${text(view.seller.legalName)}</div>
      ${view.seller.panVatNo ? `<div class="muted">PAN/VAT ${text(view.seller.panVatNo)}</div>` : ''}
      ${view.seller.address ? `<div>${text(view.seller.address)}</div>` : ''}
    </div>
    <div class="doc">
      <h1>${title}</h1>
      <div class="number">${text(view.number)}</div>
      ${copy ? `<div class="badge">${copy}</div>` : ''}
    </div>
  </div>
  ${view.kind === 'proforma' ? '<div class="notice">Proforma Invoice - not a tax invoice. No payment is due on this document alone.</div>' : ''}

  <div class="parties">
    <div>${partyBlock('Billed to', view.buyer, text)}</div>
    <div>${partyBlock('Seller', view.seller, text)}</div>
  </div>

  <table class="meta">
    ${meta.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}
  </table>

  <table class="items">
    <thead>
      <tr>
        <th>#</th><th>Description</th><th>Unit</th>
        <th class="num">Qty</th><th class="num">Unit price</th><th class="num">Amount</th>
      </tr>
    </thead>
    <tbody>${rows}
    </tbody>
  </table>

  <table class="totals">
    <tr><td>Subtotal</td><td class="num">${fmt(view.totals.subtotal)}</td></tr>
    ${nonZero(view.totals.discountAmount) ? `<tr><td>Discount</td><td class="num">- ${fmt(view.totals.discountAmount)}</td></tr>` : ''}
    <tr><td>Taxable amount</td><td class="num">${fmt(view.totals.taxableAmount)}</td></tr>
    ${nonZero(view.totals.exemptAmount) ? `<tr><td>Exempt amount</td><td class="num">${fmt(view.totals.exemptAmount)}</td></tr>` : ''}
    ${nonZero(view.totals.zeroRatedAmount) ? `<tr><td>Zero-rated amount</td><td class="num">${fmt(view.totals.zeroRatedAmount)}</td></tr>` : ''}
    ${taxRows}
    <tr class="grand"><td>Total</td><td class="num">${fmt(view.totals.total)}</td></tr>
  </table>

  <div class="foot">${title} ${text(view.number)} &middot; ${text(view.seller.legalName)}${copy ? ` &middot; ${copy}` : ''}</div>
</body>
</html>
`;
}
