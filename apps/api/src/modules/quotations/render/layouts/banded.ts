// Banded: a solid brand-colour band across the top (title, issuer, logo), the client beside the details below.
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

export const banded: LayoutRenderer = (ctx) => {
  const p = ctx.palette;
  const css = `
  .band { display: flex; align-items: flex-start; gap: 9mm; padding: 13mm 14mm 10mm; background: ${p.primary}; color: ${p.onPrimary}; }
  .band-doc { flex: 1 1 0; min-width: 0; }
  .band-doc .number { margin-top: 5pt; font-size: 10.5pt; }
  .band-from { flex: 0 1 60mm; min-width: 0; font-size: 8.5pt; }
  .band-from h2, .band-from .addr { color: ${p.onPrimary}; opacity: 0.86; }
  .band-from .legal { font-size: 10pt; }
  .band .brand { flex: none; }
  ${ctx.logoChosen ? '/* The snapshot froze the logo that reads on the band (chooseLogo): it sits on the band itself. */' : `.band .brand--logo { background: #ffffff; padding: 2.5mm 3.5mm; border-radius: 1.5mm; }`}
  .band .wordmark { color: ${p.onPrimary}; font-size: 13pt; max-width: 50mm; text-align: right; }
  .intro { display: flex; justify-content: space-between; gap: 12mm; margin-top: 9mm; }
  .intro .party-wrap { min-width: 0; flex: 1 1 0; max-width: 90mm; }
  .intro .details { flex: 0 1 auto; min-width: 0; }
  .intro h2 { color: ${p.accentText}; }
  table.items th { background: ${p.primary}; color: ${p.onPrimary}; }
  table.items tbody tr:nth-child(even) td { background: ${p.tint}; }
  table.totals tr.grand td { background: ${p.primary}; color: ${p.onPrimary}; }
  .block h2 { color: ${p.accentText}; }
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
    ${tail(ctx)}
  </div>`;
  return { css, body };
};
