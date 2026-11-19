// Renders a `CustomerQuotationView` as one self-contained HTML page for Gotenberg (Chromium) to print as an
// A4 PDF. Self-contained on purpose: inline CSS only, no external URL, script, image or font file, and a CSP
// that forbids anything else, so a render never reaches the network. Gotenberg's container supplies the
// Noto fonts. The function takes the whitelist view and nothing else, so it cannot print a cost or a rate.
import { trimPercent, type CustomerQuotationView } from '@bos/contracts';
import { Dec, formatCustomerDate, formatMoney, toBs } from '@bos/locale';

export interface RenderQuotationOptions {
  /** Print the Bikram Sambat date beside each date. Default true. */
  showBsDate?: boolean;
}

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const STATUS_LABELS: Partial<Record<CustomerQuotationView['status'], string>> = {
  accepted: 'Accepted',
  rejected: 'Rejected',
  expired: 'Expired',
  superseded: 'Superseded',
};

/** Noon in Kathmandu (UTC+05:45) on the calendar day, so no timezone shifts the day. */
const kathmanduNoon = (isoDate: string): Date => new Date(`${isoDate}T12:00:00+05:45`);

function dateCell(isoDate: string, showBs: boolean): string {
  const gregorian = escapeHtml(formatCustomerDate(isoDate));
  if (!showBs) return gregorian;
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

const COUNTRY_NAMES: Record<string, string> = { NP: 'Nepal', IN: 'India', US: 'United States' };

function addressLines(a: CustomerQuotationView['issuer']['address']): string {
  const lines = [
    a.line1,
    a.line2,
    [a.city, a.district].filter(Boolean).join(', '),
    [a.province, a.postalCode].filter(Boolean).join(' '),
    COUNTRY_NAMES[a.country] ?? a.country,
  ].filter((l): l is string => Boolean(l));
  return lines.map((l) => `<div>${escapeHtml(l)}</div>`).join('');
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
  .status { display: inline-block; margin-top: 4pt; padding: 1pt 8pt; border: 1pt solid #666; border-radius: 3pt; font-weight: 600; text-transform: uppercase; font-size: 8.5pt; }
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
  .totals { margin-top: 10pt; margin-left: auto; width: 55%; border-collapse: collapse; page-break-inside: avoid; }
  .totals td { padding: 3pt 5pt; }
  .totals tr.grand td { border-top: 1pt solid #333; font-weight: 700; font-size: 11pt; }
  .block { page-break-inside: avoid; }
  .text { white-space: pre-wrap; margin: 0; }
  .schedule { border-collapse: collapse; }
  .schedule td { padding: 2pt 14pt 2pt 0; }
  .foot { margin-top: 18pt; font-size: 8.5pt; color: #666; }
`;

/** Returns the full HTML document for a customer quotation. Every text is escaped. */
export function renderQuotationHtml(
  view: CustomerQuotationView,
  opts: RenderQuotationOptions = {},
): string {
  const showBs = opts.showBsDate !== false;
  const money = (amount: string): string => escapeHtml(formatMoney(amount, view.currency));
  const text = (value: string | null | undefined): string => escapeHtml(value ?? '');

  const statusLabel = STATUS_LABELS[view.status];
  const hasDiscount = !new Dec(view.totals.discountAmount).isZero();

  const meta: [string, string][] = [
    ['Issue date', dateCell(view.issueDate, showBs)],
    ['Valid until', dateCell(view.validUntil, showBs)],
  ];
  if (view.paymentTermName) meta.push(['Payment terms', text(view.paymentTermName)]);

  const textBlock = (heading: string, body: string | null): string =>
    body
      ? `<div class="block"><h2>${heading}</h2><p class="text">${escapeHtml(body)}</p></div>`
      : '';

  const rows = view.lines
    .map(
      (l) => `
      <tr>
        <td>${l.lineNo}</td>
        <td class="desc">${text(l.description)}</td>
        <td>${text(l.uom)}</td>
        <td class="num">${text(l.quantity)}</td>
        <td class="num">${money(l.unitPrice)}</td>
        <td class="num">${money(l.amount)}</td>
      </tr>`,
    )
    .join('');

  const taxRows = view.taxSummary
    .map(
      (t) =>
        `<tr><td>${text(t.label)} (${text(t.percent)}%) on ${money(t.base)}</td><td class="num">${money(t.tax)}</td></tr>`,
    )
    .join('');

  const schedule = view.paymentSchedule.length
    ? `<div class="block"><h2>Payment schedule</h2><table class="schedule">${view.paymentSchedule
        .map(
          (m) =>
            `<tr><td>${text(m.label)}</td><td>${text(trimPercent(m.percent))}%</td><td class="muted">${text(m.dueDescription && formatCustomerDate(m.dueDescription))}</td></tr>`,
        )
        .join('')}</table></div>`
    : '';

  const contact = view.contact
    ? `<div>${text(view.contact.fullName)}</div>${
        view.contact.email ? `<div class="muted">${text(view.contact.email)}</div>` : ''
      }`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${text(view.number)} Rev ${view.revisionNo}</title>
<style>${CSS}</style>
</head>
<body>
  <div class="head">
    <div>
      <div class="legal">${text(view.issuer.legalName)}</div>
      ${view.issuer.panVatNo ? `<div class="muted">PAN/VAT ${text(view.issuer.panVatNo)}</div>` : ''}
      ${addressLines(view.issuer.address)}
    </div>
    <div class="doc">
      <h1>Quotation</h1>
      <div class="number">${text(view.number)} Rev ${view.revisionNo}</div>
      ${statusLabel ? `<div class="status">${statusLabel}</div>` : ''}
    </div>
  </div>

  <div class="parties">
    <div>
      <h2>Prepared for</h2>
      <div class="legal">${text(view.customer.legalName)}</div>
      ${view.customer.panVatNo ? `<div class="muted">PAN/VAT ${text(view.customer.panVatNo)}</div>` : ''}
      ${addressLines(view.customer.address)}
    </div>
    <div>
      ${contact ? `<h2>Attention</h2>${contact}` : ''}
    </div>
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
    <tr><td>Subtotal</td><td class="num">${money(view.totals.subtotal)}</td></tr>
    ${hasDiscount ? `<tr><td>Discount</td><td class="num">- ${money(view.totals.discountAmount)}</td></tr>` : ''}
    <tr><td>Taxable amount</td><td class="num">${money(view.totals.taxableAmount)}</td></tr>
    ${taxRows}
    <tr class="grand"><td>Total</td><td class="num">${money(view.totals.total)}</td></tr>
  </table>

  ${textBlock('Scope', view.scope)}
  ${textBlock('Assumptions', view.assumptions)}
  ${textBlock('Exclusions', view.exclusions)}
  ${textBlock('Delivery timeline', view.deliveryTimeline)}
  ${schedule}

  <div class="foot">${text(view.number)} Rev ${view.revisionNo} &middot; ${text(view.issuer.legalName)}</div>
</body>
</html>
`;
}
