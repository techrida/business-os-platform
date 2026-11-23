// Renders a `CustomerQuotationView` as one self-contained HTML page for Gotenberg (Chromium) to print as an
// A4 PDF. Self-contained on purpose: inline CSS only, no external URL, script or font file, and a CSP that
// forbids anything else, so a render never reaches the network. The one image allowed is the tenant's logo, and
// only as a data URL that passed the logo schema. Gotenberg's container supplies the Noto fonts. The function
// takes the whitelist view and the frozen style snapshot and nothing else, so it cannot print a cost or a rate.
import {
  DEFAULT_DOCUMENT_STYLE,
  DEFAULT_NUMBER_SYSTEMS,
  EMPTY_SNAPSHOT_COMPANY_PROFILE,
  LogoDataUrlSchema,
  deriveBrandPalette,
  snapshotNumberSystems,
  type CustomerQuotationView,
  type DocumentLayout,
  type DocumentStyleSnapshot,
} from '@bos/contracts';
import { DEFAULT_CUSTOMER_DATE_FORMAT } from '@bos/locale';

import { banded } from './layouts/banded';
import { duoCards } from './layouts/duo-cards';
import { ledger } from './layouts/ledger';
import { documentShell, type LayoutRenderer, type RenderContext } from './layouts/shared';
import { sideLabels } from './layouts/side-labels';
import { tinted } from './layouts/tinted';

export interface RenderQuotationOptions {
  /** Print the Bikram Sambat date beside each date. Default true. */
  showBsDate?: boolean;
  /**
   * The layout, colour, company profile and number system frozen onto the version. Left out, the document uses
   * the default style, an empty profile and South Asian (lakh, crore) grouping.
   */
  snapshot?: DocumentStyleSnapshot;
}

/** One renderer per layout; a layout added to the contract without one is a type error here. */
export const QUOTATION_LAYOUTS: Record<DocumentLayout, LayoutRenderer> = {
  banded,
  'duo-cards': duoCards,
  ledger,
  'side-labels': sideLabels,
  tinted,
};

/** Returns the full HTML document for a customer quotation. Every text is escaped. */
export function renderQuotationHtml(
  view: CustomerQuotationView,
  opts: RenderQuotationOptions = {},
): string {
  const style = opts.snapshot?.style ?? DEFAULT_DOCUMENT_STYLE;
  const profile = opts.snapshot?.profile ?? EMPTY_SNAPSHOT_COMPANY_PROFILE;
  const logo = profile.logoDataUrl ? LogoDataUrlSchema.safeParse(profile.logoDataUrl) : null;
  // An unknown layout in an old snapshot falls back to the default rather than failing the render.
  const layout: DocumentLayout = Object.hasOwn(QUOTATION_LAYOUTS, style.layout)
    ? style.layout
    : 'banded';

  const ctx: RenderContext = {
    view,
    palette: deriveBrandPalette(style.primaryColour),
    profile,
    numberSystems: opts.snapshot ? snapshotNumberSystems(opts.snapshot) : DEFAULT_NUMBER_SYSTEMS,
    dateFormat: opts.snapshot?.dateFormat ?? DEFAULT_CUSTOMER_DATE_FORMAT,
    showBs: opts.showBsDate !== false,
    logo: logo?.success ? logo.data : null,
    logoChosen: opts.snapshot?.logoForBackground !== undefined,
  };
  return documentShell(ctx, layout, QUOTATION_LAYOUTS[layout](ctx));
}
