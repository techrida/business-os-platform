import { IMAGE_MAX_BYTES } from '@bos/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ImageRefusal,
  outputFileName,
  outputTypeFor,
  shrinkImage,
  sniffImageType,
  targetSize,
} from './image-resize';

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d];
const JPEG_HEAD = [0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1];
const WEBP_HEAD = [0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];
const ascii = (text: string) => Array.from(text, (char) => char.charCodeAt(0));

describe('sniffImageType', () => {
  it.each([
    ['PNG', PNG_HEAD, 'image/png'],
    ['JPEG', JPEG_HEAD, 'image/jpeg'],
    ['WebP', WEBP_HEAD, 'image/webp'],
    ['RIFF WAVE audio', [...ascii('RIFF'), 0x24, 0, 0, 0, ...ascii('WAVE')], null],
    ['SVG', ascii('<svg xmlns="'), null],
    ['XML-prefixed SVG', ascii('<?xml version'), null],
    ['GIF', ascii('GIF89a......'), null],
    ['truncated WebP (11 bytes)', WEBP_HEAD.slice(0, 11), null],
    ['truncated PNG', PNG_HEAD.slice(0, 7), null],
    ['empty', [], null],
  ])('%s', (_label, bytes, expected) => {
    expect(sniffImageType(new Uint8Array(bytes))).toBe(expected);
  });
});

describe('targetSize', () => {
  it('scales the longest side of a landscape picture to the limit and keeps the aspect', () => {
    expect(targetSize(2048, 1024, 512)).toEqual({ width: 512, height: 256 });
  });

  it('scales a portrait picture the same way', () => {
    expect(targetSize(1000, 3000, 512)).toEqual({ width: 171, height: 512 });
  });

  it('never upscales a small picture', () => {
    expect(targetSize(100, 40, 512)).toEqual({ width: 100, height: 40 });
    expect(targetSize(512, 512, 512)).toEqual({ width: 512, height: 512 });
  });

  it('keeps at least one pixel on a very thin picture', () => {
    expect(targetSize(10000, 1, 512)).toEqual({ width: 512, height: 1 });
    expect(targetSize(1, 10000, 512)).toEqual({ width: 1, height: 512 });
  });
});

describe('outputTypeFor', () => {
  it.each([
    ['image/jpeg', 'image/jpeg'],
    ['image/png', 'image/png'],
    ['image/webp', 'image/png'],
  ] as const)('%s comes out as %s', (source, output) => {
    expect(outputTypeFor(source)).toBe(output);
  });
});

describe('outputFileName', () => {
  it.each([
    ['logo.webp', 'image/png', 'logo.png'],
    ['Company Logo.JPEG', 'image/jpeg', 'Company Logo.jpg'],
    ['photo.final.png', 'image/png', 'photo.final.png'],
    ['noext', 'image/png', 'noext.png'],
    ['.png', 'image/png', 'image.png'],
    ['', 'image/jpeg', 'image.jpg'],
  ] as const)('%s as %s is %s', (name, type, expected) => {
    expect(outputFileName(name, type)).toBe(expected);
  });
});

describe('shrinkImage', () => {
  type Ops = { fills: number; draws: Array<[number, number]>; encodes: Array<{ type?: string; quality?: number }> };

  function stubBrowser(source: { width: number; height: number }, blobSizes: number[]) {
    const ops: Ops = { fills: 0, draws: [], encodes: [] };
    const canvases: Array<{ width: number; height: number }> = [];
    const close = vi.fn();
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ ...source, close })),
    );
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        constructor(
          public width: number,
          public height: number,
        ) {
          canvases.push({ width, height });
        }
        getContext() {
          return {
            fillStyle: '',
            fillRect: () => {
              ops.fills += 1;
            },
            drawImage: (_bitmap: unknown, _x: number, _y: number, w: number, h: number) => {
              ops.draws.push([w, h]);
            },
          };
        }
        async convertToBlob(options: { type?: string; quality?: number }) {
          ops.encodes.push(options);
          const size = blobSizes[ops.encodes.length - 1] ?? 10;
          return new Blob([new Uint8Array(size)], { type: options.type ?? '' });
        }
      },
    );
    return { ops, canvases, close };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const fileOf = (head: number[], name: string, type: string) =>
    new File([new Uint8Array([...head, 1, 2, 3])], name, { type });

  it('shrinks a WebP to a 512 px PNG with the same stem, keeping transparency', async () => {
    const { ops, canvases, close } = stubBrowser({ width: 2000, height: 1000 }, [1000]);
    const result = await shrinkImage(fileOf(WEBP_HEAD, 'brand.webp', 'image/webp'));
    expect(result.name).toBe('brand.png');
    expect(result.type).toBe('image/png');
    expect(result.size).toBe(1000);
    expect(canvases).toEqual([{ width: 512, height: 256 }]);
    expect(ops.draws).toEqual([[512, 256]]);
    expect(ops.fills).toBe(0);
    expect(ops.encodes).toEqual([{ type: 'image/png' }]);
    expect(close).toHaveBeenCalledOnce();
  });

  it('keeps a JPEG as JPEG at quality 0.88 on a white background', async () => {
    const { ops } = stubBrowser({ width: 300, height: 200 }, [500]);
    const result = await shrinkImage(fileOf(JPEG_HEAD, 'me.jpeg', 'image/jpeg'));
    expect(result.name).toBe('me.jpg');
    expect(result.type).toBe('image/jpeg');
    expect(ops.draws).toEqual([[300, 200]]);
    expect(ops.fills).toBe(1);
    expect(ops.encodes).toEqual([{ type: 'image/jpeg', quality: 0.88 }]);
  });

  it('retries once at half the side when the first result is too big', async () => {
    const { ops } = stubBrowser({ width: 1024, height: 1024 }, [IMAGE_MAX_BYTES + 1, 2000]);
    const result = await shrinkImage(fileOf(PNG_HEAD, 'big.png', 'image/png'));
    expect(ops.draws).toEqual([
      [512, 512],
      [256, 256],
    ]);
    expect(result.size).toBe(2000);
  });

  it('refuses a picture that is still too big after the retry and closes the bitmap', async () => {
    const { ops, close } = stubBrowser({ width: 1024, height: 1024 }, [IMAGE_MAX_BYTES + 1, IMAGE_MAX_BYTES + 1]);
    await expect(shrinkImage(fileOf(PNG_HEAD, 'big.png', 'image/png'))).rejects.toThrow(
      new ImageRefusal('This picture is too large even after shrinking'),
    );
    expect(ops.encodes).toHaveLength(2);
    expect(close).toHaveBeenCalledOnce();
  });

  it('refuses SVG by its type before decoding', async () => {
    const { ops } = stubBrowser({ width: 10, height: 10 }, []);
    const svg = new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'logo.svg', { type: 'image/svg+xml' });
    await expect(shrinkImage(svg)).rejects.toBeInstanceOf(ImageRefusal);
    expect(ops.encodes).toHaveLength(0);
  });

  it('refuses SVG bytes that claim to be a PNG', async () => {
    stubBrowser({ width: 10, height: 10 }, []);
    const disguised = new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'logo.png', { type: 'image/png' });
    await expect(shrinkImage(disguised)).rejects.toThrow(/PNG, JPEG or WebP/);
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it('refuses real PNG bytes with an unknown or empty type', async () => {
    stubBrowser({ width: 10, height: 10 }, []);
    await expect(shrinkImage(fileOf(PNG_HEAD, 'x.gif', 'image/gif'))).rejects.toBeInstanceOf(ImageRefusal);
    await expect(shrinkImage(fileOf(PNG_HEAD, 'x', ''))).rejects.toBeInstanceOf(ImageRefusal);
  });

  it('uses the bytes when the stated type is a different allowed type', async () => {
    stubBrowser({ width: 50, height: 50 }, [100]);
    const result = await shrinkImage(fileOf(JPEG_HEAD, 'renamed.png', 'image/png'));
    expect(result.type).toBe('image/jpeg');
    expect(result.name).toBe('renamed.jpg');
  });

  it('turns a decode failure into a refusal', async () => {
    stubBrowser({ width: 10, height: 10 }, []);
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => {
        throw new Error('InvalidStateError');
      }),
    );
    await expect(shrinkImage(fileOf(PNG_HEAD, 'broken.png', 'image/png'))).rejects.toThrow(/could not be read/);
  });
});
