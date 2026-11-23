// The entity logo on an invoice or a purchase order (U12, "Snapshots freeze BYTES"). At print time the `entity.profile`
// setting's logo document is resolved to its clean bytes and frozen into the document's format snapshot as a data URL,
// so changing or removing the logo afterwards never alters a document already printed. The HTML builders inline that
// data URL only after it passes LogoDataUrlSchema again, and allow `img-src data:` in their CSP only then.
//
// Same rules as the quotation's resolveSnapshotLogo (quotations/render/issuer.ts, not exported): the referenced
// document's bytes, else the not-yet-migrated legacy data URL, else none. A resolver failure for a referenced logo is
// DocumentLogoUnavailableError, so the render fails and retries instead of printing a logo-less document.
import { CompanyProfileSchema, LogoDataUrlSchema, PAPER_LOGO_BACKGROUND } from '@bos/contracts';

import type { TxScope } from '../../../platform/db/tx';
import { DocumentLogoUnavailableError } from '../../quotations/render/issuer';
import type { RenderLogos, RenderSettings } from '../../quotations/render/quotation-render.sweeper';

/**
 * The logo to freeze for a print in `scope`. A missing or invalid profile (a hand-edited row) means no logo; it never
 * fails the render. The resolver is called only when the profile references a logo document.
 */
export async function freezeEntityLogo(
  settings: RenderSettings,
  logos: RenderLogos,
  scope: TxScope,
): Promise<string | null> {
  const profile = CompanyProfileSchema.safeParse(await settings.get(scope, 'entity.profile'));
  if (!profile.success) return null;
  const legacy = profile.data.legacyLogoDataUrl ?? null;
  if (profile.data.logoDocumentId === null) return legacy;
  let resolved: string | null;
  try {
    // An invoice and a purchase order print the logo on white paper.
    resolved = await logos.forScope(scope)(profile.data.logoDocumentId, {
      colour: PAPER_LOGO_BACKGROUND,
      onDarkDocumentId: profile.data.logoOnDarkDocumentId,
      onLightDocumentId: profile.data.logoOnLightDocumentId,
    });
  } catch {
    // No data from the failure is carried, so nothing sensitive reaches a log.
    throw new DocumentLogoUnavailableError();
  }
  return resolved ?? legacy;
}

/** The logo to inline: only a value that passes the logo schema (PNG, JPEG or WebP data URL); anything else is none. */
export function printableLogo(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const parsed = LogoDataUrlSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The page's CSP: no network at all; data-URL images only when the page carries a validated logo. */
export function documentCsp(logo: string | null): string {
  return `default-src 'none'; style-src 'unsafe-inline'${logo ? '; img-src data:' : ''}`;
}
