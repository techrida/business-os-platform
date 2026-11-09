// Pure rules of the vendors service (no database): the kind mapping between the API and the table, the foreign
// versus country rule, the party code, the KYC expiry check and the lifecycle moves. Kept apart from the service
// so each rule has a unit test that needs no Postgres.
import { canTransitionVendor, type VendorKind, type VendorStatus } from '@bos/contracts';

import { kathmanduDay } from '../quotations/reference/reference.types';

/** The table's `kind` values (0032 CHECK). They differ from the API's only for the sole proprietor. */
export type VendorRowKind = 'company' | 'proprietor' | 'individual' | 'foreign';

export function kindToRow(kind: VendorKind): VendorRowKind {
  return kind === 'sole_proprietor' ? 'proprietor' : kind;
}

export function kindFromRow(kind: string): VendorKind {
  return kind === 'proprietor' ? 'sole_proprietor' : (kind as VendorKind);
}

/** The 0032 CHECK `(kind = 'foreign') = (country <> 'NP')`, as a message so the API answers 400, not a 500. */
export function kindCountryProblem(kind: VendorKind, country: string): string | undefined {
  if (kind === 'foreign' && country === 'NP') return 'a foreign vendor cannot have country NP';
  if (kind !== 'foreign' && country !== 'NP')
    return 'a vendor outside Nepal must have kind foreign';
  return undefined;
}

/**
 * The code of a vendor party (parties.code is NOT NULL and unique per tenant; a vendor has no numbered series).
 * Derived from the id the vendor is created with, so two creates never collide in practice.
 */
export function vendorPartyCode(id: string): string {
  return `VEN-${id.replaceAll('-', '').slice(0, 12).toUpperCase()}`;
}

/** The statuses from which each lifecycle command may run, and the status it leads to. */
export const LIFECYCLE = {
  activate: { to: 'approved', from: ['under_review', 'suspended'] },
  suspend: { to: 'suspended', from: ['approved'] },
  block: { to: 'blocked', from: ['approved', 'suspended'] },
  archive: { to: 'archived', from: ['blocked'] },
} as const satisfies Record<string, { to: VendorStatus; from: readonly VendorStatus[] }>;
export type LifecycleCommand = keyof typeof LIFECYCLE;

/** True when the contract's state machine allows `from` -> the target of `command`. */
export function lifecycleAllowed(command: LifecycleCommand, from: VendorStatus): boolean {
  const { to } = LIFECYCLE[command];
  return (
    (LIFECYCLE[command].from as readonly VendorStatus[]).includes(from) &&
    canTransitionVendor(from, to)
  );
}

/** A checklist item as the vendor KYB case stores it (only what the expiry check reads). */
export interface KycItem {
  key: string;
  expiresOn: string | null;
}

/** The tax clearance is per fiscal year: it lapses the day after `expiresOn` (both `YYYY-MM-DD`). */
export function lapsedTaxClearance(items: readonly KycItem[], today: string): boolean {
  return items.some(
    (i) => i.key === 'tax_clearance' && i.expiresOn !== null && i.expiresOn < today,
  );
}

/** The calendar day (`YYYY-MM-DD`) in Asia/Kathmandu at `instant`: the business date a tax clearance is read against. */
export const isoDay = kathmanduDay;
