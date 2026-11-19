// How a customer document looks and reads: layout, brand colour, company profile, number system, and the saved
// text presets a quotation form offers. One source for the API (renderer, settings validation) and the
// workspace (settings screens, live previews), so a preview can never draw something the PDF cannot.
import { z } from 'zod';

import { PanVatNoSchema } from './crm.js';

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
  ledger: { name: 'Ledger', hint: 'Bordered table with a discount column' },
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

// ---------------------------------------------------------------------------------------------
// Company profile and the settings values
// ---------------------------------------------------------------------------------------------

/** A logo small enough to live in a settings row: PNG, JPEG or SVG as a data URL, at most ~200 KB. */
export const LogoDataUrlSchema = z
  .string()
  .max(280_000)
  .regex(
    /^data:image\/(?:png|jpeg|svg\+xml);base64,[A-Za-z0-9+/=]+$/,
    'must be a PNG, JPEG or SVG image',
  );

/** What the document footer and signature block print about the selling company. */
export const CompanyProfileSchema = z.strictObject({
  displayName: text(120).nullable(),
  logoDataUrl: LogoDataUrlSchema.nullable(),
  phones: z.array(text(40)).max(4),
  email: z.email().max(200).nullable(),
  website: text(200).nullable(),
  /** Printed with the footer next to the address; the PAN/VAT number is its own setting (`entity.pan_vat_no`). */
  panVatNo: PanVatNoSchema.nullable(),
  signatoryName: text(120).nullable(),
  signatoryTitle: text(120).nullable(),
});
export type CompanyProfile = z.infer<typeof CompanyProfileSchema>;

export const EMPTY_COMPANY_PROFILE: CompanyProfile = {
  displayName: null,
  logoDataUrl: null,
  phones: [],
  email: null,
  website: null,
  panVatNo: null,
  signatoryName: null,
  signatoryTitle: null,
};

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
 * Everything the renderer needs that is not the document's own data. Frozen onto a quotation version when
 * its PDF is rendered, so changing a setting later never alters a sent document.
 */
export const DocumentStyleSnapshotSchema = z.strictObject({
  style: DocumentStyleSchema,
  profile: CompanyProfileSchema,
  numberSystem: NumberSystemSchema,
  capturedAt: z.iso.datetime(),
});
export type DocumentStyleSnapshot = z.infer<typeof DocumentStyleSnapshotSchema>;

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
  body: text(10_000),
});
export type TermPreset = z.infer<typeof TermPresetSchema>;

/** The whole saved list (one settings value). Names are unique within a kind. */
export const TermPresetListSchema = z
  .array(TermPresetSchema)
  .max(200)
  .refine(
    (list) => new Set(list.map((p) => `${p.kind}:${p.name.toLowerCase()}`)).size === list.length,
    'preset names must be unique within a field',
  );
export type TermPresetList = z.infer<typeof TermPresetListSchema>;
