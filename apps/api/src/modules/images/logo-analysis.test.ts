import { chooseLogo, relativeLuminance } from '@bos/contracts';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { measureLogo, monochromeLogo, platedLogo } from './logo-analysis';

/** A 40 x 40 PNG: a `colour` square in the middle of a transparent (or opaque white) field. */
async function logo(colour: string, opts: { transparent: boolean }): Promise<Buffer> {
  const square = await sharp({
    create: { width: 20, height: 20, channels: 3, background: colour },
  })
    .png()
    .toBuffer();
  return await sharp({
    create: {
      width: 40,
      height: 40,
      channels: 4,
      background: opts.transparent
        ? { r: 0, g: 0, b: 0, alpha: 0 }
        : { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite([{ input: square, left: 10, top: 10 }])
    .png()
    .toBuffer();
}

const pixel = async (bytes: Buffer, x: number, y: number) => {
  const { data } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const meta = await sharp(bytes).metadata();
  const at = (y * (meta.width ?? 0) + x) * 4;
  return [data[at]!, data[at + 1]!, data[at + 2]!, data[at + 3]!];
};

describe('measureLogo', () => {
  it('ignores transparent pixels: a black mark on a transparent field is dark, not mid-grey', async () => {
    const stats = await measureLogo(await logo('#000000', { transparent: true }));
    expect(stats.luminance).toBeLessThan(0.01);
    expect(stats.hasTransparency).toBe(true);
  });

  it('reads a white mark on a transparent field as light', async () => {
    const stats = await measureLogo(await logo('#ffffff', { transparent: true }));
    expect(stats.luminance).toBeGreaterThan(0.99);
  });

  it('counts an opaque white field as part of the logo and reports no transparency', async () => {
    const stats = await measureLogo(await logo('#000000', { transparent: false }));
    expect(stats.hasTransparency).toBe(false);
    expect(stats.luminance).toBeGreaterThan(0.5);
  });

  it('refuses bytes that are not an image', async () => {
    await expect(measureLogo(Buffer.from('not an image'))).rejects.toThrow(/could not be read/);
  });
});

describe('monochromeLogo', () => {
  it('keeps the shape and paints it white', async () => {
    const out = await monochromeLogo(await logo('#1d4ed8', { transparent: true }), 'white');
    expect(await pixel(out, 20, 20)).toEqual([255, 255, 255, 255]);
    expect((await pixel(out, 2, 2))[3]).toBe(0);
  });

  it('paints a black copy for a light background', async () => {
    const out = await monochromeLogo(await logo('#fde68a', { transparent: true }), 'black');
    expect(await pixel(out, 20, 20)).toEqual([0, 0, 0, 255]);
  });
});

describe('monochromeLogo on an EXIF-rotated picture', () => {
  it('still makes the copy (width and height swap for orientations 5 to 8)', async () => {
    const wide = await sharp({
      create: {
        width: 60,
        height: 20,
        channels: 4,
        background: { r: 10, g: 10, b: 10, alpha: 0.5 },
      },
    })
      .withMetadata({ orientation: 6 })
      .png()
      .toBuffer();
    const out = await monochromeLogo(wide, 'white');
    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height]).toEqual([20, 60]);
  });
});

describe('platedLogo', () => {
  it('puts the logo on an opaque white plate larger than the logo', async () => {
    const out = await platedLogo(await logo('#000000', { transparent: false }));
    const meta = await sharp(out).metadata();
    expect(meta.width).toBeGreaterThan(40);
    const stats = await measureLogo(out);
    expect(stats.luminance).toBeGreaterThan(0.5);
  });
});

describe('measured logos through the contrast choice', () => {
  const blue = relativeLuminance('#1d4ed8');

  it('a dark logo on a blue header is not used as is: a transparent one becomes white', async () => {
    const primary = await measureLogo(await logo('#111111', { transparent: true }));
    expect(chooseLogo({ primary, forDark: null, forLight: null }, blue)).toEqual({
      use: 'mono',
      colour: 'white',
    });
  });

  it('a light logo on white takes the variant for light backgrounds', async () => {
    const primary = await measureLogo(await logo('#f5f5f5', { transparent: true }));
    const dark = await measureLogo(await logo('#202020', { transparent: true }));
    expect(chooseLogo({ primary, forDark: null, forLight: dark }, 1)).toEqual({ use: 'forLight' });
  });
});
