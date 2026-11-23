// Pure helpers for Settings > Company profile: the logo shown, the phone list, the card drafts and
// how a submitted card becomes a settings write. No React and no server import, so the page, the
// Server Action and the tests all read one set of rules.
//
// Storage (plan 3.1): the address is `entity.address`, the PAN/VAT number is `entity.pan_vat_no`, and
// everything else is the single value `entity.profile`. `entity.profile.panVatNo` is never written: it
// stays null and the document snapshot falls back to `entity.pan_vat_no`.
import {
  CompanyPhoneSchema,
  CompanyProfileSchema,
  DEFAULT_COUNTRY,
  EMPTY_COMPANY_PROFILE,
  MAX_COMPANY_PHONES,
  NepalPanSchema,
  PanVatNoSchema,
  PrintAddressSchema,
  formatAddressLines,
  imagePath,
  isCountryCode,
  type CompanyPhone,
  type CompanyProfile,
  type CountryCode,
  type PartyPhoneInput,
  type PrintAddress,
} from '@bos/contracts';
import { z } from 'zod';

import { rawPhoneRows } from '@/components/ui/phone-rows';

// ---------------------------------------------------------------------------------------------
// Logo
// ---------------------------------------------------------------------------------------------

/**
 * The logo as the page shows it. A logo is an uploaded image (`documentId`). A logo saved before logos were
 * images is kept as `legacyDataUrl` until the API moves it, and only while there is no image yet.
 */
export interface CompanyLogo {
  documentId: string | null;
  legacyDataUrl: string | null;
  /** The optional logo for dark backgrounds (the reversed or light version), and for light backgrounds. */
  onDarkDocumentId: string | null;
  onLightDocumentId: string | null;
}

export function companyLogo(profile: CompanyProfile): CompanyLogo {
  const documentId = profile.logoDocumentId;
  return {
    documentId,
    legacyDataUrl: documentId === null ? (profile.legacyLogoDataUrl ?? null) : null,
    onDarkDocumentId: profile.logoOnDarkDocumentId,
    onLightDocumentId: profile.logoOnLightDocumentId,
  };
}

/**
 * Where the letterhead preview reads the logo from: the image route, the not-yet-moved data URL, or nothing. The
 * preview sheet is white, so the logo made for light backgrounds is drawn when the company uploaded one (the same
 * choice the printed documents make for a white header; the server decides there from measured contrast).
 */
export const logoSource = (logo: CompanyLogo): string | null => {
  if (logo.documentId !== null) {
    return imagePath(logo.onLightDocumentId ?? logo.documentId);
  }
  return logo.legacyDataUrl;
};

// ---------------------------------------------------------------------------------------------
// Phones
// ---------------------------------------------------------------------------------------------

/** The most numbers the profile prints (`MAX_COMPANY_PHONES`); the phone list itself would take one more. */
export const MAX_PHONES = MAX_COMPANY_PHONES;

/**
 * The saved numbers as the phone list opens with them. The profile has no primary number (the order is the print
 * order), but the list always marks one, so the first row carries it; the save ignores it.
 */
export function phoneListDefault(phones: readonly CompanyPhone[]): PartyPhoneInput[] {
  return phones.map((phone, index) => ({
    country: phone.country,
    e164: phone.e164,
    label: phone.label ?? null,
    isPrimary: index === 0,
  }));
}

/** The list's complete numbers as the profile stores them: country, number and label, in order, no primary flag. */
export const profilePhones = (phones: readonly PartyPhoneInput[]): CompanyPhone[] =>
  phones.map(({ country, e164, label }) => ({ country, e164, label: label ?? null }));

// ---------------------------------------------------------------------------------------------
// Drafts: what each card's inputs hold (always strings)
// ---------------------------------------------------------------------------------------------

export interface IdentityDraft {
  displayName: string;
  panVatNo: string;
}
/** The company address as its three fields hold it (`AddressFields`): street lines, city and country. */
export interface AddressDraft {
  line: string;
  city: string;
  country: CountryCode;
}
export interface ContactDraft {
  /** The complete, valid numbers of the phone list, in print order. */
  phones: CompanyPhone[];
  email: string;
  website: string;
}
export interface SignatoryDraft {
  name: string;
  title: string;
}
export interface CompanyDrafts {
  identity: IdentityDraft;
  address: AddressDraft;
  contact: ContactDraft;
  signatory: SignatoryDraft;
}
export type CompanyCard = keyof CompanyDrafts;
/** The cards with a Save. The logo is not one: it uploads at once and moves its own pointer. */
export const COMPANY_CARDS = ['identity', 'address', 'contact', 'signatory'] as const;

export const isCompanyCard = (value: string): value is CompanyCard =>
  (COMPANY_CARDS as readonly string[]).includes(value);

/** Everything the page reads: the three stored values. */
export interface CompanySettings {
  profile: CompanyProfile;
  address: PrintAddress | null;
  panVatNo: string | null;
}

export function draftsFromSettings({ profile, address, panVatNo }: CompanySettings): CompanyDrafts {
  return {
    identity: { displayName: profile.displayName ?? '', panVatNo: panVatNo ?? '' },
    address: {
      line: address?.line ?? '',
      city: address?.city ?? '',
      country: address?.country ?? DEFAULT_COUNTRY,
    },
    contact: {
      // `label: null` as the phone list reports it, so a stored row without a label is not a change.
      phones: profilePhones(phoneListDefault(profile.phones)),
      email: profile.email ?? '',
      website: profile.website ?? '',
    },
    signatory: { name: profile.signatoryName ?? '', title: profile.signatoryTitle ?? '' },
  };
}

/** Trim every string and drop empty phone rows, so "  Acme " and a blank extra row are not changes. */
function normalise(value: unknown): unknown {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value.map(normalise).filter((v) => v !== '');
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalise(v)]));
  }
  return value;
}

/** True when two drafts of one card say the same thing once trimmed. Decides whether Save is enabled. */
export const sameDraft = (a: unknown, b: unknown): boolean =>
  JSON.stringify(normalise(a)) === JSON.stringify(normalise(b));

/**
 * The lines of an address as a document prints it (line, city, country), for the letterhead preview. The country is
 * left out when it is `ownCountry`, as the PDFs leave out the issuing company's own. Nothing typed: no lines.
 */
export function addressLines(draft: AddressDraft, ownCountry?: CountryCode): string[] {
  const line = draft.line.trim();
  const city = draft.city.trim();
  if (line === '' && city === '') return [];
  return formatAddressLines({ line, city }, draft.country, ownCountry).filter(
    (part) => part !== '',
  );
}

// ---------------------------------------------------------------------------------------------
// Parsing a submitted card
// ---------------------------------------------------------------------------------------------

/** Field errors by input name. */
export type FieldErrors = Record<string, string>;
export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: FieldErrors };

/**
 * The profile fields a card may change. `panVatNo` is never written to the profile, and the logo fields are moved
 * only by the image upload, so no card save can drop or replace the logo.
 */
export type ProfilePatch = Partial<
  Omit<
    CompanyProfile,
    | 'panVatNo'
    | 'logoDocumentId'
    | 'logoOnDarkDocumentId'
    | 'logoOnLightDocumentId'
    | 'legacyLogoDataUrl'
  >
>;

const blank = (value: string): string | null => {
  const t = value.trim();
  return t === '' ? null : t;
};

const tooLong = (max: number) => `Use ${max} characters or fewer.`;

export function parseIdentity(
  draft: IdentityDraft,
): Parsed<{ profile: ProfilePatch; panVatNo: string | null }> {
  const errors: FieldErrors = {};
  const displayName = blank(draft.displayName);
  if (displayName !== null && displayName.length > 120) errors['displayName'] = tooLong(120);
  const panVatNo = blank(draft.panVatNo);
  if (panVatNo !== null && !NepalPanSchema.safeParse(panVatNo).success) {
    errors['panVatNo'] = 'A PAN is exactly 9 digits.';
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { profile: { displayName }, panVatNo } };
}

const ADDRESS_LABEL: Record<keyof AddressDraft, string> = {
  line: 'address',
  city: 'city',
  country: 'country',
};

/**
 * An address with no street lines and no city is "no address" (null): the country select always holds a value, so
 * it alone is not an address. Otherwise all three are required. Errors are keyed `line`, `city` and `country`.
 */
export function parseAddress(draft: {
  line: string;
  city: string;
  country: string;
}): Parsed<PrintAddress | null> {
  const line = draft.line.trim();
  const city = draft.city.trim();
  const country = draft.country.trim();
  if (line === '' && city === '') return { ok: true, value: null };
  const errors: FieldErrors = {};
  if (line === '') errors['line'] = 'Enter the address.';
  if (city === '') errors['city'] = 'Enter the city.';
  if (!isCountryCode(country)) errors['country'] = 'Choose a country.';
  const parsed = PrintAddressSchema.safeParse({ line, city, country });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? '');
      if (key in ADDRESS_LABEL && errors[key] === undefined) {
        errors[key] =
          issue.code === 'too_big'
            ? tooLong(Number((issue as { maximum?: number }).maximum ?? 300))
            : `Check the ${ADDRESS_LABEL[key as keyof AddressDraft]}.`;
      }
    }
  }
  if (Object.keys(errors).length > 0 || !parsed.success) return { ok: false, errors };
  return { ok: true, value: parsed.data };
}

/** A contract phone problem ("not a valid United States number") as a sentence. */
const sentence = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;

/**
 * The phone rows as posted: country, number and label, blank rows left out. `row` is the list row each came from, so
 * an error lands under it (`phones.<row>`). The list's primary flag is not read: the profile prints in row order.
 */
export interface PostedPhone {
  row: number;
  country: string;
  e164: string;
  label: string | null;
}

/**
 * Checks the posted numbers: at most four, each a valid number of its own country, none listed twice. An error on one
 * number is keyed `phones.<row>`, one about the list `phones`.
 */
export function parsePhones(posted: readonly PostedPhone[]): Parsed<CompanyPhone[]> {
  const errors: FieldErrors = {};
  if (posted.length > MAX_PHONES) errors['phones'] = `Add up to ${MAX_PHONES} phone numbers.`;
  const phones: CompanyPhone[] = [];
  const seen = new Set<string>();
  for (const phone of posted) {
    const key = `phones.${phone.row}`;
    const parsed = CompanyPhoneSchema.safeParse({
      country: phone.country,
      e164: phone.e164,
      label: phone.label,
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      errors[key] =
        issue?.path[0] === 'e164' && issue.message ? sentence(issue.message) : 'Check this number.';
      continue;
    }
    if (seen.has(parsed.data.e164)) {
      errors[key] = 'This number is already listed.';
      continue;
    }
    seen.add(parsed.data.e164);
    phones.push({ ...parsed.data, label: parsed.data.label ?? null });
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: phones };
}

export function parseContact(draft: {
  phones: readonly PostedPhone[];
  email: string;
  website: string;
}): Parsed<ProfilePatch> {
  const checked = parsePhones(draft.phones);
  const errors: FieldErrors = checked.ok ? {} : { ...checked.errors };
  const phones = checked.ok ? checked.value : [];
  const email = blank(draft.email);
  if (email !== null && !z.email().max(200).safeParse(email).success) {
    errors['email'] = 'Enter an email address such as accounts@example.com.';
  }
  const website = blank(draft.website);
  if (website !== null && website.length > 200) errors['website'] = tooLong(200);
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { phones, email, website } };
}

export function parseSignatory(draft: SignatoryDraft): Parsed<ProfilePatch> {
  const errors: FieldErrors = {};
  const signatoryName = blank(draft.name);
  const signatoryTitle = blank(draft.title);
  if (signatoryName !== null && signatoryName.length > 120) errors['name'] = tooLong(120);
  if (signatoryTitle !== null && signatoryTitle.length > 120) errors['title'] = tooLong(120);
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { signatoryName, signatoryTitle } };
}

// ---------------------------------------------------------------------------------------------
// From a submitted form to the writes
// ---------------------------------------------------------------------------------------------

/** The settings each card may write. The Server Action refuses any other key for a card. */
export const CARD_WRITES = {
  identity: ['entity.profile', 'entity.pan_vat_no'],
  address: ['entity.address'],
  contact: ['entity.profile'],
  signatory: ['entity.profile'],
} as const satisfies Record<CompanyCard, readonly string[]>;

/** What one card's Save asks for. A key that is absent is not touched. */
export interface CardPlan {
  profile?: ProfilePatch;
  panVatNo?: string | null;
  address?: PrintAddress | null;
}

export interface FormLike {
  get(name: string): unknown;
  getAll(name: string): unknown[];
}

const str = (form: FormLike, name: string): string => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};

/** More rows than the list can hold still reach `parsePhones`, which refuses them; this only bounds the loop. */
const PHONE_ROWS_READ = 20;

/** The rows a `PhoneListInput` named `phones` posted (`phones.<i>.number`, `.country`, `.label`), blank ones left out. */
export function postedPhones(form: FormLike): PostedPhone[] {
  return rawPhoneRows(form, 'phones', { limit: PHONE_ROWS_READ }).map(
    ({ row, country, number, label }) => ({
      row,
      country,
      e164: number,
      label: label === '' ? null : label,
    }),
  );
}

/** Reads one card's fields from the submitted form. `fields` echoes what was typed, for an error reply. */
export function planCard(
  card: CompanyCard,
  form: FormLike,
): Parsed<CardPlan> | { ok: false; errors: FieldErrors } {
  switch (card) {
    case 'identity': {
      const r = parseIdentity({
        displayName: str(form, 'displayName'),
        panVatNo: str(form, 'panVatNo'),
      });
      return r.ok
        ? { ok: true, value: { profile: r.value.profile, panVatNo: r.value.panVatNo } }
        : r;
    }
    case 'address': {
      const r = parseAddress({
        line: str(form, 'address.line'),
        city: str(form, 'address.city'),
        country: str(form, 'address.country'),
      });
      return r.ok ? { ok: true, value: { address: r.value } } : r;
    }
    case 'contact': {
      const r = parseContact({
        phones: postedPhones(form),
        email: str(form, 'email'),
        website: str(form, 'website'),
      });
      return r.ok ? { ok: true, value: { profile: r.value } } : r;
    }
    case 'signatory': {
      const r = parseSignatory({ name: str(form, 'name'), title: str(form, 'title') });
      return r.ok ? { ok: true, value: { profile: r.value } } : r;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Versions: what the page loaded, sent back so a save never overwrites a newer one
// ---------------------------------------------------------------------------------------------

/** The three settings this screen reads and writes. */
export type CompanyKey = 'entity.profile' | 'entity.address' | 'entity.pan_vat_no';

/** The version of each setting as the page loaded it; null when the page loaded the default. */
export type CompanyVersions = Record<CompanyKey, number | null>;

/** The form field that carries the loaded version of one setting. An empty value means "the default". */
export const versionFieldName = (key: CompanyKey): string => `expectedVersion:${key}`;

export const versionFieldValue = (version: number | null): string =>
  version === null ? '' : String(version);

/**
 * Reads the version a form carried for `key`: a number, null (the empty string: the page loaded the
 * default), or undefined when the field is missing or is not a whole number. The caller refuses an
 * undefined: a save with no loaded version cannot be checked, so it must not go through.
 */
export function readExpectedVersion(form: FormLike, key: CompanyKey): number | null | undefined {
  const value = form.get(versionFieldName(key));
  if (typeof value !== 'string') return undefined;
  if (value === '') return null;
  return /^\d{1,15}$/.test(value) ? Number(value) : undefined;
}

// ---------------------------------------------------------------------------------------------
// Undo (D32): put one card back to empty
// ---------------------------------------------------------------------------------------------

/** The cards that show an undo icon: the address (a whole setting) and two parts of the profile. */
export const RESETTABLE_CARDS = ['address', 'contact', 'signatory'] as const;
export type ResettableCard = (typeof RESETTABLE_CARDS)[number];

export const isResettableCard = (value: string): value is ResettableCard =>
  (RESETTABLE_CARDS as readonly string[]).includes(value);

/** The setting a card's undo writes. */
export const RESET_KEY = {
  address: 'entity.address',
  contact: 'entity.profile',
  signatory: 'entity.profile',
} as const satisfies Record<ResettableCard, CompanyKey>;

/** This card's profile fields at their empty values: logo, display name and the rest are not named, so they stay. */
export function emptyProfilePatch(card: 'contact' | 'signatory'): ProfilePatch {
  const { phones, email, website, signatoryName, signatoryTitle } = EMPTY_COMPANY_PROFILE;
  return card === 'contact' ? { phones, email, website } : { signatoryName, signatoryTitle };
}

/** True when what is saved for this card is already empty: no undo icon is drawn then. */
export function isCardEmpty(card: ResettableCard, settings: CompanySettings): boolean {
  switch (card) {
    case 'address':
      return settings.address === null;
    case 'contact':
    case 'signatory':
      return sameProfileFields(settings.profile, emptyProfilePatch(card));
  }
}

const sameProfileFields = (profile: CompanyProfile, patch: ProfilePatch): boolean =>
  Object.entries(patch).every(
    ([field, value]) =>
      JSON.stringify(profile[field as keyof CompanyProfile]) === JSON.stringify(value),
  );

/** The stored profile with only this card's fields replaced. The other cards' values (and panVatNo) stay. */
export function mergeProfile(current: CompanyProfile, patch: ProfilePatch): CompanyProfile {
  return { ...current, ...patch };
}

export const sameProfile = (a: CompanyProfile, b: CompanyProfile): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/** The stored settings as the page needs them, or a message when one of them cannot be read. */
export function parseCompanySettings(raw: {
  profile: unknown;
  address: unknown;
  panVatNo: unknown;
}): { ok: true; data: CompanySettings } | { ok: false; message: string } {
  // Read as strictly as it is written (FX9): phones carry their country, the address is line, city and country.
  const profile = CompanyProfileSchema.safeParse(raw.profile);
  if (!profile.success)
    return { ok: false, message: 'The saved company profile could not be read.' };
  const address = PrintAddressSchema.nullable().safeParse(raw.address);
  if (!address.success) return { ok: false, message: 'The saved address could not be read.' };
  const panVatNo = PanVatNoSchema.nullable().safeParse(raw.panVatNo);
  if (!panVatNo.success)
    return { ok: false, message: 'The saved PAN or VAT number could not be read.' };
  return {
    ok: true,
    data: { profile: profile.data, address: address.data, panVatNo: panVatNo.data },
  };
}
