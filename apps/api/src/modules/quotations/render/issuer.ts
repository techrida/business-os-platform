// The selling legal entity as a quotation shows it (ADR 0027: the acting organization is the legal entity).
// The legal name is the organization's own column; the PAN or VAT number and the address are per-entity settings
// (`entity.pan_vat_no`, `entity.address`), read through SettingsService for the entity's scope. An entity with no
// address is not ready to issue a quotation: that is a typed error, so the render job logs a fixed kind and the
// admin sees a clear reason, instead of a schema error that carries data.
import {
  DocumentStyleSnapshotSchema,
  SETTINGS,
  StoredCompanyProfileSchema,
  StoredEntityPanVatNoSchema,
  snapshotProfileFrom,
  type CompanyProfile,
  type DocumentStyleSnapshot,
} from '@bos/contracts';

import type { TxScope } from '../../../platform/db/tx';
import type { SettingsService } from '../../../platform/settings/settings.service';
import type { CustomerViewIssuer } from './customer-view';

/** The only settings calls the issuer needs; a unit test passes a fake. */
export type IssuerSettings = Pick<SettingsService, 'get'>;

export type IssuerMissing = 'address';

export class IssuerIncompleteError extends Error {
  readonly kind = 'issuer_incomplete';

  constructor(readonly missing: IssuerMissing) {
    super(`The issuing entity has no ${missing} set`);
    this.name = 'IssuerIncompleteError';
  }
}

export async function buildIssuer(
  settings: IssuerSettings,
  scope: TxScope,
  legalName: string,
): Promise<CustomerViewIssuer> {
  const [rawPan, rawAddress] = await Promise.all([
    settings.get(scope, 'entity.pan_vat_no'),
    settings.get(scope, 'entity.address'),
  ]);
  // Rows are validated when written; this guards a row that was edited by hand. Invalid counts as not set.
  const address = SETTINGS['entity.address'].safeParse(rawAddress);
  if (!address.success || address.data === null) throw new IssuerIncompleteError('address');
  const pan = StoredEntityPanVatNoSchema.safeParse(rawPan);
  return {
    legalName,
    // A missing PAN prints nothing; it is not an error (a new entity may be pre-registration).
    panVatNo: pan.success ? pan.data : null,
    address: address.data,
  };
}

/** A document style that does not validate, whether built from settings or read back from the version row. */
export class DocumentStyleInvalidError extends Error {
  readonly kind = 'document_style_invalid';

  constructor() {
    super('The document style is not valid');
    this.name = 'DocumentStyleInvalidError';
  }
}

/**
 * Turns the logo document the profile references into the bytes a snapshot freezes, as a data URL. Null: the
 * document has no usable logo bytes. A throw means the lookup itself failed. The caller binds the tenant scope
 * (a closure over the same scope the snapshot is built for).
 */
export type DocumentLogoResolver = (documentId: string) => Promise<string | null>;

/** Resolves nothing: until the documents-backed resolver is wired, a snapshot uses the legacy logo, if any. */
export const NO_DOCUMENT_LOGO_RESOLVER: DocumentLogoResolver = () => Promise.resolve(null);

/** The resolver failed for a logo the profile does reference: freezing without it would print a logo-less document. */
export class DocumentLogoUnavailableError extends Error {
  readonly kind = 'document_logo_unavailable';

  constructor() {
    super('The company logo could not be read');
    this.name = 'DocumentLogoUnavailableError';
  }
}

/**
 * The logo bytes to freeze: the referenced document's when it resolves, else the not-yet-migrated legacy data
 * URL, else none. A resolver failure for a referenced logo is an error (the render retries later); no data from
 * the failure is carried, so nothing sensitive reaches a log.
 */
async function resolveSnapshotLogo(
  profile: CompanyProfile,
  resolveLogo: DocumentLogoResolver,
): Promise<string | null> {
  const legacy = profile.legacyLogoDataUrl ?? null;
  if (profile.logoDocumentId === null) return legacy;
  let resolved: string | null;
  try {
    resolved = await resolveLogo(profile.logoDocumentId);
  } catch {
    throw new DocumentLogoUnavailableError();
  }
  return resolved ?? legacy;
}

/**
 * The look of the document, as it stands in settings now: layout and colour, the company profile, the number
 * system. The first render of a version stores the result on the version (quotation_versions.document_style),
 * so a later settings change never alters a document that was already issued. The profile's PAN/VAT number
 * falls back to the entity's own setting, and its logo is frozen as bytes (see resolveSnapshotLogo). An invalid
 * value is an error, not a default: the result is stored for good, so a hand-edited bad row must not freeze a
 * wrong look onto an approved quotation.
 */
export async function buildDocumentStyleSnapshot(
  settings: IssuerSettings,
  scope: TxScope,
  capturedAt: Date,
  resolveLogo: DocumentLogoResolver = NO_DOCUMENT_LOGO_RESOLVER,
): Promise<DocumentStyleSnapshot> {
  const [style, profile, numberSystems, dateFormat, entityPan] = await Promise.all([
    settings.get(scope, 'document.style'),
    settings.get(scope, 'entity.profile'),
    settings.get(scope, 'format.number_systems'),
    settings.get(scope, 'format.date'),
    settings.get(scope, 'entity.pan_vat_no'),
  ]);
  const pan = StoredEntityPanVatNoSchema.safeParse(entityPan);
  const rawProfile = StoredCompanyProfileSchema.safeParse(profile);
  if (!rawProfile.success) throw new DocumentStyleInvalidError();
  const logo = await resolveSnapshotLogo(rawProfile.data, resolveLogo);
  const parsed = DocumentStyleSnapshotSchema.safeParse({
    style,
    profile: snapshotProfileFrom(
      {
        ...rawProfile.data,
        panVatNo: rawProfile.data.panVatNo ?? (pan.success ? pan.data : null),
      },
      logo,
    ),
    numberSystems,
    dateFormat,
    capturedAt: capturedAt.toISOString(),
  });
  if (!parsed.success) throw new DocumentStyleInvalidError();
  return parsed.data;
}

/** A snapshot read back from the version row, checked again: a row edited by hand is an error kind, not a crash. */
export function parseStoredDocumentStyle(stored: unknown): DocumentStyleSnapshot {
  const parsed = DocumentStyleSnapshotSchema.safeParse(stored);
  if (!parsed.success) throw new DocumentStyleInvalidError();
  return parsed.data;
}
