// The selling legal entity as a quotation shows it (ADR 0027: the acting organization is the legal entity).
// The legal name is the organization's own column; the PAN or VAT number and the address are per-entity settings
// (`entity.pan_vat_no`, `entity.address`), read through SettingsService for the entity's scope. An entity with no
// address is not ready to issue a quotation: that is a typed error, so the render job logs a fixed kind and the
// admin sees a clear reason, instead of a schema error that carries data.
import { SETTINGS } from '@bos/contracts';

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
