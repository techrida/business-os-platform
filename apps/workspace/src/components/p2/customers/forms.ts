import {
  CreateContactBodySchema,
  CreateCustomerBodySchema,
  CUSTOMER_RELATIONSHIPS,
  CURRENCIES,
  CustomerFieldsSchema,
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

// ---------------------------------------------------------------------------------------------
// Customer
// ---------------------------------------------------------------------------------------------

export interface CustomerValues {
  legalName: string;
  panVatNo: string;
  industry: string;
  relationship: string;
  defaultCurrency: string;
  line1: string;
  line2: string;
  city: string;
  district: string;
  province: string;
  postalCode: string;
  country: string;
  /**
   * The first contact, asked for on create only (the edit form leaves these blank and never sends
   * them). Its email is required: quotations are sent by email.
   */
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  contactTitle: string;
}
export type CustomerField = keyof CustomerValues;

export const EMPTY_CUSTOMER_VALUES: CustomerValues = {
  legalName: '',
  panVatNo: '',
  industry: '',
  relationship: 'prospect',
  defaultCurrency: '',
  line1: '',
  line2: '',
  city: '',
  district: '',
  province: '',
  postalCode: '',
  country: 'NP',
  contactName: '',
  contactEmail: '',
  contactPhone: '',
  contactTitle: '',
};

export const CUSTOMER_FIELDS = Object.keys(EMPTY_CUSTOMER_VALUES) as CustomerField[];

/** Longest allowed text per field, from the contract. */
const MAX: Partial<Record<CustomerField, number>> = {
  legalName: 200,
  industry: 100,
  line1: 200,
  line2: 200,
  city: 100,
  district: 100,
  province: 100,
  postalCode: 20,
  contactName: 200,
  contactEmail: 254,
  contactTitle: 100,
};

const REQUIRED: Partial<Record<CustomerField, string>> = {
  legalName: "Enter the company's legal name.",
  line1: 'Enter the first line of the address, such as the street or area.',
  city: 'Enter the city.',
  country: 'Enter the two-letter country code, for example NP.',
  contactName: "Enter the main contact's full name.",
  contactEmail: "Enter the main contact's email. Quotations are sent to it.",
};

const INVALID: Record<CustomerField, string> = {
  legalName: "Enter the company's legal name.",
  panVatNo: 'Use 5 to 20 letters, digits or hyphens, for example 301234567.',
  industry: 'Enter the industry in words.',
  relationship: `Choose one of: ${CUSTOMER_RELATIONSHIPS.join(', ')}.`,
  defaultCurrency: `Choose one of: ${CURRENCIES.join(', ')}.`,
  line1: 'Enter the first line of the address.',
  line2: 'Enter the second line of the address.',
  city: 'Enter the city.',
  district: 'Enter the district.',
  province: 'Enter the province.',
  postalCode: 'Enter the postal code.',
  country: 'Use the two-letter country code, for example NP.',
  contactName: "Enter the contact's full name, up to 200 characters.",
  contactEmail: 'Enter an email address like name@company.com.',
  contactPhone:
    'Add the country code, starting with +. For Nepal that looks like +9779812345678. Spaces and hyphens are fine.',
  contactTitle: 'Use up to 100 characters for the job title.',
};

/** A contract path under `contact` (the first contact) and the form field it belongs to. */
const CONTACT_PATH: Record<string, CustomerField> = {
  fullName: 'contactName',
  email: 'contactEmail',
  phone: 'contactPhone',
  title: 'contactTitle',
};

const clean = (v: string): string => v.trim();

/** What a person typed, tidied: trimmed, the country in capitals and the phone without punctuation. */
export function tidyCustomerValues(raw: Partial<CustomerValues>): CustomerValues {
  const out = { ...EMPTY_CUSTOMER_VALUES };
  for (const key of CUSTOMER_FIELDS) out[key] = clean(raw[key] ?? '');
  out.country = out.country.toUpperCase();
  out.contactPhone = normalizePhone(out.contactPhone);
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
    line1: c.address.line1,
    line2: c.address.line2 ?? '',
    city: c.address.city,
    district: c.address.district ?? '',
    province: c.address.province ?? '',
    postalCode: c.address.postalCode ?? '',
    country: c.address.country,
    contactName: '',
    contactEmail: '',
    contactPhone: '',
    contactTitle: '',
  };
}

const blankToUndefined = (v: string): string | undefined => (v === '' ? undefined : v);

/** The first contact of a new customer. Blank optional fields are left out. */
function firstContactBody(v: CustomerValues): Record<string, unknown> {
  return {
    fullName: v.contactName,
    email: v.contactEmail,
    phone: blankToUndefined(v.contactPhone),
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
    address: {
      line1: v.line1,
      line2: blankToUndefined(v.line2),
      city: v.city,
      district: blankToUndefined(v.district),
      province: blankToUndefined(v.province),
      postalCode: blankToUndefined(v.postalCode),
      country: v.country,
    },
  };
}

function customerErrors(values: CustomerValues, issues: readonly { path: PropertyKey[] }[]) {
  const errors: FieldErrors<CustomerField> = {};
  for (const issue of issues) {
    const [first, second] = issue.path;
    const field = (
      first === 'address'
        ? second
        : first === 'contact'
          ? // A missing contact object is reported on its first required field.
            typeof second === 'string'
            ? CONTACT_PATH[second]
            : 'contactName'
          : first
    ) as CustomerField | undefined;
    if (typeof field !== 'string' || !CUSTOMER_FIELDS.includes(field) || errors[field]) continue;
    const value = values[field];
    const max = MAX[field];
    errors[field] =
      value === '' && REQUIRED[field]
        ? REQUIRED[field]
        : max !== undefined && value.length > max
          ? `Use ${max} characters or fewer.`
          : INVALID[field];
  }
  return errors;
}

export type CreateCustomerParse =
  { ok: true; data: CreateCustomerBody } | { ok: false; errors: FieldErrors<CustomerField> };

/** Checks the create form, first contact included, against `CreateCustomerBodySchema`. */
export function parseCreateCustomer(raw: CustomerValues): CreateCustomerParse {
  const values = tidyCustomerValues(raw);
  const parsed = CreateCustomerBodySchema.safeParse({
    ...customerBody(values),
    contact: firstContactBody(values),
  });
  if (parsed.success) return { ok: true, data: parsed.data };
  return { ok: false, errors: customerErrors(values, parsed.error.issues) };
}

export type UpdateCustomerParse =
  | { ok: true; data: UpdateCustomerBody }
  | { ok: false; errors: FieldErrors<CustomerField> }
  | { ok: false; nothingChanged: true };

const CANNOT_CLEAR = 'This cannot be cleared yet. Enter a new value, or put back the old one.';

/**
 * Checks the edit form and keeps only what changed, plus `expectedVersion` (the version the person
 * opened). The update contract is a shallow partial with no way to send "empty": a field that had a
 * value and is now blank is refused with words rather than silently left as it was. The address is
 * sent whole when any part of it changed, because the contract replaces it as one object.
 */
export function parseUpdateCustomer(
  raw: CustomerValues,
  original: CustomerDto,
): UpdateCustomerParse {
  const values = tidyCustomerValues(raw);
  const before = valuesOfCustomer(original);

  const errors: FieldErrors<CustomerField> = {};
  for (const field of ['panVatNo', 'industry', 'defaultCurrency'] as const) {
    if (values[field] === '' && before[field] !== '') errors[field] = CANNOT_CLEAR;
  }

  const parsed = CustomerFieldsSchema.safeParse(customerBody(values));
  if (!parsed.success) {
    Object.assign(errors, { ...customerErrors(values, parsed.error.issues), ...errors });
  }
  if (Object.keys(errors).length > 0 || !parsed.success) return { ok: false, errors };

  const body = parsed.data;
  const data: Record<string, unknown> = {};
  for (const field of [
    'legalName',
    'panVatNo',
    'industry',
    'relationship',
    'defaultCurrency',
  ] as const) {
    if (values[field] !== before[field]) data[field] = body[field];
  }
  const addressFields = [
    'line1',
    'line2',
    'city',
    'district',
    'province',
    'postalCode',
    'country',
  ] as const;
  if (addressFields.some((f) => values[f] !== before[f])) data.address = body.address;

  if (Object.keys(data).length === 0) return { ok: false, nothingChanged: true };
  return { ok: true, data: { ...data, expectedVersion: original.version } };
}

// ---------------------------------------------------------------------------------------------
// Contact
// ---------------------------------------------------------------------------------------------

export interface ContactValues {
  fullName: string;
  title: string;
  email: string;
  phone: string;
  isPrimary: boolean;
}
export type ContactField = 'fullName' | 'title' | 'email' | 'phone';

export const EMPTY_CONTACT_VALUES: ContactValues = {
  fullName: '',
  title: '',
  email: '',
  phone: '',
  isPrimary: false,
};

/**
 * A phone with the punctuation people type removed: spaces, hyphens, dots and brackets. It never
 * guesses a country code: "9812345678" stays as typed and is refused with an example, because a
 * wrong guess would store someone else's number.
 */
export function normalizePhone(raw: string): string {
  return raw.replace(/[\s().-]+/g, '');
}

const CONTACT_REQUIRED: Partial<Record<ContactField, string>> = {
  fullName: "Enter the contact's full name.",
};

const CONTACT_INVALID: Record<ContactField, string> = {
  fullName: "Enter the contact's full name, up to 200 characters.",
  title: 'Use up to 100 characters for the job title.',
  email: 'Enter an email address like name@company.com.',
  phone:
    'Add the country code, starting with +. For Nepal that looks like +9779812345678. Spaces and hyphens are fine.',
};

export type ContactParse =
  { ok: true; data: CreateContactBody } | { ok: false; errors: FieldErrors<ContactField> };

/** The words for a missing email while the customer has no contact with one. */
export const CONTACT_EMAIL_REQUIRED =
  'This customer has no contact with an email yet, so enter one. Quotations are sent to it.';

/**
 * Checks the add-contact form against `CreateContactBodySchema`; the phone must be E.164.
 * `requireEmail`: the customer has no contact with an email yet, so this one needs it (the API
 * refuses it too, with 422 `contact_email_required`).
 */
export function parseContact(raw: ContactValues, { requireEmail = false } = {}): ContactParse {
  const parsed = parseContactFields(raw);
  if (!requireEmail || clean(raw.email) !== '') return parsed;
  return {
    ok: false,
    errors: { ...(parsed.ok ? {} : parsed.errors), email: CONTACT_EMAIL_REQUIRED },
  };
}

function parseContactFields(raw: ContactValues): ContactParse {
  const values = {
    fullName: clean(raw.fullName),
    title: clean(raw.title),
    email: clean(raw.email),
    phone: normalizePhone(clean(raw.phone)),
  };
  const parsed = CreateContactBodySchema.safeParse({
    fullName: values.fullName,
    title: blankToUndefined(values.title),
    email: blankToUndefined(values.email),
    phone: blankToUndefined(values.phone),
    isPrimary: raw.isPrimary,
  });
  if (parsed.success) return { ok: true, data: parsed.data };
  const errors: FieldErrors<ContactField> = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0] as ContactField | undefined;
    if (typeof field !== 'string' || !(field in CONTACT_INVALID) || errors[field]) continue;
    errors[field] =
      values[field] === '' && CONTACT_REQUIRED[field]
        ? CONTACT_REQUIRED[field]
        : CONTACT_INVALID[field];
  }
  return { ok: false, errors };
}
