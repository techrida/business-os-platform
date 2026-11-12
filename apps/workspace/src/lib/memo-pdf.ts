// Renders the memo paper as real PDF bytes (pdfkit), so "Download" hands over a document and not HTML
// renamed to .pdf. Pure: fonts come in as bytes (memo-pdf-fonts.ts loads them), nothing is fetched or sent
// anywhere, and every value is drawn as text, so it cannot inject markup or scripts into the file.
// Serves the NFR "what was approved is what was seen": the same fields the on-screen paper shows, in the same
// order, from either the persisted snapshot or the live form values.
import PDFDocument from 'pdfkit';

import { NOT_SELECTED, PAPER_NOTE, type MemoPdfInput } from './memo-pdf-input';

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

  // Letterhead.
  block(input.organizationName, { bold: true, size: 14 }, { align: 'center' });
  if (input.departmentName) block(input.departmentName, { size: 11 }, { align: 'center' });
  block('(MEMO)', { size: 11 }, { align: 'center', after: 14 });

  block(`Date: ${input.date}`, { size: 10.5 }, { align: 'right', after: 14 });
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

  y += 10;
  block(PAPER_NOTE, { size: 9, color: MUTED });

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

/** The file name offered by the browser: ASCII only, so every browser and file system keeps it intact. */
export function memoPdfFileName(number: string | null, title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const base = [
    number?.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'memo',
    slug || null,
  ]
    .filter(Boolean)
    .join('-');
  return `${base}.pdf`;
}
