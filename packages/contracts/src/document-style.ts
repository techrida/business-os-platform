// How a customer document looks and reads: layout, brand colour, company profile, number system, and the saved
// text presets a quotation form offers. One source for the API (renderer, settings validation) and the
// workspace (settings screens, live previews), so a preview can never draw something the PDF cannot.
import { z } from 'zod';

import { CountryCodeSchema } from './countries.js';
import { NepalPanSchema, PanVatNoSchema } from './crm.js';
import { formatPartyPhoneForPrint, PhoneLabelSchema, phoneProblem } from './phones.js';
import { CURRENCIES, type Currency } from './money.js';
import { richTextSchema } from './rich-text.js';

const text = (max: number) => z.string().trim().min(1).max(max);

// ---------------------------------------------------------------------------------------------
// Layouts and colour
// ---------------------------------------------------------------------------------------------

/** The quotation layouts. Every one prints the same data; only the arrangement and the use of colour differ. */
export const DOCUMENT_LAYOUTS = ['banded', 'duo-cards', 'ledger', 'side-labels', 'tinted'] as const;
export const DocumentLayoutSchema = z.enum(DOCUMENT_LAYOUTS);
export type DocumentLayout = z.infer<typeof DocumentLayoutSchema>;

export const DOCUMENT_LAYOUT_LABELS: Record<DocumentLayout, { name: string; hint: string }> = {
  banded: { name: 'Banded', hint: 'Colour band across the top, details beside the client' },
  'duo-cards': { name: 'Two cards', hint: 'From and To in side-by-side cards' },
  ledger: { name: 'Ledger', hint: 'Bordered table with boxed totals' },
  'side-labels': { name: 'Side labels', hint: 'Labelled blocks down the left edge' },
  tinted: { name: 'Tinted header', hint: 'Soft tinted header and totals' },
};

export const HexColourSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'use a 6-digit hex colour such as #1d4ed8')
  .transform((v) => v.toLowerCase());

/** The dots the colour selector shows before "custom". Each one passes contrast with its own text colour. */
export const PRESET_BRAND_COLOURS = [
  { name: 'Ocean', hex: '#1d4ed8' },
  { name: 'Teal', hex: '#0f766e' },
  { name: 'Forest', hex: '#15803d' },
  { name: 'Amber', hex: '#b45309' },
  { name: 'Crimson', hex: '#be123c' },
  { name: 'Violet', hex: '#6d28d9' },
  { name: 'Slate', hex: '#334155' },
] as const;
export const DEFAULT_BRAND_COLOUR = PRESET_BRAND_COLOURS[0].hex;

type Rgb = readonly [number, number, number];

export function hexToRgb(hex: string): Rgb {
  const h = HexColourSchema.parse(hex).slice(1);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function rgbToHex([r, g, b]: Rgb): string {
  const c = (n: number) =>
    Math.round(Math.min(255, Math.max(0, n)))
      .toString(16)
      .padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** WCAG 2.x relative luminance. */
export function relativeLuminance(hex: string): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Mix `hex` toward `toward` by `amount` (0 = hex, 1 = toward). */
export function mixHex(hex: string, toward: string, amount: number): string {
  const a = hexToRgb(hex);
  const b = hexToRgb(toward);
  return rgbToHex([
    a[0] + (b[0] - a[0]) * amount,
    a[1] + (b[1] - a[1]) * amount,
    a[2] + (b[2] - a[2]) * amount,
  ]);
}

const WHITE = '#ffffff';
const INK = '#111827';
const MIN_TEXT_CONTRAST = 4.5;

/** White if it reads at 4.5:1, else ink, else black (a mid-tone can fail both white and ink; black never fails). */
function readableOn(background: string): string {
  if (contrastRatio(WHITE, background) >= MIN_TEXT_CONTRAST) return WHITE;
  if (contrastRatio(INK, background) >= MIN_TEXT_CONTRAST) return INK;
  return '#000000';
}

export interface BrandPalette {
  /** The colour the tenant picked. */
  primary: string;
  /** Text on `primary` (white or ink, whichever reads better). */
  onPrimary: string;
  /** A deeper shade for lines and table heads. */
  deep: string;
  /** Pale wash for header bands and zebra rows. */
  tint: string;
  /** A little stronger wash for borders on tinted areas. */
  tintStrong: string;
  /** Text on `tint`: the primary itself if it reads at 4.5:1, else darkened until it does. */
  onTint: string;
  /** Primary as text on white: darkened until it reads at 4.5:1. */
  accentText: string;
}

function darkenUntilReadable(hex: string, background: string): string {
  let c = hex;
  for (let i = 0; i < 20 && contrastRatio(c, background) < MIN_TEXT_CONTRAST; i += 1) {
    c = mixHex(c, '#000000', 0.12);
  }
  return c;
}

/** Every tone a document uses, derived from the one colour the tenant picks. Pure and deterministic. */
export function deriveBrandPalette(primaryHex: string): BrandPalette {
  const primary = HexColourSchema.parse(primaryHex);
  const tint = mixHex(primary, WHITE, 0.92);
  return {
    primary,
    onPrimary: readableOn(primary),
    deep: mixHex(primary, '#000000', 0.28),
    tint,
    tintStrong: mixHex(primary, WHITE, 0.8),
    onTint: darkenUntilReadable(primary, tint),
    accentText: darkenUntilReadable(primary, WHITE),
  };
}

// ---------------------------------------------------------------------------------------------
// Number system
// ---------------------------------------------------------------------------------------------

/** Mirrors `NumberSystem` in @bos/locale (that package has no dependency on this one). */
export const NUMBER_SYSTEM_VALUES = ['south_asian', 'international'] as const;
export const NumberSystemSchema = z.enum(NUMBER_SYSTEM_VALUES);
export type NumberSystemSetting = z.infer<typeof NumberSystemSchema>;

export const NUMBER_SYSTEM_LABELS: Record<NumberSystemSetting, { name: string; example: string }> =
  {
    south_asian: { name: 'South Asian (lakh, crore)', example: '20,18,180.00' },
    international: { name: 'International (million, billion)', example: '2,018,180.00' },
  };

/** One number system per currency (D30). Mirrors `NumberSystems` in @bos/locale. */
export const NumberSystemsSchema = z.strictObject(
  Object.fromEntries(CURRENCIES.map((c) => [c, NumberSystemSchema])) as Record<
    Currency,
    typeof NumberSystemSchema
  >,
);
export type NumberSystemsSetting = z.infer<typeof NumberSystemsSchema>;

/** NPR and INR write lakh/crore; USD writes thousand/million: what the app did before the setting existed. */
export const DEFAULT_NUMBER_SYSTEMS: NumberSystemsSetting = {
  NPR: 'south_asian',
  INR: 'south_asian',
  USD: 'international',
};

/** The date patterns for customer-facing documents. Mirrors `CustomerDateFormat` in @bos/locale. */
export const DATE_FORMAT_VALUES = [
  'dd MMM yyyy',
  'dd/MM/yyyy',
  'yyyy-MM-dd',
  'MMM dd, yyyy',
] as const;
export const DateFormatSchema = z.enum(DATE_FORMAT_VALUES);
export type DateFormatSetting = z.infer<typeof DateFormatSchema>;
export const DEFAULT_DATE_FORMAT: DateFormatSetting = 'dd MMM yyyy';

// ---------------------------------------------------------------------------------------------
// Company profile and the settings values
// ---------------------------------------------------------------------------------------------

/**
 * A logo inlined into a document: PNG, JPEG or WebP as a data URL (no SVG: script risk). The cap fits a 512 KiB
 * image once base64 encoded (4/3 of the bytes plus the prefix).
 */
export const LogoDataUrlSchema = z
  .string()
  .max(720_000)
  .regex(
    /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/,
    'must be a PNG, JPEG or WebP image',
  );

/** The most phone numbers the company profile prints. */
export const MAX_COMPANY_PHONES = 4;

/**
 * One phone number of the company profile (FX9): its country and the E.164 number, which must be valid for that
 * country (Nepal keeps FX8's mobile and landline rules), and an optional label. There is no primary flag: the list
 * order is the print order.
 */
export const CompanyPhoneSchema = z
  .strictObject({
    country: CountryCodeSchema,
    e164: z.string(),
    label: PhoneLabelSchema.nullable().optional(),
  })
  .superRefine((phone, ctx) => {
    const problem = phoneProblem(phone.country, phone.e164);
    if (problem !== null) ctx.addIssue({ code: 'custom', message: problem, path: ['e164'] });
  });
export type CompanyPhone = z.infer<typeof CompanyPhoneSchema>;

/**
 * The stored setting `entity.profile`, read and written with the same strict rules (FX9: no legacy rows to
 * tolerate). Phones carry their own country; the PAN is the company's own nine digits. The logo is a scanned
 * document, referenced by id; the bytes are never in the setting. `legacyLogoDataUrl` is set only by migration 0058
 * for a logo saved before logos were documents, and is cleared once that logo is uploaded as a document; reads fall
 * back to it until then.
 */
export const CompanyProfileSchema = z.strictObject({
  displayName: text(120).nullable(),
  phones: z.array(CompanyPhoneSchema).max(MAX_COMPANY_PHONES),
  email: z.email().max(200).nullable(),
  website: text(200).nullable(),
  /** Printed with the footer next to the address; the PAN/VAT number is its own setting (`entity.pan_vat_no`). */
  panVatNo: NepalPanSchema.nullable(),
  signatoryName: text(120).nullable(),
  signatoryTitle: text(120).nullable(),
  logoDocumentId: z.guid().nullable().default(null),
  /** Optional logo for dark backgrounds (the reversed or light version), and for light backgrounds (the dark one). */
  logoOnDarkDocumentId: z.guid().nullable().default(null),
  logoOnLightDocumentId: z.guid().nullable().default(null),
  legacyLogoDataUrl: LogoDataUrlSchema.nullable().optional(),
});
export type CompanyProfile = z.infer<typeof CompanyProfileSchema>;

export const EMPTY_COMPANY_PROFILE: CompanyProfile = {
  displayName: null,
  logoDocumentId: null,
  logoOnDarkDocumentId: null,
  logoOnLightDocumentId: null,
  phones: [],
  email: null,
  website: null,
  panVatNo: null,
  signatoryName: null,
  signatoryTitle: null,
};

/**
 * The profile as frozen onto a document: the logo is its bytes, so changing or removing the logo later never alters
 * a document already sent. This is the shape every stored snapshot already has. A snapshot is a sent document, not
 * a setting, so it keeps the shape it was frozen with: phones are strings (E.164 since FX9, free text before) and the
 * PAN is the loose 5 to 20 characters.
 */
export const SnapshotCompanyProfileSchema = z.strictObject({
  displayName: text(120).nullable(),
  logoDataUrl: LogoDataUrlSchema.nullable(),
  phones: z.array(text(40)).max(MAX_COMPANY_PHONES),
  email: z.email().max(200).nullable(),
  website: text(200).nullable(),
  panVatNo: PanVatNoSchema.nullable(),
  signatoryName: text(120).nullable(),
  signatoryTitle: text(120).nullable(),
});
export type SnapshotCompanyProfile = z.infer<typeof SnapshotCompanyProfileSchema>;

export const EMPTY_SNAPSHOT_COMPANY_PROFILE: SnapshotCompanyProfile = {
  displayName: null,
  logoDataUrl: null,
  phones: [],
  email: null,
  website: null,
  panVatNo: null,
  signatoryName: null,
  signatoryTitle: null,
};

/** The snapshot profile from the stored setting and the logo bytes resolved for it (null: no logo). Pure. */
export function snapshotProfileFrom(
  profile: CompanyProfile,
  logoDataUrl: string | null,
): SnapshotCompanyProfile {
  return {
    displayName: profile.displayName,
    logoDataUrl,
    phones: profile.phones.map((phone) => phone.e164),
    email: profile.email,
    website: profile.website,
    panVatNo: profile.panVatNo,
    signatoryName: profile.signatoryName,
    signatoryTitle: profile.signatoryTitle,
  };
}

export const DocumentStyleSchema = z.strictObject({
  layout: DocumentLayoutSchema,
  primaryColour: HexColourSchema,
});
export type DocumentStyle = z.infer<typeof DocumentStyleSchema>;

export const DEFAULT_DOCUMENT_STYLE: DocumentStyle = {
  layout: 'banded',
  primaryColour: DEFAULT_BRAND_COLOUR,
};

/**
 * The colour of the area a quotation layout prints the logo on (R6AC), from the palette the layout itself draws with:
 * the banded layout's solid band, the tinted layout's tint band, and white paper for every other layout. The logo
 * choice (chooseLogo) is made against this colour; a test holds each layout's CSS to it.
 */
export function logoBackgroundHex(style: DocumentStyle): string {
  const palette = deriveBrandPalette(style.primaryColour);
  if (style.layout === 'banded') return palette.primary;
  if (style.layout === 'tinted') return palette.tint;
  return '#ffffff';
}

/** Paper: the background of an invoice, a purchase order and the settings letterhead preview. */
export const PAPER_LOGO_BACKGROUND = '#ffffff';

/**
 * Everything the renderer needs that is not the document's own data. Frozen onto a quotation version when
 * its PDF is rendered, so changing a setting later never alters a sent document.
 */
export const DocumentStyleSnapshotSchema = z
  .strictObject({
    style: DocumentStyleSchema,
    profile: SnapshotCompanyProfileSchema,
    /** Snapshots taken before D30 hold one system for every currency; new ones hold `numberSystems`. */
    numberSystem: NumberSystemSchema.optional(),
    numberSystems: NumberSystemsSchema.optional(),
    /** Absent on snapshots taken before the date format existed: they print the default. */
    dateFormat: DateFormatSchema.optional(),
    /**
     * The colour the frozen logo was chosen against (R6AC), set when the logo came from an uploaded document. A
     * snapshot without it (an older one, a legacy logo) was not chosen for any background, so the banded layout keeps
     * the white plate behind it.
     */
    logoForBackground: HexColourSchema.optional(),
    capturedAt: z.iso.datetime(),
  })
  .refine((v) => v.numberSystem !== undefined || v.numberSystems !== undefined, {
    message: 'a snapshot needs numberSystems (or the legacy numberSystem)',
  });
export type DocumentStyleSnapshot = z.infer<typeof DocumentStyleSnapshotSchema>;

/**
 * How to reach the selling company, as a printed or on-screen customer document shows it (U16-Q4): the phones, email
 * and signatory of the company profile and nothing else. The address and PAN/VAT number come from the document's own
 * frozen seller, never from here.
 */
export const DocumentSellerContactSchema = z.strictObject({
  phones: z.array(z.string()),
  email: z.string().nullable(),
  signatoryName: z.string().nullable(),
  signatoryTitle: z.string().nullable(),
});
export type DocumentSellerContact = z.infer<typeof DocumentSellerContactSchema>;

/**
 * The customer-facing contact of a stored `entity.profile`, named key by key so the logo, display name, website or a
 * key added later never reach a document. Phones come out in print form (`formatPartyPhoneForPrint`: FX8's format for
 * Nepal, international for any other country); printing them again changes nothing. Null when the stored value does
 * not validate against the strict profile (a row edited by hand, or one from before FX9): the document then prints no
 * contact block rather than failing.
 */
export function documentSellerContact(rawProfile: unknown): DocumentSellerContact | null {
  const profile = CompanyProfileSchema.safeParse(rawProfile);
  if (!profile.success) return null;
  return {
    phones: profile.data.phones.map((phone) => formatPartyPhoneForPrint(phone.e164)),
    email: profile.data.email,
    signatoryName: profile.data.signatoryName,
    signatoryTitle: profile.data.signatoryTitle,
  };
}

/**
 * The number grouping, date pattern, company logo and seller contact a document was printed with. Invoices keep it on
 * their first print so a copy printed later looks the same; purchase orders print once and use the settings in force
 * at that moment.
 */
export const DocumentFormatSnapshotSchema = z.strictObject({
  numberSystems: NumberSystemsSchema,
  dateFormat: DateFormatSchema,
  /**
   * The entity logo's bytes at the first print (U12), so changing or removing the logo never alters a copy. Null: no
   * logo. Absent on documents printed before logos were frozen: they stay logo-less.
   */
  logoDataUrl: LogoDataUrlSchema.nullable().optional(),
  /**
   * The seller's phones, email and signatory at the first print (U16-Q4), so a profile edit never alters a copy. Null:
   * the profile could not be read then. Absent on documents printed before contacts were frozen: they stay without.
   */
  sellerContact: DocumentSellerContactSchema.nullable().optional(),
  capturedAt: z.iso.datetime(),
});
export type DocumentFormatSnapshot = z.infer<typeof DocumentFormatSnapshotSchema>;

/** What a stored snapshot printed: its per-currency map, else its single legacy system for every currency. */
export function snapshotNumberSystems(snapshot: DocumentStyleSnapshot): NumberSystemsSetting {
  if (snapshot.numberSystems) return snapshot.numberSystems;
  const legacy = snapshot.numberSystem ?? 'south_asian';
  return { NPR: legacy, INR: legacy, USD: legacy };
}

// ---------------------------------------------------------------------------------------------
// Term presets
// ---------------------------------------------------------------------------------------------

/** The quotation fields that offer saved wording. */
export const TERM_PRESET_KINDS = [
  'payment_terms',
  'terms_conditions',
  'scope',
  'assumptions',
  'exclusions',
  'delivery_timeline',
] as const;
export const TermPresetKindSchema = z.enum(TERM_PRESET_KINDS);
export type TermPresetKind = z.infer<typeof TermPresetKindSchema>;

export const TERM_PRESET_KIND_LABELS: Record<TermPresetKind, string> = {
  payment_terms: 'Payment terms',
  terms_conditions: 'Terms and conditions',
  scope: 'Scope',
  assumptions: 'Assumptions',
  exclusions: 'Exclusions',
  delivery_timeline: 'Delivery timeline',
};

export const TermPresetSchema = z.strictObject({
  id: z.guid(),
  kind: TermPresetKindSchema,
  name: text(80),
  /** Rich text (D31): sanitised HTML from the editor, or plain text saved before it existed. */
  body: richTextSchema(10_000),
  /** The kind's default: new records start with this text (UIP-FORM-012). At most one per kind; absent means not the default. */
  isDefault: z.boolean().optional(),
});
export type TermPreset = z.infer<typeof TermPresetSchema>;

/** The whole saved list (one settings value). Names are unique within a kind. */
export const TermPresetListSchema = z
  .array(TermPresetSchema)
  .max(200)
  .refine(
    (list) => new Set(list.map((p) => `${p.kind}:${p.name.toLowerCase()}`)).size === list.length,
    'preset names must be unique within a field',
  )
  .refine((list) => {
    const kinds = list.filter((p) => p.isDefault === true).map((p) => p.kind);
    return new Set(kinds).size === kinds.length;
  }, 'only one default per field');
export type TermPresetList = z.infer<typeof TermPresetListSchema>;

/**
 * The sets every company starts with (D31). They are the default of `quotation.term_presets`, so a company that
 * never saved the key sees them, and "reset to default" brings them back. The ids are fixed so a reset is stable.
 */
export const DEFAULT_TERM_PRESETS: TermPresetList = [
  {
    id: '6c1e8a40-5b0b-4f0e-9a52-0c8d1a7e0001',
    kind: 'terms_conditions',
    name: 'Casual website terms',
    body:
      '<p><strong>Website project terms</strong></p>' +
      '<ul><li>Fifty percent is due before work starts and the balance on launch.</li>' +
      '<li>The price covers the pages and features listed in the scope. Extra work is quoted separately.</li>' +
      '<li>We need your content, logo and feedback within the times we agree. Delays on your side can move the launch date.</li>' +
      '<li>Two rounds of changes are included. Further rounds are charged by the hour.</li>' +
      '<li>You own the finished site once the invoice is paid in full.</li></ul>',
  },
  {
    id: '6c1e8a40-5b0b-4f0e-9a52-0c8d1a7e0002',
    kind: 'terms_conditions',
    name: 'Software project terms',
    body:
      '<p><strong>Software project terms</strong></p>' +
      '<ol><li>Work follows the milestones in the payment schedule. A milestone is payable when it is delivered for review.</li>' +
      '<li>Anything outside the scope and assumptions is a change request. We quote it and start it only after you approve.</li>' +
      '<li>You review each delivery within <strong>seven days</strong>. Silence after that counts as acceptance.</li>' +
      '<li>Confidential material shared by either side stays confidential.</li>' +
      '<li>Either side may end the work with written notice. You pay for work done up to that date.</li></ol>',
  },
  {
    id: '6c1e8a40-5b0b-4f0e-9a52-0c8d1a7e0003',
    kind: 'terms_conditions',
    name: 'Support and maintenance terms',
    body:
      '<p><strong>Support and maintenance terms</strong></p>' +
      '<ul><li>The fee is charged <em>in advance</em> for each period and is not refunded for unused time.</li>' +
      '<li>Support covers fixes and questions about what we delivered. New features are quoted separately.</li>' +
      '<li>We reply within one working day. Urgent faults that stop your business are looked at first.</li>' +
      '<li>Either side can end the arrangement with thirty days of written notice.</li></ul>',
  },
  {
    id: '6c1e8a40-5b0b-4f0e-9a52-0c8d1a7e0004',
    kind: 'payment_terms',
    name: 'Half up front',
    body:
      '<ul><li><strong>50%</strong> when you accept this quotation.</li>' +
      '<li><strong>50%</strong> when the work is delivered.</li></ul>' +
      '<p>Invoices are payable within the term shown above.</p>',
  },
];

/**
 * A phone number as a letterhead, quotation or invoice prints it. A Nepal mobile is `+977 9812345678`; a landline
 * puts its area code first, `+977 1-4123456` (Kathmandu, one digit) and `+977 61-523456` (two digits). A valid
 * number from abroad prints in international format (`+1 415 555 2671`). Any other text, such as a free-text value
 * frozen onto a document before phones were E.164, prints as it is. Applied to an already formatted number it changes
 * nothing. The same rule as `formatPartyPhoneForPrint`, kept under this name for the renderers that print a string.
 */
export function formatPhoneForPrint(phone: string): string {
  return formatPartyPhoneForPrint(phone);
}
