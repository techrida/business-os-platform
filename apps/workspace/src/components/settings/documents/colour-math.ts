// Pure colour helpers for the brand colour picker. No React, no DOM.

/** Hue in degrees (0 to 360, 360 wraps to 0); saturation and value as fractions (0 to 1). */
export interface Hsv {
  readonly h: number;
  readonly s: number;
  readonly v: number;
}

const HEX_BODY = /^[0-9a-f]{6}$/;
const HEX_SHORT = /^[0-9a-f]{3}$/;

/**
 * Accepts "1d4ed8", "#1D4ED8" and 3-digit shorthand ("#abc" or "abc"), ignoring surrounding
 * whitespace. Returns lowercase "#rrggbb", or null when the text is not a hex colour.
 */
export function normalizeHex(text: string): string | null {
  const body = text.trim().replace(/^#/, '').toLowerCase();
  if (HEX_BODY.test(body)) return `#${body}`;
  if (HEX_SHORT.test(body)) {
    const [r, g, b] = body;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return null;
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** Converts a hex colour to HSV, or null when the text is not a hex colour. Hue is 0 for greys. */
export function hexToHsv(hex: string): Hsv | null {
  const normal = normalizeHex(hex);
  if (!normal) return null;
  const r = parseInt(normal.slice(1, 3), 16) / 255;
  const g = parseInt(normal.slice(3, 5), 16) / 255;
  const b = parseInt(normal.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  let h = 0;
  if (delta !== 0) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: max === 0 ? 0 : delta / max, v: max };
}

/** Converts HSV to lowercase "#rrggbb". Out-of-range input is clamped; hue wraps. */
export function hsvToHex({ h, s, v }: Hsv): string {
  const hue = ((h % 360) + 360) % 360;
  const sat = clamp(s, 0, 1);
  const val = clamp(v, 0, 1);
  const chroma = val * sat;
  const sector = hue / 60;
  const x = chroma * (1 - Math.abs((sector % 2) - 1));
  const [r1, g1, b1] =
    sector < 1
      ? [chroma, x, 0]
      : sector < 2
        ? [x, chroma, 0]
        : sector < 3
          ? [0, chroma, x]
          : sector < 4
            ? [0, x, chroma]
            : sector < 5
              ? [x, 0, chroma]
              : [chroma, 0, x];
  const m = val - chroma;
  const channel = (n: number) =>
    Math.round((n + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(r1)}${channel(g1)}${channel(b1)}`;
}

/** Plain-words reading of a WCAG contrast ratio for the picker's feedback line. */
export function contrastWords(ratio: number): string {
  if (ratio >= 7) return 'Excellent contrast';
  if (ratio >= 4.5) return 'Good contrast';
  return 'Low contrast';
}
