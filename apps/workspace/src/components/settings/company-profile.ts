// Pure helpers for Settings > Company profile: the logo shown, the phone list, the card drafts and
// how a submitted card becomes a settings write. No React and no server import, so the page, the
// Server Action and the tests all read one set of rules.
//
// Storage (plan 3.1): the address is `entity.address`, the PAN/VAT number is `entity.pan_vat_no`, and
// everything else is the single value `entity.profile`. `entity.profile.panVatNo` is never written: it
// stays null and the document snapshot falls back to `entity.pan_vat_no`.
import {
  AddressSchema,
  EMPTY_COMPANY_PROFILE,
  NepalPanSchema,
  PanVatNoSchema,
  PhoneSchema,
  StoredCompanyProfileSchema,
  imagePath,
  type Address,
  type CompanyProfile,
} from '@bos/contracts';
import { z } from 'zod';

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
}

export function companyLogo(profile: CompanyProfile): CompanyLogo {
  const documentId = profile.logoDocumentId;
  return {
    documentId,
    legacyDataUrl: documentId === null ? (profile.legacyLogoDataUrl ?? null) : null,
  };
}

/** Where the logo picture is read from: the image route, the not-yet-moved data URL, or nothing. */
export const logoSource = (logo: CompanyLogo): string | null =>
  logo.documentId !== null ? imagePath(logo.documentId) : logo.legacyDataUrl;

// ---------------------------------------------------------------------------------------------
// Phones
// ---------------------------------------------------------------------------------------------

export const MAX_PHONES = 4;

/** The list with one more empty row, or the same list at the limit. */
export function addPhone(phones: readonly string[]): string[] {
  return phones.length >= MAX_PHONES ? [...phones] : [...phones, ''];
}

export function removePhone(phones: readonly string[], index: number): string[] {
  return phones.filter((_, i) => i !== index);
}

export function setPhone(phones: readonly string[], index: number, value: string): string[] {
  return phones.map((phone, i) => (i === index ? value : phone));
}

export const canAddPhone = (phones: readonly string[]): boolean => phones.length < MAX_PHONES;

// ---------------------------------------------------------------------------------------------
// Countries
// ---------------------------------------------------------------------------------------------

export const COUNTRIES: readonly { code: string; name: string }[] = [
  { code: 'NP', name: 'Nepal' },
  { code: 'IN', name: 'India' },
  { code: 'BD', name: 'Bangladesh' },
  { code: 'BT', name: 'Bhutan' },
  { code: 'LK', name: 'Sri Lanka' },
  { code: 'CN', name: 'China' },
  { code: 'SG', name: 'Singapore' },
  { code: 'AE', name: 'United Arab Emirates' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'US', name: 'United States' },
  { code: 'CA', name: 'Canada' },
  { code: 'AU', name: 'Australia' },
  { code: 'DE', name: 'Germany' },
];

export const DEFAULT_COUNTRY = 'NP';

export const countryName = (code: string): string =>
  COUNTRIES.find((c) => c.code === code)?.name ?? code;

/** The select's options; a saved country outside the short list still shows. */
export function countryOptions(current: string): readonly { code: string; name: string }[] {
  return COUNTRIES.some((c) => c.code === current) || current === ''
    ? COUNTRIES
    : [...COUNTRIES, { code: current, name: current }];
}

// ---------------------------------------------------------------------------------------------
// Drafts: what each card's inputs hold (always strings)
// ---------------------------------------------------------------------------------------------

export interface IdentityDraft {
  displayName: string;
  panVatNo: string;
}
export interface AddressDraft {
  line1: string;
  line2: string;
  city: string;
  district: string;
  province: string;
  postalCode: string;
  country: string;
}
export interface ContactDraft {
  phones: string[];
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
  address: Address | null;
  panVatNo: string | null;
}

export function draftsFromSettings({ profile, address, panVatNo }: CompanySettings): CompanyDrafts {
  return {
    identity: { displayName: profile.displayName ?? '', panVatNo: panVatNo ?? '' },
    address: {
      line1: address?.line1 ?? '',
      line2: address?.line2 ?? '',
      city: address?.city ?? '',
      district: address?.district ?? '',
      province: address?.province ?? '',
      postalCode: address?.postalCode ?? '',
      country: address?.country ?? DEFAULT_COUNTRY,
    },
    contact: {
      phones: [...profile.phones],
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

/** The lines of the address as it prints, for the letterhead preview. Empty parts are skipped. */
export function addressLines(draft: AddressDraft): string[] {
  const join = (...parts: string[]) =>
    parts
      .map((p) => p.trim())
      .filter(Boolean)
      .join(', ');
  const hasAny = [
    draft.line1,
    draft.line2,
    draft.city,
    draft.district,
    draft.province,
    draft.postalCode,
  ].some((p) => p.trim() !== '');
  return [
    draft.line1.trim(),
    draft.line2.trim(),
    join(draft.city, draft.district),
    join(draft.province, draft.postalCode),
    hasAny ? countryName(draft.country) : '',
  ].filter(Boolean);
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
  Omit<CompanyProfile, 'panVatNo' | 'logoDocumentId' | 'legacyLogoDataUrl'>
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
  line1: 'address line 1',
  line2: 'address line 2',
  city: 'city',
  district: 'district',
  province: 'province',
  postalCode: 'postal code',
  country: 'country',
};

/** An address with nothing typed is "no address" (null). Otherwise line 1, city and country are required. */
export function parseAddress(draft: AddressDraft): Parsed<Address | null> {
  const typed = (['line1', 'line2', 'city', 'district', 'province', 'postalCode'] as const).some(
    (k) => draft[k].trim() !== '',
  );
  if (!typed) return { ok: true, value: null };
  const errors: FieldErrors = {};
  for (const key of ['line1', 'city'] as const) {
    if (draft[key].trim() === '') errors[key] = `Enter the ${ADDRESS_LABEL[key]}.`;
  }
  const country = draft.country.trim();
  if (!/^[A-Z]{2}$/.test(country)) errors['country'] = 'Choose a country.';
  const candidate: Record<string, string> = { country };
  for (const key of ['line1', 'line2', 'city', 'district', 'province', 'postalCode'] as const) {
    const value = blank(draft[key]);
    if (value !== null) candidate[key] = value;
  }
  const parsed = AddressSchema.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? '');
      if (key in ADDRESS_LABEL && errors[key] === undefined) {
        errors[key] =
          issue.code === 'too_big'
            ? tooLong(Number((issue as { maximum?: number }).maximum ?? 200))
            : `Check the ${ADDRESS_LABEL[key as keyof AddressDraft]}.`;
      }
    }
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: parsed.success ? parsed.data : null };
}

export function parseContact(draft: ContactDraft): Parsed<ProfilePatch> {
  const errors: FieldErrors = {};
  const phones = draft.phones.map((p) => p.trim()).filter(Boolean);
  if (phones.length > MAX_PHONES) errors['phones'] = `Add up to ${MAX_PHONES} phone numbers.`;
  const badPhone = phones.find((p) => !PhoneSchema.safeParse(p).success);
  if (badPhone !== undefined) {
    errors['phones'] =
      'Enter each phone as +977 and the number (a 10-digit mobile starting with 9, or a landline of 7 to 9 digits), or +, the country code and the number.';
  }
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
  address?: Address | null;
}

export interface FormLike {
  get(name: string): unknown;
  getAll(name: string): unknown[];
}

const str = (form: FormLike, name: string): string => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};

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
        line1: str(form, 'line1'),
        line2: str(form, 'line2'),
        city: str(form, 'city'),
        district: str(form, 'district'),
        province: str(form, 'province'),
        postalCode: str(form, 'postalCode'),
        country: str(form, 'country'),
      });
      return r.ok ? { ok: true, value: { address: r.value } } : r;
    }
    case 'contact': {
      const r = parseContact({
        phones: form.getAll('phone').filter((v): v is string => typeof v === 'string'),
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
  // Stored rows may still hold free-text phones or a loose PAN from before the strict contracts; they open as stored.
  const profile = StoredCompanyProfileSchema.safeParse(raw.profile);
  if (!profile.success)
    return { ok: false, message: 'The saved company profile could not be read.' };
  const address = AddressSchema.nullable().safeParse(raw.address);
  if (!address.success) return { ok: false, message: 'The saved address could not be read.' };
  const panVatNo = PanVatNoSchema.nullable().safeParse(raw.panVatNo);
  if (!panVatNo.success)
    return { ok: false, message: 'The saved PAN or VAT number could not be read.' };
  return {
    ok: true,
    data: { profile: profile.data, address: address.data, panVatNo: panVatNo.data },
  };
}
