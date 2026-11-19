// The selling legal entity as a quotation shows it (ADR 0027: the acting organization is the legal entity).
// The legal name is the organization's own column; the PAN or VAT number and the address are per-entity settings
// (`entity.pan_vat_no`, `entity.address`), read through SettingsService for the entity's scope. An entity with no
// address is not ready to issue a quotation: that is a typed error, so the render job logs a fixed kind and the
// admin sees a clear reason, instead of a schema error that carries data.
import { DocumentStyleSnapshotSchema, SETTINGS, type DocumentStyleSnapshot } from '@bos/contracts';

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
  const pan = SETTINGS['entity.pan_vat_no'].safeParse(rawPan);
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
 * The look of the document, as it stands in settings now: layout and colour, the company profile, the number
 * system. The first render of a version stores the result on the version (quotation_versions.document_style),
 * so a later settings change never alters a document that was already issued. The profile's PAN/VAT number
 * falls back to the entity's own setting. An invalid value is an error, not a default: the result is stored
 * for good, so a hand-edited bad row must not freeze a wrong look onto an approved quotation.
 */
export async function buildDocumentStyleSnapshot(
  settings: IssuerSettings,
  scope: TxScope,
  capturedAt: Date,
): Promise<DocumentStyleSnapshot> {
  const [style, profile, numberSystems, dateFormat, entityPan] = await Promise.all([
    settings.get(scope, 'document.style'),
    settings.get(scope, 'entity.profile'),
    settings.get(scope, 'format.number_systems'),
    settings.get(scope, 'format.date'),
    settings.get(scope, 'entity.pan_vat_no'),
  ]);
  const pan = SETTINGS['entity.pan_vat_no'].safeParse(entityPan);
  const rawProfile = SETTINGS['entity.profile'].safeParse(profile);
  if (!rawProfile.success) throw new DocumentStyleInvalidError();
  const parsed = DocumentStyleSnapshotSchema.safeParse({
    style,
    profile: {
      ...rawProfile.data,
      panVatNo: rawProfile.data.panVatNo ?? (pan.success ? pan.data : null),
    },
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
