// Ledger: ruled, bordered tables and a boxed footer. The reference shows a per-line discount column; the
// customer view has no per-line discount (the discount is on the whole quotation), so the column is left out
// rather than invented, and the discount prints in the totals.
import {
  NEUTRALS as N,
  brandMark,
  customerParty,
  detailRows,
  docRef,
  issuerParty,
  itemsTable,
  kvTable,
  statusBadge,
  tail,
  title,
  type LayoutRenderer,
} from './shared';

export const ledger: LayoutRenderer = (ctx) => {
  const p = ctx.palette;
  const css = `
  .top { padding-top: 2mm; }
  .masthead { display: flex; justify-content: space-between; align-items: flex-start; gap: 12mm; }
  .doc { text-align: right; min-width: 0; }
  .doc .number { margin-top: 4pt; }
  .trio { display: flex; gap: 8mm; margin-top: 8mm; }
  .trio > div { flex: 1 1 0; min-width: 0; }
  .trio > div:last-child { flex-grow: 1.3; }
  .trio h2 { color: ${N.ink}; font-size: 10pt; text-transform: none; letter-spacing: 0; }
  table.items th, table.items td { border: 0.75pt solid ${N.rule}; }
  table.items th { background: ${p.tint}; color: ${p.onTint}; }
  table.totals { border-collapse: collapse; }
  table.totals td { border: 0.75pt solid ${N.rule}; padding: 4pt 8pt; }
  table.totals td:first-child { text-align: right; }
  table.totals tr.grand td { background: ${p.primary}; color: ${p.onPrimary}; border-color: ${p.primary}; }
  .words { margin-top: 0; padding: 6pt 8pt; border: 0.75pt solid ${N.rule}; border-top: 0; }
  .block h2 { color: ${N.ink}; font-size: 10pt; text-transform: none; letter-spacing: 0; }
  .foot { left: 14mm; right: 14mm; bottom: 6mm; height: 21mm; padding: 3.5mm 5mm 0; border: 0.75pt solid ${N.rule}; }
  .foot-bar { display: none; }
`;
  const body = `
  <div class="pad top">
    <section class="masthead">
      ${brandMark(ctx)}
      <div class="doc">${title()}<p class="number">${docRef(ctx.view)}</p>${statusBadge(ctx.view)}</div>
    </section>
    <section class="trio">
      <div><h2>Quotation by</h2>${issuerParty(ctx)}</div>
      <div><h2>Quotation to</h2>${customerParty(ctx)}</div>
      <div><h2>Details</h2>${kvTable(detailRows(ctx))}</div>
    </section>
    ${itemsTable(ctx)}
    ${tail(ctx)}
  </div>`;
  return { css, body };
};
