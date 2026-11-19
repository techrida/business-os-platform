// Two cards: a centred title, logo beside the details, then "Quotation by" and "Quotation to" side by side.
import {
  brandMark,
  customerParty,
  detailRows,
  issuerParty,
  itemsTable,
  kvTable,
  statusBadge,
  tail,
  title,
  type LayoutRenderer,
} from './shared';

export const duoCards: LayoutRenderer = (ctx) => {
  const p = ctx.palette;
  const css = `
  .top { padding-top: 2mm; }
  .top .title { text-align: center; font-size: 22pt; font-weight: 700; color: ${p.accentText}; letter-spacing: 0; }
  .masthead { display: flex; justify-content: space-between; align-items: center; gap: 12mm; margin-top: 7mm; }
  .masthead .details { min-width: 0; text-align: left; }
  .masthead .status { color: ${p.accentText}; }
  .cards { display: flex; gap: 6mm; margin-top: 7mm; }
  .card { flex: 1 1 0; min-width: 0; padding: 5mm 6mm; border-radius: 2.5mm; background: ${p.tint}; break-inside: avoid; }
  .card h2 { color: ${p.onTint}; font-size: 9.5pt; text-transform: none; letter-spacing: 0; }
  table.items th { background: ${p.primary}; color: ${p.onPrimary}; }
  table.items tbody tr:nth-child(even) td { background: ${p.tint}; }
  table.totals tr.grand td { background: ${p.primary}; color: ${p.onPrimary}; }
  .block h2 { color: ${p.accentText}; font-size: 9.5pt; text-transform: none; letter-spacing: 0; }
`;
  const body = `
  <div class="pad top">
    ${title()}
    <section class="masthead">
      ${brandMark(ctx)}
      <div class="details">${kvTable(detailRows(ctx))}${statusBadge(ctx.view)}</div>
    </section>
    <section class="cards">
      <div class="card"><h2>Quotation by</h2>${issuerParty(ctx)}</div>
      <div class="card"><h2>Quotation to</h2>${customerParty(ctx)}</div>
    </section>
    ${itemsTable(ctx)}
    ${tail(ctx)}
  </div>`;
  return { css, body };
};
