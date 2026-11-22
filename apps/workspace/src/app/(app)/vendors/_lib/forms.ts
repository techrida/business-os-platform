import {
  CreateVendorBodySchema,
  PHONE_LABELS,
  type PhoneLabel,
  ProposeBankAccountBodySchema,
  VENDOR_KINDS,
  VendorContactBodySchema,
  type CreateVendorBody,
  type ProposeBankAccountBody,
  type VendorKind,
  type VendorStatus,
} from '@bos/contracts';
import type { ZodError } from 'zod';

import { rawPhoneRows } from '@/components/ui/phone-rows';
import type { CreateVendorContact, UpdateVendorFields } from '@/lib/api-vendors';

import { identityLocked } from './model';

/**
 * Pure helpers for the vendor forms: read what was typed, check it with the contracts' schemas
 * and word every refusal for a person. The server action is the real gate; the browser's checks
 * are a courtesy. No server code, so a test or a Client Component can import this.
 */

export type FieldErrors<K extends string> = Partial<Record<K, string>>;

const PAN = /^[0-9]{9}$/;
/** A foreign vendor's tax id: the contracts' loose `PanVatNoSchema` shape. */
const TAX_ID = /^[A-Za-z0-9-]{5,20}$/;
const LINE_MAX = 500;
const CITY_MAX = 100;

function formText(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
}

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
  /** ISO 3166-1 alpha-2. Fixed once the vendor is added; it is also the address's country. */
  country: string;
  /** The street lines and city: both or neither (the address is optional). */
  addressLine: string;
  addressCity: string;
}
export type VendorField = keyof VendorValues;

export const EMPTY_VENDOR_VALUES: VendorValues = {
  legalName: '',
  tradeName: '',
  kind: 'company',
  pan: '',
  vatRegistered: false,
  country: 'NP',
  addressLine: '',
  addressCity: '',
};

export const VENDOR_FIELDS = Object.keys(EMPTY_VENDOR_VALUES) as VendorField[];

/**
 * The name each value posts under. The address posts through `AddressFields` named `address`, whose Country is the
 * vendor's country (shown once, on create; edit shows it as fixed text and posts none).
 */
export const VENDOR_POSTED_NAME: Readonly<Record<VendorField, string>> = {
  legalName: 'legalName',
  tradeName: 'tradeName',
  kind: 'kind',
  pan: 'pan',
  vatRegistered: 'vatRegistered',
  country: 'address.country',
  addressLine: 'address.line',
  addressCity: 'address.city',
};

/** What the vendor form posted, tidied. The one reader the server action and the tests share. */
export function readVendorValues(form: FormData): VendorValues {
  const raw: Partial<VendorValues> = {};
  for (const field of VENDOR_FIELDS) {
    const posted = formText(form, VENDOR_POSTED_NAME[field]);
    if (field === 'vatRegistered') raw.vatRegistered = posted === 'on';
    else raw[field] = posted;
  }
  return tidyVendorValues(raw);
}

const isKind = (v: string): v is VendorKind => (VENDOR_KINDS as readonly string[]).includes(v);

const PAN_RULE = 'A PAN is 9 digits, for example 301234567.';
const TAX_ID_RULE = 'A tax ID is 5 to 20 letters, digits or hyphens.';
const VENDOR_WORDS: Partial<Record<VendorField, string>> = {
  legalName: 'Enter the legal name, up to 200 characters.',
  tradeName: 'The trade name can be up to 200 characters.',
  kind: 'Choose what kind of vendor this is.',
  pan: PAN_RULE,
  country: 'Choose the vendor’s country.',
  addressLine: `Enter the street address, up to ${LINE_MAX} characters.`,
  addressCity: `Enter the city, up to ${CITY_MAX} characters.`,
};

export function tidyVendorValues(raw: Partial<VendorValues>): VendorValues {
  return {
    legalName: (raw.legalName ?? '').trim(),
    tradeName: (raw.tradeName ?? '').trim(),
    kind: (raw.kind ?? '').trim(),
    pan: (raw.pan ?? '').replace(/\s+/g, ''),
    vatRegistered: raw.vatRegistered === true,
    country: (raw.country ?? '').trim().toUpperCase(),
    addressLine: (raw.addressLine ?? '').trim(),
    addressCity: (raw.addressCity ?? '').trim(),
  };
}

/** The address is optional, but a street without a city (or a city without a street) is half an address. */
function addressErrors(v: VendorValues): FieldErrors<VendorField> {
  const errors: FieldErrors<VendorField> = {};
  if (v.addressLine !== '' && v.addressCity === '') {
    errors.addressCity = 'Enter the city too, or clear the address.';
  } else if (v.addressLine === '' && v.addressCity !== '') {
    errors.addressLine = 'Enter the street address too, or clear the city.';
  }
  if (v.addressLine.length > LINE_MAX) errors.addressLine = VENDOR_WORDS.addressLine as string;
  if (v.addressCity.length > CITY_MAX) errors.addressCity = VENDOR_WORDS.addressCity as string;
  return errors;
}

const hasAddress = (v: VendorValues): boolean => v.addressLine !== '' && v.addressCity !== '';

/**
 * The API's own cross-field rule (a vendor outside Nepal is `foreign`, a foreign vendor is not in
 * Nepal), told on the country field so the person fixes the right input.
 */
function kindCountry(kind: VendorKind, country: string): string | undefined {
  if (kind === 'foreign' && country === 'NP') {
    return 'A foreign vendor is outside Nepal. Choose the vendor’s own country.';
  }
  if (kind !== 'foreign' && country !== 'NP') {
    return 'A vendor outside Nepal must be a foreign vendor. Change the kind, or choose Nepal.';
  }
  return undefined;
}

export type ParsedCreate =
  { ok: true; data: CreateVendorBody } | { ok: false; errors: FieldErrors<VendorField> };

export function parseCreateVendor(input: VendorValues): ParsedCreate {
  const v = tidyVendorValues(input);
  const errors: FieldErrors<VendorField> = {};

  if (!isKind(v.kind)) errors.kind = VENDOR_WORDS.kind as string;
  // A Nepal vendor's PAN is nine digits and required; a foreign vendor may give its own tax id, in the loose shape.
  const foreign = v.kind === 'foreign';
  if (!foreign && v.pan === '') errors.pan = 'A PAN is required unless the vendor is foreign.';
  else if (!foreign && !PAN.test(v.pan)) errors.pan = PAN_RULE;
  else if (foreign && v.pan !== '' && !TAX_ID.test(v.pan)) errors.pan = TAX_ID_RULE;
  Object.assign(errors, addressErrors(v));
  if (isKind(v.kind)) {
    const problem = kindCountry(v.kind, v.country);
    if (problem !== undefined && /^[A-Z]{2}$/.test(v.country)) errors.country = problem;
  }

  const candidate = {
    legalName: v.legalName,
    ...(v.tradeName !== '' ? { tradeName: v.tradeName } : {}),
    kind: v.kind,
    ...(v.pan !== '' ? { pan: v.pan } : {}),
    vatRegistered: v.vatRegistered,
    country: v.country,
    ...(hasAddress(v) ? { address: { line: v.addressLine, city: v.addressCity } } : {}),
  };
  const parsed = CreateVendorBodySchema.safeParse(candidate);
  if (!parsed.success) {
    // An address issue's path is `address.line` or `address.city`; it is told on that field.
    for (const issue of parsed.error.issues) {
      if (issue.path[0] !== 'address') continue;
      const field: VendorField = issue.path[1] === 'city' ? 'addressCity' : 'addressLine';
      errors[field] ??= VENDOR_WORDS[field] as string;
    }
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
 * would only earn a 409. The country is fixed, so it is read from the vendor, never the post: it decides
 * whether the PAN is a Nepal PAN (nine digits) or a foreign tax id. A cleared address is sent as null.
 */
export function parseUpdateVendor(
  input: VendorValues,
  original: {
    legalName: string;
    pan: string | null;
    vatRegistered: boolean;
    status: VendorStatus;
    country: string;
    address: { line: string; city: string } | null;
  },
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
    if (original.country === 'NP') {
      if (!PAN.test(v.pan)) errors.pan = PAN_RULE;
      else data.pan = v.pan;
    } else if (v.pan === '') {
      errors.pan = 'A saved tax ID cannot be removed. Enter the vendor’s tax ID.';
    } else if (!TAX_ID.test(v.pan)) {
      errors.pan = TAX_ID_RULE;
    } else data.pan = v.pan;
  }
  const before = original.address ?? { line: '', city: '' };
  if (v.addressLine !== before.line || v.addressCity !== before.city) {
    const problems = addressErrors(v);
    if (Object.keys(problems).length > 0) Object.assign(errors, problems);
    else data.address = hasAddress(v) ? { line: v.addressLine, city: v.addressCity } : null;
  }
  if (v.vatRegistered !== original.vatRegistered) data.vatRegistered = v.vatRegistered;

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  if (Object.keys(data).length === 1) return { ok: false, nothingChanged: true };
  return { ok: true, data };
}

// ---------------------------------------------------------------------------------------------
// Contact
// ---------------------------------------------------------------------------------------------

/** One posted phone row, before the contracts check it. */
export interface PhoneDraft {
  country: string;
  e164: string;
  label: PhoneLabel | null;
  isPrimary: boolean;
}

/**
 * The phone rows a `PhoneListInput` named `name` posted (`<name>.<i>.number`, `.country`, `.label`, `.isPrimary`),
 * in order. A row left blank is dropped; a row with a number, valid or not, is kept for the contracts to judge. When
 * the primary row was the blank one, the first number left becomes primary.
 */
export function readPhones(form: FormData, name: string): PhoneDraft[] {
  const out: PhoneDraft[] = rawPhoneRows(form, name).map(
    ({ country, number, label, isPrimary }) => ({
      country: country.toUpperCase(),
      e164: number,
      label: (PHONE_LABELS as readonly string[]).includes(label) ? (label as PhoneLabel) : null,
      isPrimary,
    }),
  );
  const first = out[0];
  if (first !== undefined && !out.some((p) => p.isPrimary)) first.isPrimary = true;
  return out;
}

export interface ContactValues {
  name: string;
  email: string;
  /** The contact's own country (ISO-2); it may differ from the vendor's. */
  country: string;
  phones: PhoneDraft[];
  role: string;
  isPortalAdmin: boolean;
}
export type ContactField = keyof ContactValues;
export const EMPTY_CONTACT_VALUES: ContactValues = {
  name: '',
  email: '',
  country: 'NP',
  phones: [],
  role: '',
  isPortalAdmin: false,
};
const CONTACT_FIELDS = Object.keys(EMPTY_CONTACT_VALUES) as ContactField[];
const CONTACT_WORDS: Partial<Record<ContactField, string>> = {
  name: 'Enter the contact’s name, up to 120 characters.',
  email: 'Enter a valid email address, for example sita@example.com.',
  country: 'Choose the contact’s country.',
  role: 'The role can be up to 80 characters.',
};

/** What the contact form posted. The one reader the server action and the tests share. */
export function readContactValues(form: FormData): ContactValues {
  return {
    name: formText(form, 'name'),
    email: formText(form, 'email'),
    country: formText(form, 'country'),
    phones: readPhones(form, 'phones'),
    role: formText(form, 'role'),
    isPortalAdmin: formText(form, 'isPortalAdmin') === 'on',
  };
}

const sentence = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;

export type ParsedContact =
  { ok: true; data: CreateVendorContact } | { ok: false; errors: FieldErrors<ContactField> };

export function parseContact(input: ContactValues): ParsedContact {
  const candidate = {
    name: input.name.trim(),
    ...(input.email.trim() !== '' ? { email: input.email.trim() } : {}),
    country: input.country.trim().toUpperCase(),
    phones: input.phones.map((p) => ({
      country: p.country,
      e164: p.e164,
      ...(p.label !== null ? { label: p.label } : {}),
      isPrimary: p.isPrimary,
    })),
    ...(input.role.trim() !== '' ? { role: input.role.trim() } : {}),
    isPortalAdmin: input.isPortalAdmin,
  };
  const parsed = VendorContactBodySchema.safeParse(candidate);
  if (!parsed.success) {
    const errors = firstIssues(parsed.error, CONTACT_WORDS, CONTACT_FIELDS);
    // A phone issue names its row when it has one: "Phone 2: not a valid United States number."
    const phone = parsed.error.issues.find((issue) => issue.path[0] === 'phones');
    if (phone !== undefined) {
      const row = phone.path[1];
      errors.phones =
        typeof row === 'number' ? `Phone ${row + 1}: ${phone.message}.` : sentence(phone.message);
    }
    return { ok: false, errors };
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
