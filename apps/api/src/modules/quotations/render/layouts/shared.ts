// The building blocks every quotation layout shares: one data model, escaped once here, so a layout can only
// arrange blocks and colour them; it cannot print a field the whitelist view does not carry. Colours come from
// the palette derived from the tenant's one brand colour, plus the fixed neutrals below; nothing else.
//
// Pagination (checked in Chromium): the page has no @page margin. The whole document sits in one "sheet" table
// whose repeated <thead> and <tfoot> spacers reserve a top margin and the footer's height on every page, and the
// footer itself is `position: fixed`, so Chromium paints it at the bottom of every page, the last one included,
// without ever covering a row. The items table repeats its own header; rows and blocks do not split.
import {
  formatAddressLines,
  formatPhoneForPrint,
  richTextToHtml,
  trimPercent,
  type BrandPalette,
  type CountryCode,
  type SnapshotCompanyProfile,
  type CustomerQuotationView,
} from '@bos/contracts';
import {
  Dec,
  amountInWords,
  bsLongOfDay,
  formatCustomerDate,
  formatMoney,
  type CustomerDateFormat,
  type NumberSystems,
} from '@bos/locale';

/** Everything a layout may read. `logo` is set only when it passed the data-URL schema. */
export interface RenderContext {
  view: CustomerQuotationView;
  palette: BrandPalette;
  profile: SnapshotCompanyProfile;
  numberSystems: NumberSystems;
  dateFormat: CustomerDateFormat;
  showBs: boolean;
  logo: string | null;
}

export interface LayoutOutput {
  /** Layout CSS, appended after the shared CSS. */
  css: string;
  /** The document body inside the sheet; the footer is added by the shell. */
  body: string;
}

export type LayoutRenderer = (ctx: RenderContext) => LayoutOutput;

/** The only colours besides the palette. Six-digit so a test can check every hex in the CSS. */
export const NEUTRALS = {
  ink: '#111827',
  muted: '#4b5563',
  line: '#e5e7eb',
  lineStrong: '#9ca3af',
  rule: '#374151',
  panel: '#f3f4f6',
  paper: '#ffffff',
} as const;

const N = NEUTRALS;

export const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export const esc = (value: string | null | undefined): string => escapeHtml(value ?? '');

/**
 * An email address or web address, escaped, with a line-break opportunity (<wbr>) after `@` and before each dot
 * or hyphen, so a narrow column breaks it at a readable point instead of inside a word.
 */
export const breakableAddress = (value: string): string =>
  escapeHtml(value)
    .replace(/@/g, '@<wbr>')
    .replace(/([.-])/g, '<wbr>$1');

/** A full amount with its currency code, grouped by the document's number system. */
export const money = (ctx: RenderContext, amount: string): string =>
  escapeHtml(formatMoney(amount, ctx.view.currency, { numberSystems: ctx.numberSystems }));

/** The amount without the currency code, for table cells under a header that names the currency. */
export function figure(ctx: RenderContext, amount: string): string {
  const full = formatMoney(amount, ctx.view.currency, { numberSystems: ctx.numberSystems });
  const prefix = `${ctx.view.currency} `;
  return escapeHtml(full.startsWith(prefix) ? full.slice(prefix.length) : full);
}

/**
 * The Gregorian date with the Bikram Sambat date beside it in the one long BS form (`22 Kartik 2083 BS`, U16-Q5), as on
 * the invoice and the purchase order. Outside the converter's range (BS 2000 to 2090) the Gregorian date shows alone.
 */
export function dateCell(
  isoDate: string,
  ctx: Pick<RenderContext, 'showBs' | 'dateFormat'>,
): string {
  const gregorian = escapeHtml(formatCustomerDate(isoDate, ctx.dateFormat));
  if (!ctx.showBs) return gregorian;
  const bs = bsLongOfDay(isoDate);
  return bs === null ? gregorian : `${gregorian} <span class="bs">(${escapeHtml(bs)})</span>`;
}

/** An address with its country, as a document prints it (the `entity.address` setting has this shape). */
type PrintableAddress = { line: string; city: string; country: CountryCode };

/**
 * The printed parts of an address, unescaped: street, city, then the country's name, left out when it is
 * `ownCountry` (see formatAddressLines). The footer joins them inline, the memo letterhead stacks them.
 */
export const addressParts = (a: PrintableAddress, ownCountry?: CountryCode): string[] =>
  formatAddressLines(a, a.country, ownCountry);

export const addressLines = (a: PrintableAddress, ownCountry?: CountryCode): string =>
  addressParts(a, ownCountry)
    .map((l) => `<div>${escapeHtml(l)}</div>`)
    .join('');

export const addressInline = (a: PrintableAddress, ownCountry?: CountryCode): string =>
  escapeHtml(addressParts(a, ownCountry).join(', '));

type Party = CustomerQuotationView['issuer'];

const printable = (party: Party): PrintableAddress => ({
  line: party.address.line,
  city: party.address.city,
  country: party.country,
});

/** The issuing entity's own address, its country always printed: the entity is where "own country" is measured from. */
export const issuerAddressLines = (ctx: RenderContext): string =>
  addressLines(printable(ctx.view.issuer));

/** The customer's address; the country is left out when it is the issuing entity's own. */
export const customerAddressLines = (ctx: RenderContext): string =>
  addressLines(printable(ctx.view.customer), ctx.view.issuer.country);

export const docRef = (view: CustomerQuotationView): string =>
  `${esc(view.number)} Rev ${view.revisionNo}`;

const STATUS_LABELS: Partial<Record<CustomerQuotationView['status'], string>> = {
  accepted: 'Accepted',
  rejected: 'Rejected',
  expired: 'Expired',
  superseded: 'Superseded',
};

export function statusBadge(view: CustomerQuotationView): string {
  const label = STATUS_LABELS[view.status];
  return label ? `<span class="status">${label}</span>` : '';
}

/** The brand's printed name: the profile's display name, else the issuing entity's legal name. */
export const brandName = (ctx: RenderContext): string =>
  ctx.profile.displayName ?? ctx.view.issuer.legalName;

/** The logo when there is a valid one, else the brand name set as a wordmark. */
export function brandMark(ctx: RenderContext): string {
  if (ctx.logo) {
    return `<div class="brand brand--logo"><img src="${escapeHtml(ctx.logo)}" alt="${esc(brandName(ctx))}"></div>`;
  }
  return `<div class="brand brand--word"><span class="wordmark">${esc(brandName(ctx))}</span></div>`;
}

export const title = (): string => '<h1 class="title">Quotation</h1>';

/** The issuing entity. Its PAN/VAT number prints once, in the footer. */
export const issuerParty = (ctx: RenderContext): string =>
  `<div class="party"><p class="legal">${esc(ctx.view.issuer.legalName)}</p><div class="addr">${issuerAddressLines(ctx)}</div></div>`;

export function customerParty(ctx: RenderContext): string {
  const { customer, contact } = ctx.view;
  const pan = customer.panVatNo
    ? `<p class="pan"><span class="muted">PAN/VAT</span> ${esc(customer.panVatNo)}</p>`
    : '';
  const attention = contact
    ? `<div class="attn"><p><span class="muted">Attention</span> <strong>${esc(contact.fullName)}</strong></p>${
        contact.email ? `<p class="muted email">${breakableAddress(contact.email)}</p>` : ''
      }</div>`
    : '';
  return `<div class="party"><p class="legal">${esc(customer.legalName)}</p><div class="addr">${customerAddressLines(ctx)}</div>${pan}${attention}</div>`;
}

/** Label and value pairs of the quotation's own details. Values are already escaped HTML. */
export function detailRows(ctx: RenderContext): [string, string][] {
  const { view } = ctx;
  const rows: [string, string][] = [
    ['Quotation no.', `<span class="number">${docRef(view)}</span>`],
    ['Issue date', dateCell(view.issueDate, ctx)],
    ['Valid until', dateCell(view.validUntil, ctx)],
  ];
  if (view.paymentTermName) rows.push(['Payment terms', esc(view.paymentTermName)]);
  return rows;
}

export const kvTable = (rows: [string, string][]): string =>
  `<table class="kv">${rows.map(([k, v]) => `<tr><th scope="row">${k}</th><td>${v}</td></tr>`).join('')}</table>`;

export function itemsTable(ctx: RenderContext): string {
  const cur = escapeHtml(ctx.view.currency);
  const rows = ctx.view.lines.length
    ? ctx.view.lines
        .map(
          (l) => `
        <tr>
          <td class="no">${l.lineNo}</td>
          <td class="desc">${esc(l.description)}</td>
          <td class="uom">${esc(l.uom)}</td>
          <td class="num">${esc(l.quantity)}</td>
          <td class="num">${figure(ctx, l.unitPrice)}</td>
          <td class="num">${figure(ctx, l.amount)}</td>
        </tr>`,
        )
        .join('')
    : '<tr><td class="empty" colspan="6">No items on this quotation.</td></tr>';
  return `
    <table class="items">
      <colgroup><col class="c-no"><col><col class="c-uom"><col class="c-qty"><col class="c-price"><col class="c-amount"></colgroup>
      <thead>
        <tr>
          <th class="no">#</th><th>Description</th><th>Unit</th>
          <th class="num">Qty</th><th class="num">Unit price (${cur})</th><th class="num">Amount (${cur})</th>
        </tr>
      </thead>
      <tbody>${rows}
      </tbody>
    </table>`;
}

export function totalsTable(ctx: RenderContext): string {
  const t = ctx.view.totals;
  const discount = new Dec(t.discountAmount).isZero()
    ? ''
    : `<tr class="disc"><td>Discount</td><td class="num">&minus; ${money(ctx, t.discountAmount)}</td></tr>`;
  const taxes = ctx.view.taxSummary
    .map(
      (x) =>
        `<tr><td>${esc(x.label)} (${esc(x.percent)}%) <span class="on">on ${money(ctx, x.base)}</span></td><td class="num">${money(ctx, x.tax)}</td></tr>`,
    )
    .join('');
  return `<table class="totals">
      <tr><td>Subtotal</td><td class="num">${money(ctx, t.subtotal)}</td></tr>
      ${discount}
      <tr><td>Taxable amount</td><td class="num">${money(ctx, t.taxableAmount)}</td></tr>
      ${taxes}
      <tr class="grand"><td>Total due</td><td class="num">${money(ctx, t.total)}</td></tr>
    </table>`;
}

export const amountWords = (ctx: RenderContext): string =>
  `<p class="words"><span class="words-label">Amount in words:</span> <strong>${esc(
    amountInWords(ctx.view.totals.total, ctx.view.currency, ctx.numberSystems[ctx.view.currency]),
  )}</strong></p>`;

export function scheduleBlock(ctx: RenderContext): string {
  const s = ctx.view.paymentSchedule;
  if (!s.length) return '';
  return `<section class="block"><h2>Payment schedule</h2><table class="schedule">${s
    .map(
      (m) =>
        `<tr><td>${esc(m.label)}</td><td>${esc(trimPercent(m.percent))}%</td><td class="num">${money(ctx, m.amount)}</td><td class="muted">${esc(m.dueDescription && formatCustomerDate(m.dueDescription, ctx.dateFormat))}</td></tr>`,
    )
    .join('')}</table></section>`;
}

/** Totals on the right; the payment schedule, when there is one, on the left. Never split across pages. */
export const summary = (ctx: RenderContext): string =>
  `<section class="summary"><div class="summary-side">${scheduleBlock(ctx)}</div><div class="summary-main">${totalsTable(ctx)}${amountWords(ctx)}</div></section>`;

/**
 * A stored wording (scope, terms and the like) as HTML safe to print, or '' when there is none. Rich text is rebuilt
 * from its allow-listed tags and legacy plain text is escaped, both by `richTextToHtml`; nothing else may put such
 * wording into the page.
 */
export function richBlock(value: string | null | undefined): string {
  const html = richTextToHtml(value);
  return html === '' ? '' : `<div class="rich">${html}</div>`;
}

const textBlock = (heading: string, body: string | null): string => {
  const rich = richBlock(body);
  return rich === '' ? '' : `<section class="block"><h2>${heading}</h2>${rich}</section>`;
};

/** The text sections that have content, in reading order. */
const textBlockList = (ctx: RenderContext): string[] =>
  [
    textBlock('Scope', ctx.view.scope),
    textBlock('Assumptions', ctx.view.assumptions),
    textBlock('Exclusions', ctx.view.exclusions),
    textBlock('Delivery timeline', ctx.view.deliveryTimeline),
    textBlock('Terms and conditions', ctx.view.termsAndConditions),
  ].filter((block) => block !== '');

export const textBlocks = (ctx: RenderContext): string => textBlockList(ctx).join('');

export function signatory(ctx: RenderContext): string {
  const { signatoryName, signatoryTitle } = ctx.profile;
  return `<section class="sign">
      <p class="sign-for">For ${esc(ctx.view.issuer.legalName)}</p>
      <div class="sign-line"></div>
      ${signatoryName ? `<p class="sign-name">${esc(signatoryName)}</p>` : ''}
      <p class="sign-title">${esc(signatoryTitle ?? 'Authorised signatory')}</p>
    </section>`;
}

/** Wraps the closing text sections; a layout may put them on its own band. */
export type ClosingWrap = (inner: string) => string;

const plainClosing: ClosingWrap = (inner) => `<div class="closing">${inner}</div>`;

/**
 * Totals, the text sections and the signature, in reading order. The signature never sits alone on a page: it
 * shares one unbreakable `.sign-keep` box with the last text section, or with the totals when there is none.
 */
export function tail(ctx: RenderContext, wrapClosing: ClosingWrap = plainClosing): string {
  const blocks = textBlockList(ctx);
  const last = blocks.pop();
  if (last === undefined) {
    return `<div class="sign-keep">${summary(ctx)}${signatory(ctx)}</div>`;
  }
  return `${summary(ctx)}${wrapClosing(`${blocks.join('')}<div class="sign-keep">${last}${signatory(ctx)}</div>`)}`;
}

// Footer icons: 24px stroke paths after Lucide (ISC). Inline, so nothing is fetched; no xmlns needed in HTML.
const icon = (paths: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const ICON_PHONE = icon(
  '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
);
const ICON_PIN = icon(
  '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
);
const ICON_MAIL = icon(
  '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
);
const ICON_ID = icon(
  '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h10"/><path d="M7 13h6"/>',
);

/** Phones, address, email and website, PAN/VAT. Empty columns are left out. */
export function footer(ctx: RenderContext): string {
  const p = ctx.profile;
  const pan = p.panVatNo ?? ctx.view.issuer.panVatNo;
  const col = (kind: string, glyph: string, lines: string[]): string =>
    lines.length
      ? `<div class="foot-col foot-col--${kind}">${glyph}<div>${lines.map((l) => `<div>${l}</div>`).join('')}</div></div>`
      : '';
  const contact = [p.email, p.website].filter((v): v is string => Boolean(v)).map(breakableAddress);
  return `<footer class="foot">
    ${col(
      'tel',
      ICON_PHONE,
      p.phones.map((phone) => esc(formatPhoneForPrint(phone))),
    )}
    ${col('addr', ICON_PIN, [addressInline(printable(ctx.view.issuer))])}
    ${col('mail', ICON_MAIL, contact)}
    ${col('pan', ICON_ID, pan ? [`PAN/VAT No. ${esc(pan)}`] : [])}
    <div class="foot-bar"></div>
  </footer>`;
}

/** Footer box height; the sheet's bottom spacer adds a gap above it. */
export const FOOTER_HEIGHT_MM = 24;

export const baseCss = (p: BrandPalette): string => `
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  html { font-size: 9.5pt; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    font-family: 'Noto Sans', 'Noto Sans Devanagari', sans-serif;
    color: ${N.ink};
    line-height: 1.45;
    margin: 0;
    font-variant-numeric: tabular-nums;
  }
  p { margin: 0; }
  table.sheet { width: 100%; border-collapse: collapse; }
  table.sheet > thead { display: table-header-group; }
  table.sheet > tfoot { display: table-footer-group; }
  table.sheet > * > tr > td { padding: 0; vertical-align: top; }
  .sheet-top { height: 12mm; }
  .sheet-bottom { height: ${FOOTER_HEIGHT_MM + 8}mm; }
  .pad { padding-left: 14mm; padding-right: 14mm; }
  .bleed { margin-top: -12mm; }

  .title { margin: 0; font-size: 28pt; line-height: 1.05; font-weight: 300; letter-spacing: -0.01em; }
  h2 {
    margin: 0 0 4pt; font-size: 7.5pt; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.08em; color: ${N.muted}; break-after: avoid;
  }
  .muted { color: ${N.muted}; }
  .bs { color: ${N.muted}; font-size: 8pt; white-space: nowrap; }
  .number { font-weight: 700; }
  .status {
    display: inline-block; margin-top: 4pt; padding: 1pt 7pt; border: 0.75pt solid currentColor;
    border-radius: 8pt; font-size: 7.5pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
  }
  .legal { font-weight: 700; font-size: 10.5pt; line-height: 1.3; margin-bottom: 2pt; }
  .party, .party *, .desc, .rich, .kv td, .wordmark, .legal, .words, .sign, .schedule td {
    overflow-wrap: anywhere;
  }
  /* Addresses break at their <wbr> points; splitting a word is the last resort, for one longer than the column. */
  .party .email, .foot { overflow-wrap: break-word; }
  .addr { color: ${N.muted}; }
  .pan { margin-top: 4pt; }
  .attn { margin-top: 6pt; }
  .attn .muted { font-size: 8.5pt; }
  .brand img { display: block; height: 14mm; width: auto; max-width: 52mm; object-fit: contain; object-position: right center; }
  .wordmark { display: block; max-width: 70mm; font-size: 15pt; font-weight: 800; line-height: 1.15; letter-spacing: -0.01em; color: ${p.accentText}; }

  table.kv { border-collapse: collapse; }
  table.kv th { text-align: left; font-weight: 400; color: ${N.muted}; padding: 1.5pt 10pt 1.5pt 0; vertical-align: top; white-space: nowrap; }
  table.kv td { padding: 1.5pt 0; vertical-align: top; font-weight: 600; }

  table.items { width: 100%; border-collapse: collapse; table-layout: fixed; margin-top: 8mm; }
  table.items thead { display: table-header-group; }
  table.items tr { break-inside: avoid; }
  table.items th { padding: 5pt 6pt; font-size: 8pt; font-weight: 700; text-align: left; vertical-align: bottom; }
  table.items td { padding: 5pt 6pt; vertical-align: top; border-bottom: 0.5pt solid ${N.line}; }
  table.items td.no { color: ${N.muted}; }
  col.c-no { width: 9mm; }
  col.c-uom { width: 15mm; }
  col.c-qty { width: 15mm; }
  col.c-price { width: 31mm; }
  col.c-amount { width: 33mm; }
  .num { text-align: right; white-space: nowrap; }
  .desc { white-space: pre-wrap; }
  .empty { text-align: center; color: ${N.muted}; padding: 12pt 6pt; }

  .summary { display: flex; gap: 10mm; margin-top: 7mm; align-items: flex-start; break-inside: avoid; }
  .summary-side { flex: 1 1 0; min-width: 0; }
  .summary-side .block { margin-top: 0; }
  .summary-main { flex: 0 0 88mm; min-width: 0; }
  table.totals { width: 100%; border-collapse: collapse; }
  table.totals td { padding: 3pt 0; vertical-align: top; }
  table.totals td.num { padding-left: 8pt; }
  table.totals .on { display: block; color: ${N.muted}; font-size: 7.5pt; }
  table.totals tr.grand td { padding: 7pt 8pt; font-size: 11.5pt; font-weight: 700; }
  .words { margin-top: 6pt; font-size: 8.5pt; color: ${N.muted}; }
  .words strong { color: ${N.ink}; font-weight: 600; }

  .block { margin-top: 6mm; break-inside: avoid; }
  /* Rich wording (D31): paragraphs, lists, bold and italic. A list item never splits across pages. */
  .rich { max-width: 160mm; }
  .rich p { margin: 0 0 4pt; orphans: 2; widows: 2; }
  .rich ul, .rich ol { margin: 0 0 4pt; padding-left: 5mm; }
  .rich ul { list-style: disc outside; }
  .rich ol { list-style: decimal outside; }
  .rich ul ul, .rich ol ul { list-style-type: circle; }
  .rich ul ul ul, .rich ol ul ul, .rich ul ol ul, .rich ol ol ul { list-style-type: square; }
  .rich ol ol { list-style-type: lower-alpha; }
  .rich ol ol ol { list-style-type: lower-roman; }
  .rich li ul, .rich li ol { margin: 2pt 0 0; }
  .rich li { margin: 0 0 2pt; padding-left: 1pt; break-inside: avoid; orphans: 2; widows: 2; }
  .rich > :last-child { margin-bottom: 0; }
  .rich strong { font-weight: 700; }
  .rich em { font-style: italic; }
  table.schedule { border-collapse: collapse; }
  table.schedule td { padding: 2pt 12pt 2pt 0; vertical-align: top; }
  table.schedule td:nth-child(2) { font-weight: 600; white-space: nowrap; }

  .closing { margin-top: 2mm; }
  .sign-keep { break-inside: avoid; }
  .sign { width: 64mm; margin: 6mm 0 0 auto; text-align: center; break-inside: avoid; }
  .sign-for { font-size: 8.5pt; color: ${N.muted}; }
  .sign-line { height: 12mm; border-bottom: 0.75pt solid ${N.lineStrong}; margin-bottom: 4pt; }
  .sign-name { font-weight: 700; }
  .sign-title { font-size: 8.5pt; color: ${N.muted}; }

  .foot {
    position: fixed; left: 0; right: 0; bottom: 0; height: ${FOOTER_HEIGHT_MM}mm; overflow: hidden;
    display: flex; gap: 7mm; padding: 4.5mm 14mm 0; font-size: 7.5pt; line-height: 1.4; color: ${N.muted};
    background: ${N.paper}; border-top: 0.5pt solid ${N.line};
  }
  /* Columns size to their content (an email keeps its line); the address takes what is left and wraps. */
  .foot-col { flex: 0 1 auto; min-width: 0; display: flex; gap: 5pt; align-items: flex-start; }
  .foot-col > div { min-width: 0; }
  .foot-col--tel { max-width: 40mm; }
  .foot-col--addr { flex: 1 1 0; min-width: 36mm; }
  .foot-col--mail { max-width: 64mm; }
  .foot-col--pan { max-width: 34mm; }
  .foot svg { flex: none; width: 10pt; height: 10pt; margin-top: 0.5pt; color: ${p.accentText}; }
  .foot-bar { position: absolute; left: 0; right: 0; bottom: 0; height: 3mm; background: ${p.primary}; }
`;

/** Wraps a layout's body in the paginating sheet and the page shell. */
export function documentShell(ctx: RenderContext, layoutClass: string, out: LayoutOutput): string {
  const csp = `default-src 'none'; style-src 'unsafe-inline'${ctx.logo ? '; img-src data:' : ''}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>${docRef(ctx.view)}</title>
<style>${baseCss(ctx.palette)}${out.css}</style>
</head>
<body class="layout-${layoutClass}">
${footer(ctx)}
<table class="sheet" role="presentation">
<thead><tr><td><div class="sheet-top"></div></td></tr></thead>
<tfoot><tr><td><div class="sheet-bottom"></div></td></tr></tfoot>
<tbody><tr><td>
${out.body}
</td></tr></tbody>
</table>
</body>
</html>
`;
}
