import {
  CreateVendorBodySchema,
  ProposeBankAccountBodySchema,
  VENDOR_KINDS,
  VendorContactBodySchema,
  type CreateVendorBody,
  type ProposeBankAccountBody,
  type VendorKind,
  type VendorStatus,
} from '@bos/contracts';
import type { ZodError } from 'zod';

import type { CreateVendorContact, UpdateVendorFields } from '@/lib/api-vendors';

import { identityLocked } from './model';

/**
 * Pure helpers for the vendor forms: read what was typed, check it with the contracts' schemas
 * and word every refusal for a person. The server action is the real gate; the browser's checks
 * are a courtesy. No server code, so a test or a Client Component can import this.
 */

export type FieldErrors<K extends string> = Partial<Record<K, string>>;

const PAN = /^[0-9]{9}$/;

function firstIssues<K extends string>(
  error: ZodError,
  words: Partial<Record<K, string>>,
  fields: readonly K[],
): FieldErrors<K> {
  const out: FieldErrors<K> = {};
  for (const issue of error.issues) {
    const field = issue.path[0];
    if (typeof field !== 'string' || !(fields as readonly string[]).includes(field)) continue;
    const key = field as K;
    if (out[key] === undefined) out[key] = words[key] ?? issue.message;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Vendor
// ---------------------------------------------------------------------------------------------

export interface VendorValues {
  legalName: string;
  tradeName: string;
  kind: string;
  pan: string;
  vatRegistered: boolean;
  country: string;
}
export type VendorField = keyof VendorValues;

export const EMPTY_VENDOR_VALUES: VendorValues = {
  legalName: '',
  tradeName: '',
  kind: 'company',
  pan: '',
  vatRegistered: false,
  country: 'NP',
};

export const VENDOR_FIELDS = Object.keys(EMPTY_VENDOR_VALUES) as VendorField[];

const isKind = (v: string): v is VendorKind => (VENDOR_KINDS as readonly string[]).includes(v);

const PAN_RULE = 'A PAN is 9 digits, for example 301234567.';
const VENDOR_WORDS: Partial<Record<VendorField, string>> = {
  legalName: 'Enter the legal name, up to 200 characters.',
  tradeName: 'The trade name can be up to 200 characters.',
  kind: 'Choose what kind of vendor this is.',
  pan: PAN_RULE,
  country: 'Use a two-letter country code, for example NP or IN.',
};

export function tidyVendorValues(raw: Partial<VendorValues>): VendorValues {
  return {
    legalName: (raw.legalName ?? '').trim(),
    tradeName: (raw.tradeName ?? '').trim(),
    kind: (raw.kind ?? '').trim(),
    pan: (raw.pan ?? '').replace(/\s+/g, ''),
    vatRegistered: raw.vatRegistered === true,
    country: (raw.country ?? '').trim().toUpperCase(),
  };
}

/**
 * The API's own cross-field rule (a vendor outside Nepal is `foreign`, a foreign vendor is not in
 * Nepal), told on the country field so the person fixes the right input.
 */
function kindCountry(kind: VendorKind, country: string): string | undefined {
  if (kind === 'foreign' && country === 'NP') {
    return 'A foreign vendor is outside Nepal. Use the vendor’s own country code, for example IN.';
  }
  if (kind !== 'foreign' && country !== 'NP') {
    return 'A vendor outside Nepal must be a foreign vendor. Change the kind, or use NP.';
  }
  return undefined;
}

export type ParsedCreate =
  { ok: true; data: CreateVendorBody } | { ok: false; errors: FieldErrors<VendorField> };

export function parseCreateVendor(input: VendorValues): ParsedCreate {
  const v = tidyVendorValues(input);
  const errors: FieldErrors<VendorField> = {};

  if (!isKind(v.kind)) errors.kind = VENDOR_WORDS.kind as string;
  // A foreign vendor has no Nepali PAN: it is never sent, whatever was typed before the kind changed.
  const foreign = v.kind === 'foreign';
  if (!foreign && v.pan === '') errors.pan = 'A PAN is required unless the vendor is foreign.';
  else if (!foreign && !PAN.test(v.pan)) errors.pan = PAN_RULE;
  if (isKind(v.kind)) {
    const problem = kindCountry(v.kind, v.country);
    if (problem !== undefined && /^[A-Z]{2}$/.test(v.country)) errors.country = problem;
  }

  const candidate = {
    legalName: v.legalName,
    ...(v.tradeName !== '' ? { tradeName: v.tradeName } : {}),
    kind: v.kind,
    ...(!foreign && v.pan !== '' ? { pan: v.pan } : {}),
    vatRegistered: v.vatRegistered,
    country: v.country,
  };
  const parsed = CreateVendorBodySchema.safeParse(candidate);
  if (!parsed.success) {
    const rest = firstIssues(parsed.error, VENDOR_WORDS, VENDOR_FIELDS);
    for (const [field, text] of Object.entries(rest) as [VendorField, string][]) {
      errors[field] ??= text;
    }
  }
  if (Object.keys(errors).length > 0 || !parsed.success) {
    return { ok: false, errors };
  }
  return { ok: true, data: parsed.data };
}

export type ParsedUpdate =
  | { ok: true; data: UpdateVendorFields }
  | { ok: false; nothingChanged: true }
  | { ok: false; errors: FieldErrors<VendorField> };

/**
 * Only what changed goes to the API, with the version the person was looking at. On an approved or
 * suspended vendor the legal name and PAN are ignored: those inputs are locked, and a crafted post
 * would only earn a 409.
 */
export function parseUpdateVendor(
  input: VendorValues,
  original: { legalName: string; pan: string | null; vatRegistered: boolean; status: VendorStatus },
  expectedVersion: number,
): ParsedUpdate {
  const v = tidyVendorValues(input);
  const errors: FieldErrors<VendorField> = {};
  const data: UpdateVendorFields = { expectedVersion };
  const locked = identityLocked(original.status);

  if (!locked && v.legalName !== original.legalName) {
    if (v.legalName === '' || v.legalName.length > 200)
      errors.legalName = VENDOR_WORDS.legalName as string;
    else data.legalName = v.legalName;
  }
  if (!locked && v.pan !== (original.pan ?? '')) {
    if (!PAN.test(v.pan)) errors.pan = PAN_RULE;
    else data.pan = v.pan;
  }
  if (v.vatRegistered !== original.vatRegistered) data.vatRegistered = v.vatRegistered;

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  if (Object.keys(data).length === 1) return { ok: false, nothingChanged: true };
  return { ok: true, data };
}

// ---------------------------------------------------------------------------------------------
// Contact
// ---------------------------------------------------------------------------------------------

export interface ContactValues {
  name: string;
  email: string;
  phone: string;
  role: string;
  isPortalAdmin: boolean;
}
export type ContactField = keyof ContactValues;
export const EMPTY_CONTACT_VALUES: ContactValues = {
  name: '',
  email: '',
  phone: '',
  role: '',
  isPortalAdmin: false,
};
const CONTACT_FIELDS = Object.keys(EMPTY_CONTACT_VALUES) as ContactField[];
const CONTACT_WORDS: Partial<Record<ContactField, string>> = {
  name: 'Enter the contact’s name, up to 120 characters.',
  email: 'Enter a valid email address, for example sita@example.com.',
  phone: 'Start with + and the country code, for example +9779812345678.',
  role: 'The role can be up to 80 characters.',
};

export type ParsedContact =
  { ok: true; data: CreateVendorContact } | { ok: false; errors: FieldErrors<ContactField> };

export function parseContact(input: ContactValues): ParsedContact {
  const candidate = {
    name: input.name.trim(),
    ...(input.email.trim() !== '' ? { email: input.email.trim() } : {}),
    ...(input.phone.trim() !== '' ? { phone: input.phone.trim() } : {}),
    ...(input.role.trim() !== '' ? { role: input.role.trim() } : {}),
    isPortalAdmin: input.isPortalAdmin,
  };
  const parsed = VendorContactBodySchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, errors: firstIssues(parsed.error, CONTACT_WORDS, CONTACT_FIELDS) };
  }
  return { ok: true, data: parsed.data };
}

// ---------------------------------------------------------------------------------------------
// Bank account
// ---------------------------------------------------------------------------------------------

export interface BankValues {
  bankName: string;
  branch: string;
  accountName: string;
  accountNumber: string;
  swift: string;
}
export type BankField = keyof BankValues;
export const EMPTY_BANK_VALUES: BankValues = {
  bankName: '',
  branch: '',
  accountName: '',
  accountNumber: '',
  swift: '',
};
const BANK_FIELDS = Object.keys(EMPTY_BANK_VALUES) as BankField[];
const BANK_WORDS: Partial<Record<BankField, string>> = {
  bankName: 'Enter the bank’s name, up to 120 characters.',
  branch: 'The branch can be up to 120 characters.',
  accountName: 'Enter the name the account is held in, up to 160 characters.',
  accountNumber: 'Use 6 to 34 letters, digits or hyphens.',
  swift: 'A SWIFT code is 8 or 11 letters and digits.',
};

export type ParsedBank =
  { ok: true; data: ProposeBankAccountBody } | { ok: false; errors: FieldErrors<BankField> };

/** Spaces in the account number are dropped before checking, as the API does. */
export function parseProposeBank(input: BankValues): ParsedBank {
  const candidate = {
    bankName: input.bankName.trim(),
    ...(input.branch.trim() !== '' ? { branch: input.branch.trim() } : {}),
    accountName: input.accountName.trim(),
    accountNumber: input.accountNumber.replace(/\s+/g, ''),
    ...(input.swift.trim() !== '' ? { swift: input.swift.replace(/\s+/g, '') } : {}),
  };
  const parsed = ProposeBankAccountBodySchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, errors: firstIssues(parsed.error, BANK_WORDS, BANK_FIELDS) };
  }
  return { ok: true, data: parsed.data };
}

// ---------------------------------------------------------------------------------------------
// Reason (suspend, block, archive, reject a bank account)
// ---------------------------------------------------------------------------------------------

export function parseReason(
  raw: string,
): { ok: true; data: string } | { ok: false; error: string } {
  const reason = raw.trim();
  if (reason === '') return { ok: false, error: 'Say why, so the audit trail keeps it.' };
  if (reason.length > 500) return { ok: false, error: 'Keep the reason to 500 characters.' };
  return { ok: true, data: reason };
}
