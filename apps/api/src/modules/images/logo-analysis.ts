// Measuring and recolouring company logo bytes (R6AC), with sharp (libvips). PNG, JPEG and WebP are the only types an
// upload accepts, so no SVG is ever decoded here. Every output is a PNG, because the memo PDF writer cannot embed WebP.
import { rgbLuminance, type LogoStats } from '@bos/contracts';
import sharp from 'sharp';

/** Refuse images that declare more pixels than this (4096 x 4096): a small file can declare a huge canvas. */
const MAX_INPUT_PIXELS = 16_777_216;
const open = (bytes: Buffer) =>
  sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' });

/** The logo is measured at no more than this many pixels on a side: the mean does not need more. */
const MEASURE_SIDE_PX = 96;
/** A pixel with less alpha than this (of 255) counts as transparent. */
const TRANSPARENT_BELOW = 250;
/** The share of transparent pixels from which a one-colour copy keeps the logo's shape (a rounded badge has few). */
const TRANSPARENT_SHARE = 0.1;
/** Space around a logo on its plate, as a share of the longer side. */
const PLATE_PADDING = 0.12;

export class LogoImageUnreadableError extends Error {
  readonly kind = 'logo_image_unreadable';

  constructor() {
    super('The logo image could not be read');
    this.name = 'LogoImageUnreadableError';
  }
}

/**
 * The alpha-weighted mean relative luminance of the visible pixels, and whether the image has transparency. A fully
 * transparent image has nothing to measure and counts as mid-grey with transparency, so it never passes as readable
 * on an extreme background. Throws LogoImageUnreadableError when the bytes do not decode.
 */
export async function measureLogo(bytes: Buffer): Promise<LogoStats> {
  let data: Buffer;
  try {
    ({ data } = await open(bytes)
      .rotate()
      .resize(MEASURE_SIDE_PX, MEASURE_SIDE_PX, { fit: 'inside', withoutEnlargement: true })
      .ensureAlpha()
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true }));
  } catch {
    throw new LogoImageUnreadableError();
  }
  let weight = 0;
  let sum = 0;
  let transparent = 0;
  const pixels = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3]!;
    if (alpha < TRANSPARENT_BELOW) transparent += 1;
    if (alpha === 0) continue;
    weight += alpha;
    sum += alpha * rgbLuminance(data[i]!, data[i + 1]!, data[i + 2]!);
  }
  const hasTransparency = pixels > 0 && transparent / pixels >= TRANSPARENT_SHARE;
  if (weight === 0) return { luminance: 0.5, hasTransparency: true };
  return { luminance: Math.min(1, Math.max(0, sum / weight)), hasTransparency };
}

/** A copy of the logo in one colour with its own alpha: white for a dark background, black for a light one. */
export async function monochromeLogo(bytes: Buffer, colour: 'white' | 'black'): Promise<Buffer> {
  try {
    // Rotate first and read the size of the rotated picture: EXIF orientations 5 to 8 swap width and height.
    const upright = await open(bytes)
      .rotate()
      .ensureAlpha()
      .png()
      .toBuffer({ resolveWithObject: true });
    const { width, height } = upright.info;
    const alpha = await sharp(upright.data).extractChannel(3).png().toBuffer();
    const fill = colour === 'white' ? 255 : 0;
    return await sharp({
      create: { width, height, channels: 3, background: { r: fill, g: fill, b: fill } },
    })
      .joinChannel(alpha)
      .png()
      .toBuffer();
  } catch {
    throw new LogoImageUnreadableError();
  }
}

/** The logo on a white rounded plate with some space around it: the last resort for an opaque logo that fails. */
export async function platedLogo(bytes: Buffer): Promise<Buffer> {
  try {
    const logo = await open(bytes).rotate().png().toBuffer({ resolveWithObject: true });
    const pad = Math.round(Math.max(logo.info.width, logo.info.height) * PLATE_PADDING);
    const width = logo.info.width + pad * 2;
    const height = logo.info.height + pad * 2;
    const radius = Math.round(Math.min(width, height) * 0.1);
    const mask = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" rx="${radius}" ry="${radius}"/></svg>`,
    );
    return await sharp({
      create: { width, height, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
    })
      .composite([
        { input: logo.data, left: pad, top: pad },
        { input: mask, blend: 'dest-in' },
      ])
      .png()
      .toBuffer();
  } catch {
    throw new LogoImageUnreadableError();
  }
}
