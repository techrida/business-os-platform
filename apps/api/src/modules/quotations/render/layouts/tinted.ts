// Tinted header: a soft brand wash across the top, a tinted totals panel, and a tinted closing section.
import {
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

export const tinted: LayoutRenderer = (ctx) => {
  const p = ctx.palette;
  const css = `
  .band { display: flex; align-items: flex-start; gap: 9mm; padding: 13mm 14mm 10mm; background: ${p.tint}; border-bottom: 0.75pt solid ${p.tintStrong}; }
  .band-doc { flex: 1 1 0; min-width: 0; }
  .band-doc .title { color: ${p.onTint}; }
  .band-doc .number { margin-top: 5pt; font-size: 10.5pt; }
  .band-doc .status { color: ${p.onTint}; }
  .band-from { flex: 0 1 60mm; min-width: 0; font-size: 8.5pt; }
  .band .brand { flex: none; }
  .band .wordmark { color: ${p.onTint}; font-size: 13pt; max-width: 50mm; text-align: right; }
  .intro { display: flex; justify-content: space-between; gap: 12mm; margin-top: 9mm; }
  .intro .party-wrap { min-width: 0; flex: 1 1 0; max-width: 90mm; }
  .intro .details { flex: 0 1 auto; min-width: 0; }
  .intro h2 { display: inline-block; padding: 1pt 5pt; background: ${p.tint}; color: ${p.onTint}; border-left: 1px solid ${p.primary}; }
  table.items th { background: ${p.primary}; color: ${p.onPrimary}; }
  table.items tbody tr:nth-child(even) td { background: ${p.tint}; }
  .summary-main { padding: 4mm 5mm; border-radius: 2.5mm; background: ${p.tint}; }
  table.totals td { border-bottom: 0.5pt solid ${p.tintStrong}; }
  table.totals tr.grand td { padding: 7pt 0 3pt; border-bottom: 0; color: ${p.onTint}; font-size: 13pt; }
  .closing-band { margin: 7mm -14mm 0; padding: 1mm 14mm 5mm; background: ${p.tint}; -webkit-box-decoration-break: clone; box-decoration-break: clone; }
  .closing-band .block h2 { color: ${p.onTint}; }
  .foot { background: ${p.tint}; border-top-color: ${p.tintStrong}; }
`;
  const body = `
  <header class="band bleed">
    <div class="band-doc">${title()}<p class="number">${docRef(ctx.view)}</p>${statusBadge(ctx.view)}</div>
    <div class="band-from"><h2>Quotation by</h2>${issuerParty(ctx)}</div>
    ${brandMark(ctx)}
  </header>
  <div class="pad">
    <section class="intro">
      <div class="party-wrap"><h2>Prepared for</h2>${customerParty(ctx)}</div>
      <div class="details"><h2>Quotation details</h2>${kvTable(detailRows(ctx))}</div>
    </section>
    ${itemsTable(ctx)}
    ${tail(ctx, (inner) => `<div class="closing-band">${inner}</div>`)}
  </div>`;
  return { css, body };
};
