// Pure rules of the vendors service (no database): the kind mapping between the API and the table, the foreign
// versus country rule, the party code, the KYC expiry check and the lifecycle moves. Kept apart from the service
// so each rule has a unit test that needs no Postgres.
import {
  type AddressLines,
  canTransitionVendor,
  type CountryCode,
  isCountryCode,
  nepalPanProblem,
  type PartyPhone,
  type PartyPhoneInput,
  type PhoneLabel,
  type VendorKind,
  type VendorStatus,
} from '@bos/contracts';

import { normalizeName } from '../customers/customers.normalize';
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
 * Why `pan` is not a PAN for a vendor in `country`, or undefined (FX9). Only a Nepal vendor is held to nine digits;
 * a foreign vendor's tax id keeps the loose `PanVatNoSchema` shape. A 400, so the answer is not a 500.
 */
export function vendorPanProblem(
  country: string,
  pan: string | null | undefined,
): string | undefined {
  return nepalPanProblem(country, pan) ?? undefined;
}

/** A stored ISO country as the contract's type. The columns CHECK the shape; an unknown code is a bug, not data. */
export function rowCountry(code: string): CountryCode {
  if (!isCountryCode(code)) throw new Error(`unknown country code ${code} on a stored vendor row`);
  return code;
}

/** The vendor's address as the DTO carries it: both columns, or null when the vendor has none (FX9). */
export function addressFromRow(row: {
  addressLine: string | null;
  addressCity: string | null;
}): AddressLines | null {
  return row.addressLine === null || row.addressCity === null
    ? null
    : { line: row.addressLine, city: row.addressCity };
}

/** The address columns for `address`: both set, or both null (`vendors_address_check`). */
export function addressColumns(address: AddressLines | null | undefined): {
  addressLine: string | null;
  addressCity: string | null;
} {
  return address === null || address === undefined
    ? { addressLine: null, addressCity: null }
    : { addressLine: address.line, addressCity: address.city };
}

/** One stored phone row of a contact, as far as the API reads it back. */
export interface PhoneRow {
  country: string;
  e164: string;
  label: PhoneLabel | null;
  sortOrder: number;
  isPrimary: boolean;
}

/** The phone rows a contact's phone list is stored as, in the order sent (`sortOrder` is the position). */
export function phoneRowsOf(phones: readonly PartyPhoneInput[]): PhoneRow[] {
  return phones.map((phone, index) => ({
    country: phone.country,
    e164: phone.e164,
    label: phone.label ?? null,
    sortOrder: index,
    isPrimary: phone.isPrimary,
  }));
}

/** A contact's phones as the DTO carries them: the primary first, then the rest in their stored order. */
export function phonesOfRows(rows: readonly PhoneRow[]): PartyPhone[] {
  return [...rows]
    .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.sortOrder - b.sortOrder)
    .map((row) => ({
      country: rowCountry(row.country),
      e164: row.e164,
      label: row.label,
      isPrimary: row.isPrimary,
    }));
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

/** A KYB case in one of these statuses lets a pending_kyc vendor go under review (409 `kyb_not_submitted` otherwise). */
export function kybReadyForReview(caseStatus: string | undefined): boolean {
  return caseStatus === 'submitted' || caseStatus === 'approved';
}

/**
 * The move `submit-kyc` makes from `current`, checked against the status the caller's button was drawn for. One
 * endpoint makes two moves (draft -> pending_kyc, pending_kyc -> under_review), so a stale "Start KYB review" from a
 * second tab would otherwise run "Send for review". `expected` absent means the caller did not say (older callers).
 * The KYB case check of pending_kyc -> under_review needs the database and stays in the service.
 */
export function submitKycMove(
  current: VendorStatus,
  expected: VendorStatus | undefined,
):
  | { ok: true; to: 'pending_kyc' | 'under_review' }
  | { ok: false; kind: 'stale' | 'invalid'; message: string } {
  if (expected !== undefined && expected !== current) {
    return {
      ok: false,
      kind: 'stale',
      message: 'This vendor was changed by someone else; reload it and try again',
    };
  }
  if (current === 'draft') return { ok: true, to: 'pending_kyc' };
  if (current === 'pending_kyc') return { ok: true, to: 'under_review' };
  return { ok: false, kind: 'invalid', message: `A vendor in status ${current} cannot submit KYC` };
}

/**
 * What two vendor names are compared on for the duplicate warning (TR-Q12d): the customers' name key (case, spaces,
 * punctuation and company-form words such as "Pvt. Ltd." do not count), so both directories match names alike.
 * Empty for a name with no letters or digits, which matches nothing.
 */
export function vendorNameKey(name: string): string {
  return normalizeName(name);
}

/** The rows whose legal name has the same key as `name`, in their order; none when `name` has no key. */
export function sameNameVendors<T extends { legalName: string }>(
  name: string,
  rows: readonly T[],
): T[] {
  const key = vendorNameKey(name);
  if (key === '') return [];
  return rows.filter((r) => vendorNameKey(r.legalName) === key);
}
