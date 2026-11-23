// Which logo to print on which background (R6AC). A company may upload a primary logo and, optionally, one for dark
// backgrounds (the "reversed" or light version) and one for light backgrounds (the dark version). The primary is used
// unless it would be hard to see on the background it lands on; then the variant made for that background; then, for
// a logo with transparency, a one-colour (white or black) copy of the primary; and last the primary on a white plate.
//
// The test is WCAG 2.2 success criterion 1.4.11 (Non-text Contrast): a graphical object needs a contrast ratio of at
// least 3:1 against its adjacent colours. The ratio is (L1 + 0.05) / (L2 + 0.05) on relative luminance (WCAG 2.2
// "relative luminance" and "contrast ratio" definitions, https://www.w3.org/TR/WCAG22/#dfn-contrast-ratio).
//
// A logo's luminance is one number: the mean relative luminance of its visible pixels, each weighted by its alpha, so
// transparent pixels never count. A logo that mixes dark and light parts averages out near the middle; it then fails
// the 3:1 test on both a dark and a light background, so the variant or the plate decides, which is the safe side.
import { z } from 'zod';

/** The contrast ratio a logo needs against its background (WCAG 1.4.11, non-text contrast). */
export const MIN_LOGO_CONTRAST = 3;

/** WCAG relative luminance of one sRGB channel (0..255) as a linear value. */
export function linearChannel(value: number): number {
  const c = Math.min(255, Math.max(0, value)) / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance (0 black, 1 white) of an sRGB colour. */
export function rgbLuminance(red: number, green: number, blue: number): number {
  return 0.2126 * linearChannel(red) + 0.7152 * linearChannel(green) + 0.0722 * linearChannel(blue);
}

/** WCAG contrast ratio (1..21) of two relative luminances (numbers; `contrastRatio` takes hex colours), in either order. */
export function luminanceContrast(a: number, b: number): number {
  const light = Math.max(a, b);
  const dark = Math.min(a, b);
  return (light + 0.05) / (dark + 0.05);
}

export type BackgroundKind = 'dark' | 'light';

/**
 * Whether a background is dark or light for choosing a logo: dark when white text would contrast better with it than
 * black would (the crossover is a luminance of about 0.179, not 0.5). An unreadable colour counts as light (paper).
 */
export function backgroundKind(backgroundLuminance: number): BackgroundKind {
  return luminanceContrast(1, backgroundLuminance) > luminanceContrast(0, backgroundLuminance)
    ? 'dark'
    : 'light';
}

/** What is known about one stored logo image. `luminance` is null when it could not be measured. */
export const LogoStatsSchema = z.strictObject({
  /** Alpha-weighted mean relative luminance of the visible pixels, 0..1. */
  luminance: z.number().min(0).max(1),
  /** True when the image has transparent pixels, so a one-colour copy keeps its shape. */
  hasTransparency: z.boolean(),
});
export type LogoStats = z.infer<typeof LogoStatsSchema>;

/** What was uploaded: the primary, and a variant per background kind when the company supplied one. */
export interface LogoSet<T = LogoStats> {
  primary: T;
  forDark: T | null;
  forLight: T | null;
}

/** The logo to print, as a choice among what the company supplied and what can be made from the primary. */
export type LogoChoice =
  | { use: 'primary' }
  | { use: 'forDark' }
  | { use: 'forLight' }
  /** A one-colour copy of the primary: white on a dark background, black on a light one. Needs transparency. */
  | { use: 'mono'; colour: 'white' | 'black' }
  /** Nothing reaches 3:1 and the primary is opaque: print the primary on a white plate. */
  | { use: 'plate' };

const reaches = (logo: LogoStats, background: number): boolean =>
  luminanceContrast(logo.luminance, background) >= MIN_LOGO_CONTRAST;

/**
 * The logo for a background. The primary when it reaches 3:1; else the variant made for this background kind when it
 * reaches 3:1 itself; else a white or black copy of the primary when the primary has transparency; else the plate.
 * An upload that is the wrong way round (a light logo in the "for light backgrounds" slot) never wins: it is
 * checked against the background like any other.
 */
export function chooseLogo(set: LogoSet, backgroundLuminance: number): LogoChoice {
  if (reaches(set.primary, backgroundLuminance)) return { use: 'primary' };
  const kind = backgroundKind(backgroundLuminance);
  const variant = kind === 'dark' ? set.forDark : set.forLight;
  if (variant !== null && reaches(variant, backgroundLuminance)) {
    return { use: kind === 'dark' ? 'forDark' : 'forLight' };
  }
  if (set.primary.hasTransparency) {
    return { use: 'mono', colour: kind === 'dark' ? 'white' : 'black' };
  }
  return { use: 'plate' };
}
