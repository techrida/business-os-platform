import {
  CreateContactBodySchema,
  CreateCustomerBodySchema,
  CUSTOMER_RELATIONSHIPS,
  CURRENCIES,
  CustomerFieldsSchema,
  DEFAULT_COUNTRY,
  MAX_PARTY_PHONES,
  nepalPanProblem,
  type CreateContactBody,
  type CreateCustomerBody,
  type CustomerDto,
  type UpdateCustomerBody,
} from '@bos/contracts';

/**
 * Pure helpers for the customer and contact forms: read what was typed, check it with the
 * contracts' schemas, and word every refusal for a person. No server code, so a test or a Client
 * Component can use it. The server action is the real gate; the browser's checks are a courtesy.
 */

export type FieldErrors<K extends string> = Partial<Record<K, string>>;

/**
 * Refusals about a person's phone list. `phones` is about the list as a whole (no primary, too many
 * numbers); `phoneRows[i]` is about the row the form posted at position `i` (its original index, so
 * blank rows that were skipped do not shift the errors onto the wrong row).
 */
export interface PhoneErrors {
  phones?: string;
  phoneRows?: (string | undefined)[];
}

/** One phone row a form posted (`<name>.<i>.number|country|label|isPrimary`), blank rows left out. */
export interface PhoneRow {
  country: string;
  e164: string;
  label?: string;
  isPrimary: boolean;
  /** The row's position in the form, for putting a refusal back on the right row. */
  index: number;
}

/**
 * A phone with the punctuation people type removed: spaces, hyphens, dots and brackets. It never
 * guesses a country code: "9812345678" stays as typed and is refused with an example, because a
 * wrong guess would store someone else's number.
 */
export function normalizePhone(raw: string): string {
  return raw.replace(/[\s().-]+/g, '');
}

const ROW_FIELD = /^(\d+)\.(number|country|label|isPrimary)$/;

/**
 * The phone rows `PhoneListInput name={name}` posted, in row order. A row with no number is left out
 * (an untouched blank row is not a phone). When no remaining row is marked primary, the first one is,
 * as the list itself does: the primary radio may sit on a blank row that was just skipped.
 */
export function readPhoneRows(form: FormData, name: string): PhoneRow[] {
  const prefix = `${name}.`;
  const indexes = new Set<number>();
  for (const key of form.keys()) {
    if (!key.startsWith(prefix)) continue;
    const match = ROW_FIELD.exec(key.slice(prefix.length));
    if (match) indexes.add(Number(match[1]));
  }
  const read = (index: number, field: string): string => {
    const v = form.get(`${prefix}${index}.${field}`);
    return typeof v === 'string' ? v.trim() : '';
  };
  const rows: PhoneRow[] = [];
  for (const index of [...indexes].sort((a, b) => a - b)) {
    const e164 = normalizePhone(read(index, 'number'));
    if (e164 === '') continue;
    const label = read(index, 'label');
    rows.push({
      country: read(index, 'country').toUpperCase(),
      e164,
      ...(label !== '' ? { label } : {}),
      isPrimary: read(index, 'isPrimary') === 'true',
      index,
    });
  }
  const first = rows[0];
  if (first !== undefined && !rows.some((row) => row.isPrimary)) first.isPrimary = true;
  return rows;
}

/** The rows as the contract's `phones` list. */
function phonesBody(rows: readonly PhoneRow[]): Record<string, unknown>[] {
  return rows.map((row) => ({
    country: row.country,
    e164: row.e164,
    ...(row.label !== undefined ? { label: row.label } : {}),
    isPrimary: row.isPrimary,
  }));
}

const sentence = (message: string): string => {
  const s = message.trim();
  if (s === '') return s;
  const capital = `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
};

/** A row refusal in words: the contracts' messages, as sentences, with the technical one replaced. */
function rowMessage(field: PropertyKey | undefined, message: string): string {
  if (field === 'country') return "Choose this number's country from the list.";
  if (field === 'label') return 'Choose a label from the list, or no label.';
  if (/E\.164/.test(message)) {
    return 'Enter the whole number with its country code, for example +9779812345678.';
  }
  if (/listed twice/.test(message)) return 'This number is already listed.';
  return sentence(message);
}

/**
 * Puts one phone issue (its path starts after `phones`) on `errors`. `rest[0]` is the position in
 * the list that was checked, which is the position in `rows`.
 */
function addPhoneIssue(
  errors: PhoneErrors,
  rows: readonly PhoneRow[],
  rest: readonly PropertyKey[],
  issue: { code?: string; message: string },
): void {
  const [at, field] = rest;
  const row = typeof at === 'number' ? rows[at] : undefined;
  if (row === undefined) {
    errors.phones ??=
      issue.code === 'too_big'
        ? `Add up to ${MAX_PARTY_PHONES} numbers.`
        : sentence(issue.message || 'Check the phone numbers.');
    return;
  }
  const list = errors.phoneRows ?? [];
  list[row.index] ??= rowMessage(field, issue.message);
  errors.phoneRows = Array.from({ length: list.length }, (_, i) => list[i]);
}

/** The words for a PAN that does not suit the party's country. */
function panMessage(country: string): string {
  return country === 'NP'
    ? 'A Nepal PAN is 9 digits, for example 301234567.'
    : 'Use 5 to 20 letters, digits or hyphens, for example 301234567.';
}

const clean = (v: string): string => v.trim();
const blankToUndefined = (v: string): string | undefined => (v === '' ? undefined : v);

// ---------------------------------------------------------------------------------------------
// Customer
// ---------------------------------------------------------------------------------------------

export interface CustomerValues {
  legalName: string;
  panVatNo: string;
  industry: string;
  relationship: string;
  defaultCurrency: string;
  /** The street lines (`address.line`) and city (`address.city`). */
  line: string;
  city: string;
  /** The customer's country (posted as `address.country`). Its PAN rule follows it. */
  country: string;
  /**
   * The first contact, asked for on create only (the edit form leaves these blank and never sends
   * them). Its email is required: quotations are sent by email. Its phones are posted as
   * `contactPhones` rows and read with `readPhoneRows`.
   */
  contactName: string;
  contactEmail: string;
  contactTitle: string;
  contactCountry: string;
}
export type CustomerField = keyof CustomerValues;
export type CustomerErrors = FieldErrors<CustomerField> & PhoneErrors;

export const EMPTY_CUSTOMER_VALUES: CustomerValues = {
  legalName: '',
  panVatNo: '',
  industry: '',
  relationship: 'prospect',
  defaultCurrency: '',
  line: '',
  city: '',
  country: DEFAULT_COUNTRY,
  contactName: '',
  contactEmail: '',
  contactTitle: '',
  contactCountry: DEFAULT_COUNTRY,
};

export const CUSTOMER_FIELDS = Object.keys(EMPTY_CUSTOMER_VALUES) as CustomerField[];

/** Longest allowed text per field, from the contract. */
const MAX: Partial<Record<CustomerField, number>> = {
  legalName: 200,
  industry: 100,
  line: 300,
  city: 100,
  contactName: 200,
  contactEmail: 254,
  contactTitle: 100,
};

const REQUIRED: Partial<Record<CustomerField, string>> = {
  legalName: "Enter the company's legal name.",
  line: 'Enter the address, such as the street or area.',
  city: 'Enter the city.',
  country: "Choose the company's country.",
  contactName: "Enter the main contact's full name.",
  contactEmail: "Enter the main contact's email. Quotations are sent to it.",
  contactCountry: "Choose the main contact's country.",
};

const INVALID: Record<CustomerField, string> = {
  legalName: "Enter the company's legal name.",
  panVatNo: 'Use 5 to 20 letters, digits or hyphens, for example 301234567.',
  industry: 'Enter the industry in words.',
  relationship: `Choose one of: ${CUSTOMER_RELATIONSHIPS.join(', ')}.`,
  defaultCurrency: `Choose one of: ${CURRENCIES.join(', ')}.`,
  line: 'Enter the address.',
  city: 'Enter the city.',
  country: 'Choose a country from the list.',
  contactName: "Enter the contact's full name, up to 200 characters.",
  contactEmail: 'Enter an email address like name@company.com.',
  contactTitle: 'Use up to 100 characters for the job title.',
  contactCountry: 'Choose a country from the list.',
};

/** A contract path under `contact` (the first contact) and the form field it belongs to. */
const CONTACT_PATH: Record<string, CustomerField> = {
  fullName: 'contactName',
  email: 'contactEmail',
  title: 'contactTitle',
  country: 'contactCountry',
};

/** What a person typed, tidied: trimmed and the countries in capitals. */
export function tidyCustomerValues(raw: Partial<CustomerValues>): CustomerValues {
  const out = { ...EMPTY_CUSTOMER_VALUES };
  for (const key of CUSTOMER_FIELDS) out[key] = clean(raw[key] ?? '');
  out.country = out.country.toUpperCase();
  out.contactCountry = out.contactCountry.toUpperCase();
  return out;
}

/** The form values of a saved customer, for the edit form. */
export function valuesOfCustomer(c: CustomerDto): CustomerValues {
  return {
    legalName: c.legalName,
    panVatNo: c.panVatNo ?? '',
    industry: c.industry ?? '',
    relationship: c.relationship,
    defaultCurrency: c.defaultCurrency ?? '',
    line: c.address.line,
    city: c.address.city,
    country: c.country,
    contactName: '',
    contactEmail: '',
    contactTitle: '',
    contactCountry: c.country,
  };
}

/** The first contact of a new customer. Blank optional fields are left out. */
function firstContactBody(v: CustomerValues, phones: readonly PhoneRow[]): Record<string, unknown> {
  return {
    fullName: v.contactName,
    email: v.contactEmail,
    country: v.contactCountry,
    phones: phonesBody(phones),
    title: blankToUndefined(v.contactTitle),
  };
}

/** The contract body for these values. Blank optional fields are left out (the schema rejects ''). */
function customerBody(v: CustomerValues): Record<string, unknown> {
  return {
    legalName: v.legalName,
    panVatNo: blankToUndefined(v.panVatNo),
    industry: blankToUndefined(v.industry),
    relationship: v.relationship,
    defaultCurrency: blankToUndefined(v.defaultCurrency),
    country: v.country,
    address: { line: v.line, city: v.city },
  };
}

/** The contract path's form field, or a phone issue (put straight on `errors`). */
function customerFieldOf(path: readonly PropertyKey[]): CustomerField | 'phones' | undefined {
  const [first, second] = path;
  if (first === 'address') return second === 'city' ? 'city' : 'line';
  if (first === 'contact') {
    if (second === 'phones') return 'phones';
    // A missing contact object is reported on its first required field.
    return typeof second === 'string' ? CONTACT_PATH[second] : 'contactName';
  }
  return typeof first === 'string' && (CUSTOMER_FIELDS as string[]).includes(first)
    ? (first as CustomerField)
    : undefined;
}

function customerErrors(
  values: CustomerValues,
  phones: readonly PhoneRow[],
  issues: readonly { path: PropertyKey[]; code?: string; message: string }[],
): CustomerErrors {
  const errors: CustomerErrors = {};
  for (const issue of issues) {
    const field = customerFieldOf(issue.path);
    if (field === 'phones') {
      addPhoneIssue(errors, phones, issue.path.slice(2), issue);
      continue;
    }
    if (field === undefined || errors[field]) continue;
    const value = values[field];
    const max = MAX[field];
    errors[field] =
      value === '' && REQUIRED[field]
        ? REQUIRED[field]
        : field === 'panVatNo'
          ? panMessage(values.country)
          : max !== undefined && value.length > max
            ? `Use ${max} characters or fewer.`
            : INVALID[field];
  }
  // The PAN rule follows the country: checked here too, so it shows alongside other refusals.
  if (!errors.panVatNo && nepalPanProblem(values.country, blankToUndefined(values.panVatNo))) {
    errors.panVatNo = panMessage(values.country);
  }
  return errors;
}

export type CreateCustomerParse =
  { ok: true; data: CreateCustomerBody } | { ok: false; errors: CustomerErrors };

/**
 * Checks the create form, first contact and its phones included, against `CreateCustomerBodySchema`.
 * `phones` are the first contact's rows (`readPhoneRows(form, 'contactPhones')`).
 */
export function parseCreateCustomer(
  raw: CustomerValues,
  phones: readonly PhoneRow[] = [],
): CreateCustomerParse {
  const values = tidyCustomerValues(raw);
  const parsed = CreateCustomerBodySchema.safeParse({
    ...customerBody(values),
    contact: firstContactBody(values, phones),
  });
  const errors = customerErrors(values, phones, parsed.success ? [] : parsed.error.issues);
  if (parsed.success && Object.keys(errors).length === 0) return { ok: true, data: parsed.data };
  return { ok: false, errors };
}

export type UpdateCustomerParse =
  | { ok: true; data: UpdateCustomerBody }
  | { ok: false; errors: CustomerErrors }
  | { ok: false; nothingChanged: true };

const CANNOT_CLEAR = 'This cannot be cleared yet. Enter a new value, or put back the old one.';

/**
 * Checks the edit form and keeps only what changed, plus `expectedVersion` (the version the person
 * opened). The update contract is a shallow partial with no way to send "empty": a field that had a
 * value and is now blank is refused with words rather than silently left as it was. The address is
 * sent whole when its line or city changed, because the contract replaces it as one object; the
 * country is its own field. The PAN is checked against the country on the form, so a Nepal customer
 * cannot keep a PAN that is not 9 digits whichever of the two changed.
 */
export function parseUpdateCustomer(
  raw: CustomerValues,
  original: CustomerDto,
): UpdateCustomerParse {
  const values = tidyCustomerValues(raw);
  const before = valuesOfCustomer(original);

  const errors: CustomerErrors = {};
  for (const field of ['panVatNo', 'industry', 'defaultCurrency'] as const) {
    if (values[field] === '' && before[field] !== '') errors[field] = CANNOT_CLEAR;
  }

  const parsed = CustomerFieldsSchema.safeParse(customerBody(values));
  Object.assign(errors, {
    ...customerErrors(values, [], parsed.success ? [] : parsed.error.issues),
    ...errors,
  });
  if (Object.keys(errors).length > 0 || !parsed.success) return { ok: false, errors };

  const body = parsed.data;
  const data: Record<string, unknown> = {};
  for (const field of [
    'legalName',
    'panVatNo',
    'industry',
    'relationship',
    'defaultCurrency',
    'country',
  ] as const) {
    if (values[field] !== before[field]) data[field] = body[field];
  }
  if (values.line !== before.line || values.city !== before.city) data.address = body.address;

  if (Object.keys(data).length === 0) return { ok: false, nothingChanged: true };
  return { ok: true, data: { ...data, expectedVersion: original.version } };
}

// ---------------------------------------------------------------------------------------------
// Contact
// ---------------------------------------------------------------------------------------------

/** The add-contact form's text fields. Its phones are posted as `phones` rows (`readPhoneRows`). */
export interface ContactValues {
  fullName: string;
  title: string;
  email: string;
  /** The person's country (it may differ from the company's). */
  country: string;
  isPrimary: boolean;
}
export type ContactField = 'fullName' | 'title' | 'email' | 'country';
export type ContactErrors = FieldErrors<ContactField> & PhoneErrors;

export const EMPTY_CONTACT_VALUES: ContactValues = {
  fullName: '',
  title: '',
  email: '',
  country: DEFAULT_COUNTRY,
  isPrimary: false,
};

const CONTACT_REQUIRED: Partial<Record<ContactField, string>> = {
  fullName: "Enter the contact's full name.",
  country: "Choose the contact's country.",
};

const CONTACT_INVALID: Record<ContactField, string> = {
  fullName: "Enter the contact's full name, up to 200 characters.",
  title: 'Use up to 100 characters for the job title.',
  email: 'Enter an email address like name@company.com.',
  country: 'Choose a country from the list.',
};

export type ContactParse =
  { ok: true; data: CreateContactBody } | { ok: false; errors: ContactErrors };

/** The words for a missing email while the customer has no contact with one. */
export const CONTACT_EMAIL_REQUIRED =
  'This customer has no contact with an email yet, so enter one. Quotations are sent to it.';

/**
 * Checks the add-contact form, with its phone rows (`readPhoneRows(form, 'phones')`), against
 * `CreateContactBodySchema`. `requireEmail`: the customer has no contact with an email yet, so this
 * one needs it (the API refuses it too, with 422 `contact_email_required`).
 */
export function parseContact(
  raw: ContactValues,
  phones: readonly PhoneRow[] = [],
  { requireEmail = false } = {},
): ContactParse {
  const parsed = parseContactFields(raw, phones);
  if (!requireEmail || clean(raw.email) !== '') return parsed;
  return {
    ok: false,
    errors: { ...(parsed.ok ? {} : parsed.errors), email: CONTACT_EMAIL_REQUIRED },
  };
}

function parseContactFields(raw: ContactValues, phones: readonly PhoneRow[]): ContactParse {
  const values: Record<ContactField, string> = {
    fullName: clean(raw.fullName),
    title: clean(raw.title),
    email: clean(raw.email),
    country: clean(raw.country).toUpperCase(),
  };
  const parsed = CreateContactBodySchema.safeParse({
    fullName: values.fullName,
    title: blankToUndefined(values.title),
    email: blankToUndefined(values.email),
    country: values.country,
    phones: phonesBody(phones),
    isPrimary: raw.isPrimary,
  });
  if (parsed.success) return { ok: true, data: parsed.data };
  const errors: ContactErrors = {};
  for (const issue of parsed.error.issues) {
    const [first] = issue.path;
    if (first === 'phones') {
      addPhoneIssue(errors, phones, issue.path.slice(1), issue);
      continue;
    }
    const field = first as ContactField | undefined;
    if (typeof field !== 'string' || !(field in CONTACT_INVALID) || errors[field]) continue;
    errors[field] =
      values[field] === '' && CONTACT_REQUIRED[field]
        ? CONTACT_REQUIRED[field]
        : CONTACT_INVALID[field];
  }
  return { ok: false, errors };
}
