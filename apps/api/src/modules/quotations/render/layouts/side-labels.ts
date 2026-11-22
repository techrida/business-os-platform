// Side labels: the title and details at the top left, the logo at the right, and two grey cards whose labels
// run down their left edge.
import {
  NEUTRALS as N,
  brandMark,
  breakableAddress,
  customerAddressLines,
  detailRows,
  esc,
  issuerAddressLines,
  itemsTable,
  kvTable,
  statusBadge,
  tail,
  title,
  type LayoutRenderer,
  type RenderContext,
} from './shared';

const labelled = (rows: [string, string][]): string =>
  `<table class="lab">${rows
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `<tr><th scope="row">${k}</th><td>${v}</td></tr>`)
    .join('')}</table>`;

function cards(ctx: RenderContext): string {
  const { issuer, customer, contact } = ctx.view;
  const by = labelled([
    ['Quotation by', `<span class="legal">${esc(issuer.legalName)}</span>`],
    ['Address', issuerAddressLines(ctx)],
  ]);
  const to = labelled([
    ['Quotation to', `<span class="legal">${esc(customer.legalName)}</span>`],
    ['Address', customerAddressLines(ctx)],
    ['PAN/VAT', esc(customer.panVatNo)],
    ['Attention', contact ? esc(contact.fullName) : ''],
    [
      'Email',
      contact?.email ? `<span class="email">${breakableAddress(contact.email)}</span>` : '',
    ],
  ]);
  return `<section class="cards"><div class="card party">${by}</div><div class="card party">${to}</div></section>`;
}

export const sideLabels: LayoutRenderer = (ctx) => {
  const p = ctx.palette;
  const css = `
  .top { padding-top: 2mm; }
  .masthead { display: flex; justify-content: space-between; align-items: flex-start; gap: 12mm; }
  .masthead .title { font-size: 24pt; font-weight: 700; color: ${p.accentText}; letter-spacing: 0; margin-bottom: 4mm; }
  .masthead .status { color: ${p.accentText}; }
  .cards { display: flex; gap: 6mm; margin-top: 8mm; }
  .card { flex: 1 1 0; min-width: 0; padding: 5mm 6mm; border-radius: 2.5mm; background: ${N.panel}; break-inside: avoid; }
  table.lab { width: 100%; border-collapse: collapse; }
  table.lab th { width: 25mm; padding: 2pt 8pt 2pt 0; text-align: left; vertical-align: top; font-weight: 400; color: ${N.muted}; }
  table.lab td { padding: 2pt 0; vertical-align: top; overflow-wrap: anywhere; }
  table.lab td .email { overflow-wrap: break-word; }
  table.lab .legal { font-size: 9.5pt; }
  table.lab .addr, table.lab td div { color: ${N.ink}; }
  table.items th { background: ${p.primary}; color: ${p.onPrimary}; }
  table.items tbody tr:nth-child(even) td { background: ${N.panel}; }
  table.totals tr.grand td { background: ${p.primary}; color: ${p.onPrimary}; }
  .block h2 { color: ${p.accentText}; font-size: 9.5pt; text-transform: none; letter-spacing: 0; }
`;
  const body = `
  <div class="pad top">
    <section class="masthead">
      <div>${title()}${kvTable(detailRows(ctx))}${statusBadge(ctx.view)}</div>
      ${brandMark(ctx)}
    </section>
    ${cards(ctx)}
    ${itemsTable(ctx)}
    ${tail(ctx)}
  </div>`;
  return { css, body };
};
