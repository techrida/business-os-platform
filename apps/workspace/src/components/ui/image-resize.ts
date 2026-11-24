// Shrinks a picture in the browser before it is uploaded as a logo or profile picture. The server still checks the
// type, the size and scans every upload; this only keeps real uploads small and in a format every renderer embeds
// (pdfkit takes PNG and JPEG, so WebP comes out as PNG). The pure parts are exported for the unit test.
import { IMAGE_MAX_BYTES, IMAGE_MAX_SIDE_PX, IMAGE_MIME, type ImageMime } from '@bos/contracts';

/** A picture the upload screen will not send. `message` is written for the person choosing the file. */
export class ImageRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageRefusal';
  }
}

export type OutputMime = 'image/png' | 'image/jpeg';

/** Qualities tried in order for a JPEG at each size (PNG has no quality: only the size can shrink it). */
export const JPEG_QUALITIES = [0.88, 0.75, 0.6, 0.45] as const;
/** Longest sides tried in order: IMAGE_MAX_SIDE_PX first, then smaller until the file fits. */
export const SIDE_STEPS = [IMAGE_MAX_SIDE_PX, 384, 256, 192, 128, 96, 64, 48, 32] as const;
const SNIFF_BYTES = 12;
const DEFAULT_STEM = 'image';

function bytesAt(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (bytes.length < offset + expected.length) return false;
  return expected.every((value, index) => bytes[offset + index] === value);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const;
const RIFF = [0x52, 0x49, 0x46, 0x46] as const; // "RIFF"
const WEBP = [0x57, 0x45, 0x42, 0x50] as const; // "WEBP"

/** The image type the first bytes of a file prove, or null when they are not PNG, JPEG or WebP. */
export function sniffImageType(bytes: Uint8Array): ImageMime | null {
  if (bytesAt(bytes, 0, PNG_SIGNATURE)) return 'image/png';
  if (bytesAt(bytes, 0, JPEG_SIGNATURE)) return 'image/jpeg';
  if (bytesAt(bytes, 0, RIFF) && bytesAt(bytes, 8, WEBP)) return 'image/webp';
  return null;
}

/** The size to draw at: longest side at most `maxSide`, same aspect, never larger than the source, at least 1 px. */
export function targetSize(
  width: number,
  height: number,
  maxSide: number,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  const scale = longest > 0 ? Math.min(1, maxSide / longest) : 1;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** JPEG stays JPEG; PNG and WebP come out as PNG, which keeps transparency and is embeddable by pdfkit. */
export function outputTypeFor(sourceMime: ImageMime): OutputMime {
  return sourceMime === 'image/jpeg' ? 'image/jpeg' : 'image/png';
}

/** The original name with its last extension replaced by the one for `type`. */
export function outputFileName(name: string, type: OutputMime): string {
  const dot = name.lastIndexOf('.');
  const stem = (dot > 0 ? name.slice(0, dot) : dot === 0 ? '' : name).trim();
  return `${stem || DEFAULT_STEM}${type === 'image/jpeg' ? '.jpg' : '.png'}`;
}

function isAllowedMime(value: string): value is ImageMime {
  return (IMAGE_MIME as readonly string[]).includes(value);
}

const NOT_A_PICTURE =
  'Choose a PNG, JPEG or WebP picture. Other files, including SVG, cannot be used.';

type DrawSurface = {
  context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
  encode: (type: OutputMime, quality: number) => Promise<Blob>;
};

function createSurface(width: number, height: number): DrawSurface {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context)
      throw new ImageRefusal('This browser cannot shrink pictures. Try another browser.');
    return {
      context,
      encode: (type, quality) =>
        canvas.convertToBlob(type === 'image/jpeg' ? { type, quality } : { type }),
    };
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new ImageRefusal('This browser cannot shrink pictures. Try another browser.');
  return {
    context,
    encode: (type, quality) =>
      new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (blob) =>
            blob ? resolve(blob) : reject(new ImageRefusal('This picture could not be shrunk.')),
          type,
          type === 'image/jpeg' ? quality : undefined,
        );
      }),
  };
}

async function render(
  bitmap: ImageBitmap,
  size: { width: number; height: number },
  type: OutputMime,
  quality: number,
): Promise<Blob> {
  const { context, encode } = createSurface(size.width, size.height);
  if (type === 'image/jpeg') {
    // JPEG has no transparency: flatten onto white instead of the encoder's black.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, size.width, size.height);
  }
  context.drawImage(bitmap, 0, 0, size.width, size.height);
  return encode(type, quality);
}

/**
 * Checks a chosen picture and makes it fit: the longest side drops from IMAGE_MAX_SIDE_PX through smaller steps and,
 * for a JPEG, the quality drops at each size, until the file is at most IMAGE_MAX_BYTES. PNG and WebP come out as PNG
 * (lossless, keeps transparency, never JPEG); only their size shrinks. Any picture of any size ends up sent.
 * Throws ImageRefusal (with a message for the person) for anything that is not a PNG, JPEG or WebP by both its stated
 * type and its first bytes, that cannot be decoded, or that does not fit even at the smallest step.
 * When the stated type and the bytes name different allowed types, the bytes win.
 */
export async function shrinkImage(file: File): Promise<File> {
  const declared = file.type.trim().toLowerCase();
  if (!isAllowedMime(declared)) throw new ImageRefusal(NOT_A_PICTURE);
  const head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
  const sniffed = sniffImageType(head);
  if (!sniffed) throw new ImageRefusal(NOT_A_PICTURE);

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new ImageRefusal(
      'This picture could not be read. It may be damaged; try saving it again.',
    );
  }

  try {
    const type = outputTypeFor(sniffed);
    const qualities = type === 'image/jpeg' ? JPEG_QUALITIES : ([1] as const);
    let last = '';
    for (const side of SIDE_STEPS) {
      const size = targetSize(bitmap.width, bitmap.height, side);
      const key = `${size.width}x${size.height}`;
      if (key === last) continue; // a source smaller than this step renders the same as the step before
      last = key;
      for (const quality of qualities) {
        const blob = await render(bitmap, size, type, quality);
        if (blob.size <= IMAGE_MAX_BYTES) {
          return new File([blob], outputFileName(file.name, type), {
            type,
            lastModified: Date.now(),
          });
        }
      }
    }
    throw new ImageRefusal('This picture is too large to use even after shrinking it.');
  } finally {
    bitmap.close();
  }
}
