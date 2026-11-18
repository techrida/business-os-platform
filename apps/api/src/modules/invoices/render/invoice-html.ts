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
  @page { size: A4; margin: 14mm 13mm 16mm; }
  :root { color-scheme: light; --brand: #2563eb; --ink: #0f172a; --muted: #475569; --line: #e2e8f0; }
  * { box-sizing: border-box; }
  body {
    font: 9pt/1.5 'Noto Sans', 'Noto Sans Devanagari', sans-serif;
    color: var(--ink);
    margin: 0;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
    overflow-wrap: anywhere;
  }
  h1, h2, p { margin: 0; }
  h1 { color: var(--brand); font-size: 22pt; text-transform: uppercase; letter-spacing: 0.045em; }
  h2 { font-size: 8pt; text-transform: uppercase; letter-spacing: 0.04em; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 18pt; }
  .doc { text-align: right; }
  .brand { max-width: 42%; padding: 14pt 16pt; background: var(--brand); color: #fff; }
  .badge { display: inline-block; margin-top: 4pt; padding: 1pt 8pt; border: 1pt solid var(--line); font-weight: 600; }
  .legal { font-weight: 700; font-size: 11pt; }
  .muted { color: var(--muted); }
  .notice { margin-top: 10pt; padding: 6pt 8pt; background: #eff6ff; font-weight: 600; }
  .billing { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 28pt; margin-top: 24pt; break-inside: avoid; }
  .billing h2 { margin-bottom: 4pt; }
  .meta { width: 100%; border-collapse: collapse; }
  .meta th, .meta td { padding: 1.5pt 0; vertical-align: top; }
  .meta th { padding-right: 8pt; color: var(--muted); text-align: left; font-weight: 400; white-space: nowrap; }
  .bs { color: var(--muted); font-size: 8pt; }
  .items { width: 100%; border-collapse: collapse; margin-top: 20pt; }
  .items thead { display: table-header-group; }
  .items th { padding: 6pt 5pt; background: var(--brand); color: #fff; text-align: left; font-size: 7.5pt; text-transform: uppercase; }
  .items td { padding: 6pt 5pt; vertical-align: top; }
  .items tbody tr:nth-child(even) { background: #f1f5f9; }
  tr { break-inside: avoid; }
  .items .num, .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .desc { white-space: pre-wrap; max-width: 65mm; }
  .balance { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 3fr); gap: 28pt; margin-top: 18pt; }
  .balance > div { break-inside: avoid; }
  .balance .amount { font-size: 14pt; font-weight: 700; }
  .balance .due { font-size: 8pt; color: var(--muted); }
  .totals { width: 100%; border-collapse: collapse; }
  .totals td { padding: 4pt 6pt; border-bottom: .5pt solid var(--line); }
  .totals .grand td { padding-block: 8pt; background: var(--brand); color: #fff; font-weight: 700; font-size: 10pt; }
  .foot {
    margin-top: 26pt;
    padding: 8pt 0;
    display: flex;
    flex-wrap: wrap;
    gap: 2pt 12pt;
    justify-content: space-between;
    border-top: .5pt solid var(--line);
    border-bottom: 5pt solid var(--brand);
    font-size: 8pt;
    color: var(--muted);
    break-inside: avoid;
  }
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
  <header class="head">
    <div class="brand legal">${text(view.seller.legalName)}</div>
    <div class="doc">
      <h1>${title}</h1>
      ${copy ? `<div class="badge">${copy}</div>` : ''}
    </div>
  </header>
  ${view.kind === 'proforma' ? '<p class="notice">Proforma Invoice - not a tax invoice.</p>' : ''}

  <div class="billing">
    <section>${partyBlock('Invoice to', view.buyer, text)}</section>
    <table class="meta">
      ${meta.map(([k, v]) => `<tr><th scope="row">${k}</th><td>${v}</td></tr>`).join('')}
    </table>
  </div>

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

  <div class="balance">
    <div>
      <h2>${title} total</h2>
      <p class="amount">${fmt(view.totals.total)}</p>
      ${view.dueDate !== null ? `<p class="due">Due ${dateCell(view.dueDate, null)}</p>` : ''}
    </div>
    <table class="totals">
    <tr><td>Subtotal</td><td class="num">${fmt(view.totals.subtotal)}</td></tr>
    ${nonZero(view.totals.discountAmount) ? `<tr><td>Discount</td><td class="num">- ${fmt(view.totals.discountAmount)}</td></tr>` : ''}
    <tr><td>Taxable amount</td><td class="num">${fmt(view.totals.taxableAmount)}</td></tr>
    ${nonZero(view.totals.exemptAmount) ? `<tr><td>Exempt amount</td><td class="num">${fmt(view.totals.exemptAmount)}</td></tr>` : ''}
    ${nonZero(view.totals.zeroRatedAmount) ? `<tr><td>Zero-rated amount</td><td class="num">${fmt(view.totals.zeroRatedAmount)}</td></tr>` : ''}
    ${taxRows}
    <tr class="grand"><td>Total</td><td class="num">${fmt(view.totals.total)}</td></tr>
    </table>
  </div>

  <footer class="foot">
    <span>${text(view.seller.legalName)}</span>
    ${view.seller.address ? `<span>${text(view.seller.address)}</span>` : ''}
    ${view.seller.panVatNo ? `<span>PAN/VAT ${text(view.seller.panVatNo)}</span>` : ''}
  </footer>
</body>
</html>
`;
}
