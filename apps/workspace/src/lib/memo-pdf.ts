// Renders the memo paper as real PDF bytes (pdfkit), so "Download" hands over a document and not HTML
// renamed to .pdf. Pure: fonts come in as bytes (memo-pdf-fonts.ts loads them), nothing is fetched or sent
// anywhere, and every value is drawn as text, so it cannot inject markup or scripts into the file.
// Serves the NFR "what was approved is what was seen": the same fields the on-screen paper shows, in the same
// order, from either the persisted snapshot or the live form values.
import { inflateSync } from 'node:zlib';

import { DEFAULT_BRAND_COLOUR, deriveBrandPalette, type BrandPalette } from '@bos/contracts';
import PDFDocument from 'pdfkit';

import { NOT_SELECTED, type MemoPdfInput } from './memo-pdf-input';

export interface MemoPdfFontFace {
  /** Registered with pdfkit under this name. */
  name: string;
  data: Uint8Array;
  /** The code point ranges this face is chosen for, inclusive pairs. */
  ranges: ReadonlyArray<readonly [number, number]>;
}
export interface MemoPdfFonts {
  regular: MemoPdfFontFace[];
  bold: MemoPdfFontFace[];
}

export interface MemoPdfResult {
  bytes: Buffer;
  /** Characters no embedded font covers (CJK, Arabic, emoji ...): printed as "?" and counted. */
  substituted: number;
  pages: number;
}

interface Run {
  face: number;
  text: string;
}

const inRanges = (cp: number, ranges: ReadonlyArray<readonly [number, number]>): boolean =>
  ranges.some(([lo, hi]) => cp >= lo && cp <= hi);

const COMBINING = (cp: number): boolean => cp >= 0x0300 && cp <= 0x036f;
const JOINER = (cp: number): boolean => cp === 0x200c || cp === 0x200d;

/**
 * Splits text into runs that each use one font face. A Devanagari word keeps its own face (with its joiners)
 * so fontkit can shape conjuncts and vowel signs; combining accents stay with the letter before them; a
 * character none of the faces covers becomes "?" and is counted.
 */
export function segmentRuns(
  input: string,
  faces: ReadonlyArray<Pick<MemoPdfFontFace, 'ranges'>>,
): { runs: Run[]; substituted: number } {
  const runs: Run[] = [];
  let substituted = 0;
  let prevFace = -1;
  const push = (face: number, ch: string) => {
    const last = runs[runs.length - 1];
    if (last && last.face === face) last.text += ch;
    else runs.push({ face, text: ch });
    prevFace = face;
  };
  const fallbackFace = faces.findIndex((f) => inRanges(0x3f, f.ranges));
  for (const ch of input.normalize('NFC')) {
    const cp = ch.codePointAt(0)!;
    if (ch === '\n' || ch === '\t') {
      push(prevFace >= 0 ? prevFace : Math.max(fallbackFace, 0), ch);
      continue;
    }
    // Other control characters and the byte order mark carry no glyph.
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0) || cp === 0xfeff) continue;
    let face = -1;
    if (prevFace >= 0 && (COMBINING(cp) || JOINER(cp))) face = prevFace;
    if (face < 0) face = faces.findIndex((f) => inRanges(cp, f.ranges));
    if (face < 0) {
      substituted += 1;
      push(Math.max(fallbackFace, 0), '?');
      continue;
    }
    push(face, ch);
  }
  return { runs, substituted };
}

const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = 64;
const CONTENT_WIDTH = PAGE.width - MARGIN * 2;
const INK = '#16181d';
const MUTED = '#5b616e';
const SIGNER_COLUMNS = 3;
const SIGNER_GAP = 20;
/** Line height as a multiple of the font size: tall enough for Devanagari vowel signs above the line. */
const LINE_HEIGHT = 1.5;
/** The tinted letterhead band across the top of page 1: at least this tall, taller when the right block needs it. */
const BAND_MIN_HEIGHT = 110;
const BAND_PADDING = 22;
/** Space between the band and the date line: the old centred letterhead ended at about the same y. */
const BAND_GAP = 24;
const LOGO_MAX_HEIGHT = 44;
const LOGO_MAX_WIDTH = 120;
const LOGO_GAP = 14;
/** Room kept between the large "Memo" title and the company block. */
const TITLE_GAP = 28;
/** A logo larger than this on either side is not decoded: the screen re-encodes uploads to at most 512 px. */
const LOGO_MAX_SIDE = 2048;

export interface MemoLogo {
  data: Buffer;
  width: number;
  height: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const PNG_DEPTHS: Record<number, number[]> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};
/** Adam7 passes: [x start, y start, x step, y step]. */
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const;

/**
 * Checks a PNG the way pdfkit will read it, before pdfkit sees it: pdfkit decodes the pixels of a PNG with
 * transparency in a zlib callback, where a bad file can neither be caught nor make the render finish.
 * So the chunks, the header, the compressed data and every row's filter byte are checked here first.
 */
function pngLogo(data: Buffer): MemoLogo | null {
  if (data.length < 33 || !data.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colour = -1;
  let interlace = 0;
  let palette = false;
  let ended = false;
  const idat: Buffer[] = [];
  for (let at = 8; at + 12 <= data.length;) {
    const length = data.readUInt32BE(at);
    const type = data.toString('latin1', at + 4, at + 8);
    if (at + 12 + length > data.length) return null;
    const chunk = data.subarray(at + 8, at + 8 + length);
    if (at === 8 && type !== 'IHDR') return null;
    if (type === 'IHDR') {
      if (length !== 13) return null;
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      depth = chunk[8]!;
      colour = chunk[9]!;
      interlace = chunk[12]!;
    } else if (type === 'PLTE') palette = true;
    else if (type === 'IDAT') idat.push(chunk);
    else if (type === 'IEND') {
      ended = true;
      break;
    }
    at += 12 + length;
  }
  const channels = PNG_CHANNELS[colour];
  if (!ended || channels === undefined || !PNG_DEPTHS[colour]!.includes(depth)) return null;
  if (width < 1 || height < 1 || width > LOGO_MAX_SIDE || height > LOGO_MAX_SIDE) return null;
  if (interlace > 1 || (colour === 3 && !palette) || idat.length === 0) return null;
  const bits = depth * channels;
  const passes = interlace === 1 ? ADAM7 : ([[0, 0, 1, 1]] as const);
  const rows: number[] = [];
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((width - x0) / dx);
    const ph = Math.ceil((height - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    for (let r = 0; r < ph; r += 1) rows.push(1 + Math.ceil((pw * bits) / 8));
  }
  const expected = rows.reduce((a, b) => a + b, 0);
  let pixels: Buffer;
  try {
    pixels = inflateSync(Buffer.concat(idat), { maxOutputLength: expected + 1024 });
  } catch {
    return null;
  }
  if (pixels.length < expected) return null;
  let row = 0;
  for (const size of rows) {
    if (pixels[row]! > 4) return null;
    row += size;
  }
  return { data, width, height };
}

/** Reads a JPEG's size from its frame header; pdfkit embeds the bytes as they are, so this is all it needs. */
function jpegLogo(data: Buffer): MemoLogo | null {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  for (let at = 2; at + 4 <= data.length;) {
    if (data[at] !== 0xff) return null;
    const marker = data[at + 1]!;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    const length = data.readUInt16BE(at + 2);
    if (length < 2) return null;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame) {
      if (at + 9 > data.length) return null;
      const height = data.readUInt16BE(at + 5);
      const width = data.readUInt16BE(at + 7);
      if (width < 1 || height < 1 || width > LOGO_MAX_SIDE || height > LOGO_MAX_SIDE) return null;
      return { data, width, height };
    }
    at += 2 + length;
  }
  return null;
}

/**
 * The logo a letterhead data URL holds, if pdfkit can embed it: a well-formed PNG or JPEG, told apart by its bytes
 * and not by the type the URL claims. WebP (pdfkit cannot embed it) and anything malformed is null.
 */
export function decodeMemoLogo(dataUrl: string): MemoLogo | null {
  const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) return null;
  const data = Buffer.from(match[1]!, 'base64');
  return pngLogo(data) ?? jpegLogo(data);
}

interface Style {
  bold?: boolean;
  size: number;
  color?: string;
}
interface Piece {
  face: number;
  text: string;
  width: number;
}
interface Line {
  pieces: Piece[];
  width: number;
}

const graphemes = (value: string): string[] =>
  Array.from(
    new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value),
    (s) => s.segment,
  );

/** Renders the memo paper to PDF bytes. Never throws for content: odd text is wrapped, shaped or substituted. */
export async function renderMemoPdf(
  input: MemoPdfInput,
  fonts: MemoPdfFonts,
  now: Date = new Date(),
): Promise<MemoPdfResult> {
  const doc = new PDFDocument({
    size: [PAGE.width, PAGE.height],
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    bufferPages: true,
    compress: true,
    info: {
      Title: (input.title.trim() || 'Untitled memo').slice(0, 200),
      Author: input.preparedBy.name.slice(0, 200),
      Subject: 'Internal memo',
      Creator: 'Business OS',
      Producer: 'Business OS',
      CreationDate: now,
    },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  for (const face of [...fonts.regular, ...fonts.bold]) {
    doc.registerFont(face.name, face.data);
  }

  let substituted = 0;
  let y = MARGIN;
  const bottom = PAGE.height - MARGIN;
  const faceSet = (style: Style) => (style.bold ? fonts.bold : fonts.regular);

  // Layout is done here, not by pdfkit's wrapper: that one restarts the line at every font switch, which
  // breaks a Devanagari name that sits between Latin words. Widths come from pdfkit (shaped by fontkit).
  const widthOf = (style: Style, face: number, value: string): number =>
    doc.font(faceSet(style)[face]!.name).fontSize(style.size).widthOfString(value);

  function piecesOf(token: string, style: Style, count: boolean): Piece[] {
    const { runs, substituted: n } = segmentRuns(token, faceSet(style));
    if (count) substituted += n;
    return runs.map((r) => ({ face: r.face, text: r.text, width: widthOf(style, r.face, r.text) }));
  }
  const total = (pieces: Piece[]) => pieces.reduce((sum, p) => sum + p.width, 0);

  /** Greedy wrap into lines no wider than `width`; a word wider than a line is split between letters. */
  function layout(value: string, style: Style, width: number): Line[] {
    const lines: Line[] = [];
    for (const hard of value.replace(/\t/g, '  ').split('\n')) {
      let cur: Line = { pieces: [], width: 0 };
      const flush = () => {
        lines.push(cur);
        cur = { pieces: [], width: 0 };
      };
      let gap: Piece[] = [];
      let first = true;
      for (const token of hard.split(/(\s+)/)) {
        if (token === '') continue;
        if (/^\s+$/.test(token)) {
          gap = piecesOf(token, style, false);
          if (first) {
            // Indentation at the start of a paragraph line is kept, like white-space: pre-wrap.
            cur.pieces.push(...gap);
            cur.width += total(gap);
            gap = [];
          }
          first = false;
          continue;
        }
        first = false;
        const word = piecesOf(token, style, true);
        const wordWidth = total(word);
        const gapWidth = cur.pieces.length > 0 ? total(gap) : 0;
        if (cur.width + gapWidth + wordWidth <= width) {
          if (gapWidth > 0) cur.pieces.push(...gap);
          cur.pieces.push(...word);
          cur.width += gapWidth + wordWidth;
        } else if (wordWidth <= width) {
          if (cur.pieces.length > 0) flush();
          cur.pieces.push(...word);
          cur.width = wordWidth;
        } else {
          if (cur.pieces.length > 0) flush();
          for (const g of graphemes(token.normalize('NFC'))) {
            const piece = piecesOf(g, style, false);
            const w = total(piece);
            if (cur.width + w > width && cur.pieces.length > 0) flush();
            cur.pieces.push(...piece);
            cur.width += w;
          }
        }
        gap = [];
      }
      lines.push(cur);
    }
    return lines;
  }

  const lineHeightOf = (style: Style) => style.size * LINE_HEIGHT;
  const newPage = () => {
    doc.addPage();
    y = MARGIN;
  };

  function drawLine(
    line: Line,
    style: Style,
    x: number,
    width: number,
    align: 'left' | 'center' | 'right',
  ) {
    let cursor =
      align === 'right'
        ? x + width - line.width
        : align === 'center'
          ? x + (width - line.width) / 2
          : x;
    doc.fillColor(style.color ?? INK).fontSize(style.size);
    for (const piece of line.pieces) {
      if (piece.text.trim() !== '') {
        doc
          .font(faceSet(style)[piece.face]!.name)
          .text(piece.text, cursor, y + (lineHeightOf(style) - style.size) / 2, {
            lineBreak: false,
          });
      }
      cursor += piece.width;
    }
  }

  /** Draws wrapped text at the current y, starting a new page when a line would cross the bottom margin. */
  function block(
    value: string,
    style: Style,
    opts: { x?: number; width?: number; align?: 'left' | 'center' | 'right'; after?: number } = {},
  ): void {
    const x = opts.x ?? MARGIN;
    const width = opts.width ?? CONTENT_WIDTH;
    for (const line of layout(value, style, width)) {
      if (y + lineHeightOf(style) > bottom) newPage();
      drawLine(line, style, x, width, opts.align ?? 'left');
      y += lineHeightOf(style);
    }
    y += opts.after ?? 0;
  }

  const heightOf = (value: string, style: Style, width: number): number =>
    layout(value, style, width).length * lineHeightOf(style);

  // Letterhead: a tinted band across the top of page 1 only. "Memo" large on the left; on the right the company
  // name, department and address, and the logo against the right margin. Without a letterhead (a memo stored before
  // letterheads) the band still shows "Memo", the company and the department, in the default colour.
  const letterhead = input.letterhead;
  let palette: BrandPalette;
  try {
    palette = deriveBrandPalette(letterhead?.primaryColour ?? DEFAULT_BRAND_COLOUR);
  } catch {
    palette = deriveBrandPalette(DEFAULT_BRAND_COLOUR);
  }
  let logo: MemoLogo | null = null;
  if (letterhead?.logoDataUrl) {
    logo = decodeMemoLogo(letterhead.logoDataUrl);
    // The screen re-encodes uploads to PNG or JPEG, so only a direct API upload gets here: leave the logo out.
    if (!logo)
      console.warn(
        'Memo PDF: the letterhead logo is not a readable PNG or JPEG; printed without it.',
      );
  }
  const logoScale = logo ? Math.min(LOGO_MAX_HEIGHT / logo.height, LOGO_MAX_WIDTH / logo.width) : 0;
  const logoWidth = logo ? logo.width * logoScale : 0;
  const logoHeight = logo ? logo.height * logoScale : 0;

  const memoTitleStyle: Style = { size: 40, color: palette.accentText };
  const titleWidth = layout('Memo', memoTitleStyle, CONTENT_WIDTH)[0]?.width ?? 0;
  const textRight = PAGE.width - MARGIN - (logo ? logoWidth + LOGO_GAP : 0);
  const textWidth = Math.max(textRight - (MARGIN + titleWidth + TITLE_GAP), 60);
  const textLeft = textRight - textWidth;
  const companyStyle: Style = { bold: true, size: 12 };
  const departmentStyle: Style = { size: 10 };
  const addressStyle: Style = { size: 9, color: MUTED };
  const addressLines = (letterhead?.addressLines ?? []).filter((l) => l.trim() !== '');
  const textHeight =
    heightOf(input.organizationName, companyStyle, textWidth) +
    (input.departmentName ? heightOf(input.departmentName, departmentStyle, textWidth) : 0) +
    addressLines.reduce((sum, l) => sum + heightOf(l, addressStyle, textWidth), 0);
  const bandHeight = Math.max(BAND_MIN_HEIGHT, Math.max(textHeight, logoHeight) + BAND_PADDING * 2);

  doc.rect(0, 0, PAGE.width, bandHeight).fill(palette.tint);
  y = (bandHeight - lineHeightOf(memoTitleStyle)) / 2;
  block('Memo', memoTitleStyle);
  y = (bandHeight - textHeight) / 2;
  const right = { x: textLeft, width: textWidth, align: 'right' as const };
  block(input.organizationName, companyStyle, right);
  if (input.departmentName) block(input.departmentName, departmentStyle, right);
  for (const line of addressLines) block(line, addressStyle, right);
  if (logo) {
    try {
      doc.image(logo.data, PAGE.width - MARGIN - logoWidth, (bandHeight - logoHeight) / 2, {
        width: logoWidth,
        height: logoHeight,
      });
    } catch {
      console.warn('Memo PDF: the letterhead logo could not be embedded; printed without it.');
    }
  }
  y = bandHeight + BAND_GAP;

  block(`Date: ${input.date || 'Not set'}`, { size: 10.5 }, { align: 'right', after: 14 });
  block(
    `Subject: ${input.title.trim() || 'Untitled memo'}`,
    { bold: true, size: 11.5 },
    { after: 10 },
  );

  const paragraphs = input.body.replace(/\r\n?/g, '\n').split(/\n\s*\n/);
  for (const paragraph of paragraphs) {
    if (paragraph.trim() === '' && paragraphs.length === 1) break;
    block(paragraph, { size: 10.5 }, { after: 7 });
  }
  if (input.closing.trim() !== '') {
    y += 5;
    block(input.closing, { size: 10.5 });
  }

  // Signers: three to a row, label small and muted like the paper, name bold, title below.
  y += 26;
  const people = [
    { label: 'Prepared by', person: input.preparedBy },
    ...input.recommenders.map((person, i) => ({ label: `Recommended by ${i + 1}`, person })),
    { label: 'Approved by', person: input.approvedBy },
  ];
  const cellWidth = (CONTENT_WIDTH - SIGNER_GAP * (SIGNER_COLUMNS - 1)) / SIGNER_COLUMNS;
  const labelStyle: Style = { size: 9, color: MUTED };
  const nameStyle: Style = { bold: true, size: 10.5 };
  const titleStyle: Style = { size: 9.5, color: MUTED };
  for (let start = 0; start < people.length; start += SIGNER_COLUMNS) {
    const cells = people.slice(start, start + SIGNER_COLUMNS).map(({ label, person }) => ({
      label,
      name: person.name.trim() || NOT_SELECTED,
      title: person.jobTitle?.trim() ?? '',
    }));
    const height = Math.max(
      ...cells.map(
        (c) =>
          heightOf(c.label, labelStyle, cellWidth) +
          6 +
          heightOf(c.name, nameStyle, cellWidth) +
          (c.title ? heightOf(c.title, titleStyle, cellWidth) : 0),
      ),
    );
    if (y + height > bottom) newPage();
    const top = y;
    cells.forEach((c, i) => {
      y = top;
      const x = MARGIN + i * (cellWidth + SIGNER_GAP);
      block(c.label, labelStyle, { x, width: cellWidth, after: 6 });
      block(c.name, nameStyle, { x, width: cellWidth });
      if (c.title) block(c.title, titleStyle, { x, width: cellWidth });
    });
    y = top + height + 16;
  }

  const footerFace = fonts.regular.find((f) => f.name === 'regular-latin') ?? fonts.regular[0]!;
  const range = doc.bufferedPageRange();
  const pages = range.count;
  if (pages > 1) {
    for (let i = 0; i < pages; i += 1) {
      doc.switchToPage(range.start + i);
      doc.fillColor(MUTED).fontSize(8.5).font(footerFace.name);
      // No width option: pdfkit's wrapper would add a page for text that starts in the bottom margin.
      const label = `Page ${i + 1} of ${pages}`;
      doc.text(label, PAGE.width - MARGIN - doc.widthOfString(label), PAGE.height - MARGIN + 22, {
        lineBreak: false,
      });
    }
  }
  doc.end();
  const bytes = await done;
  return { bytes, substituted, pages };
}

function trimDashes(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s[start] === '-') start += 1;
  while (end > start && s[end - 1] === '-') end -= 1;
  return s.slice(start, end);
}

/** The file name offered by the browser: ASCII only, so every browser and file system keeps it intact. */
export function memoPdfFileName(number: string | null, title: string): string {
  const slug = trimDashes(
    title
      .normalize('NFKD')
      .replace(/[^\x20-\x7e]/g, '')
      .replace(/[^A-Za-z0-9]+/g, '-'),
  ).slice(0, 60);
  const base = [trimDashes(number?.replace(/[^A-Za-z0-9]+/g, '-') ?? '') || 'memo', slug || null]
    .filter(Boolean)
    .join('-');
  return `${base}.pdf`;
}
