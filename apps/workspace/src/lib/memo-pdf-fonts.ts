import 'server-only';

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { MemoPdfFontFace, MemoPdfFonts } from './memo-pdf';

// The unicode-range of each shipped subset (from @fontsource's unicode.json, as inclusive pairs). Order matters:
// the first face that covers a character is used, so the compact Latin face wins over the wider ones.
const LATIN = [
  [0x0000, 0x00ff],
  [0x0131, 0x0131],
  [0x0152, 0x0153],
  [0x02bb, 0x02bc],
  [0x02c6, 0x02c6],
  [0x02da, 0x02da],
  [0x02dc, 0x02dc],
  [0x0304, 0x0304],
  [0x0308, 0x0308],
  [0x0329, 0x0329],
  [0x2000, 0x206f],
  [0x20ac, 0x20ac],
  [0x2122, 0x2122],
  [0x2191, 0x2191],
  [0x2193, 0x2193],
  [0x2212, 0x2212],
  [0x2215, 0x2215],
  [0xfffd, 0xfffd],
] as const;
const LATIN_EXT = [
  [0x0100, 0x02ba],
  [0x02bd, 0x02c5],
  [0x02c7, 0x02cc],
  [0x02ce, 0x02d7],
  [0x02dd, 0x02ff],
  [0x1d00, 0x1dbf],
  [0x1e00, 0x1e9f],
  [0x1ef2, 0x1eff],
  [0x2020, 0x2020],
  [0x20a0, 0x20ab],
  [0x20ad, 0x20c0],
  [0x2113, 0x2113],
  [0x2c60, 0x2c7f],
  [0xa720, 0xa7ff],
] as const;
const GREEK = [
  [0x0370, 0x0377],
  [0x037a, 0x037f],
  [0x0384, 0x038a],
  [0x038c, 0x038c],
  [0x038e, 0x03a1],
  [0x03a3, 0x03ff],
] as const;
const CYRILLIC = [
  [0x0301, 0x0301],
  [0x0400, 0x045f],
  [0x0490, 0x0491],
  [0x04b0, 0x04b1],
  [0x2116, 0x2116],
] as const;
const VIETNAMESE = [
  [0x0102, 0x0103],
  [0x0110, 0x0111],
  [0x0128, 0x0129],
  [0x0168, 0x0169],
  [0x01a0, 0x01a1],
  [0x01af, 0x01b0],
  [0x0300, 0x0301],
  [0x0303, 0x0304],
  [0x0308, 0x0309],
  [0x0323, 0x0323],
  [0x0329, 0x0329],
  [0x1ea0, 0x1ef9],
  [0x20ab, 0x20ab],
] as const;
// Devanagari (Nepali, Hindi, Marathi ...). The joiners belong to the script so conjuncts shape.
const DEVANAGARI = [
  [0x0900, 0x097f],
  [0x1cd0, 0x1cf9],
  [0x200c, 0x200d],
  [0x20a8, 0x20a8],
  [0x20b9, 0x20b9],
  [0x20f0, 0x20f0],
  [0x25cc, 0x25cc],
  [0xa830, 0xa839],
  [0xa8e0, 0xa8ff],
] as const;

const FACES = [
  {
    id: 'devanagari',
    file: (w: number) => `NotoSansDevanagari-devanagari-${w}.woff`,
    ranges: DEVANAGARI,
  },
  { id: 'latin', file: (w: number) => `NotoSans-latin-${w}.woff`, ranges: LATIN },
  { id: 'latin-ext', file: (w: number) => `NotoSans-latin-ext-${w}.woff`, ranges: LATIN_EXT },
  { id: 'vietnamese', file: (w: number) => `NotoSans-vietnamese-${w}.woff`, ranges: VIETNAMESE },
  { id: 'greek', file: (w: number) => `NotoSans-greek-${w}.woff`, ranges: GREEK },
  { id: 'cyrillic', file: (w: number) => `NotoSans-cyrillic-${w}.woff`, ranges: CYRILLIC },
] as const;

let cached: Promise<MemoPdfFonts> | undefined;

/**
 * Reads one font file. The path is spelled out here, statically, so the production build traces exactly
 * `assets/fonts` into the standalone image and nothing else (a computed directory would pull in the whole project).
 */
const readBundledFont = (file: string): Promise<Buffer> =>
  readFile(path.join(process.cwd(), 'assets', 'fonts', file));

/**
 * The embedded fonts, read once per server process. The working directory is apps/workspace in dev, in tests and
 * in the standalone build (next.config.ts lists the folder for tracing so the production image carries it).
 * `read` exists so a test can load the same files from an explicit place.
 */
export function loadMemoFonts(
  read: (file: string) => Promise<Uint8Array> = readBundledFont,
): Promise<MemoPdfFonts> {
  cached ??= (async () => {
    const load = async (weight: number, prefix: string): Promise<MemoPdfFontFace[]> =>
      Promise.all(
        FACES.map(async (f) => ({
          name: `${prefix}-${f.id}`,
          data: await read(f.file(weight)),
          ranges: f.ranges,
        })),
      );
    return { regular: await load(400, 'regular'), bold: await load(700, 'bold') };
  })().catch((err: unknown) => {
    cached = undefined;
    throw err;
  });
  return cached;
}
