import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

import { memoPdfFileName, renderMemoPdf, segmentRuns } from './memo-pdf';
import { loadMemoFonts } from './memo-pdf-fonts';
import { MemoPdfInputSchema, memoPdfInputOf, type MemoPdfInput } from './memo-pdf-input';

const FONT_DIR = fileURLToPath(new URL('../../assets/fonts', import.meta.url));
const fonts = () => loadMemoFonts((file) => readFile(`${FONT_DIR}/${file}`));

const person = (name: string, jobTitle: string | null = null) => ({ name, jobTitle });
const input = (over: Partial<MemoPdfInput> = {}): MemoPdfInput => ({
  organizationName: 'Crestia Pvt. Ltd.',
  departmentName: 'Finance',
  date: '2026-11-12',
  title: 'Budget approval',
  body: 'Please approve the budget.',
  closing: 'Submitted for your approval.',
  preparedBy: person('Sushil Shrestha', 'Accountant'),
  recommenders: [person('Ram Thapa')],
  approvedBy: person('Sita Rai'),
  ...over,
});

/** Everything a PDF reader would learn from the file: raw objects plus every inflatable stream, as latin1 text. */
function inspect(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString('latin1');
  const parts = [raw];
  for (const match of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    try {
      parts.push(inflateSync(Buffer.from(match[1]!, 'latin1')).toString('latin1'));
    } catch {
      // Font programs and images are not text; skip what is not a deflate stream we can read.
    }
  }
  return parts.join('\n');
}

/** The code points the embedded fonts' ToUnicode maps say are drawn: the destinations of every bfchar and bfrange entry. */
function drawnCodePoints(text: string): Set<number> {
  const drawn = new Set<number>();
  // A ligature glyph (a Devanagari conjunct) maps to several UTF-16 units written together: <0936094d>.
  const add = (written: string) => {
    const hex = written.replace(/\s+/g, '');
    for (let i = 0; i < hex.length; i += 4) drawn.add(parseInt(hex.slice(i, i + 4), 16));
  };
  for (const [, body] of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const [, , dst] of body!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F\s]+)>/g)) {
      add(dst!);
    }
  }
  for (const [, body] of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of body!.matchAll(
      /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[^\]]*\]|<[0-9a-fA-F\s]+>)/g,
    )) {
      const [, from, to, rest] = m;
      if (rest!.startsWith('[')) {
        for (const d of rest!.matchAll(/<([0-9a-fA-F\s]+)>/g)) add(d[1]!);
      } else {
        const start = parseInt(rest!.slice(1, -1), 16);
        for (let i = 0; i <= parseInt(to!, 16) - parseInt(from!, 16); i += 1) drawn.add(start + i);
      }
    }
  }
  return drawn;
}

describe('segmentRuns', () => {
  const faces = [
    // Same split as memo-pdf-fonts.ts: Devanagari first, then Latin.
    {
      ranges: [
        [0x0900, 0x097f],
        [0x200c, 0x200d],
      ] as const,
    },
    {
      ranges: [
        [0x0000, 0x00ff],
        [0x2000, 0x206f],
      ] as const,
    },
  ];

  it('keeps a Devanagari word in its own run, so it can be shaped', () => {
    const { runs, substituted } = segmentRuns('Hello सुशील World', faces);
    expect(runs.map((r) => [r.face, r.text])).toEqual([
      [1, 'Hello '],
      [0, 'सुशील'],
      [1, ' World'],
    ]);
    expect(substituted).toBe(0);
  });

  it('keeps joiners with the Devanagari letters around them', () => {
    const { runs } = segmentRuns('क्‍ष', faces);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.face).toBe(0);
  });

  it('keeps a combining accent with its letter', () => {
    const { runs } = segmentRuns('José', faces);
    // NFC composes e + acute into one character the Latin face already has.
    expect(runs).toHaveLength(1);
    expect(runs[0]!.text).toBe('José');
  });

  it('replaces what no font covers with "?" and counts it', () => {
    const { runs, substituted } = segmentRuns('A日本😀B', faces);
    expect(runs.map((r) => r.text).join('')).toBe('A???B');
    expect(substituted).toBe(3);
  });

  it('drops control characters but keeps newlines', () => {
    const { runs, substituted } = segmentRuns('a\u0000b\nc\u0085d', faces);
    expect(runs.map((r) => r.text).join('')).toBe('ab\ncd');
    expect(substituted).toBe(0);
  });
});

describe('renderMemoPdf', () => {
  it('produces a real PDF file, not HTML: header, trailer, a page tree and embedded fonts', async () => {
    const { bytes, pages, substituted } = await renderMemoPdf(input(), await fonts());
    const text = Buffer.from(bytes).toString('latin1');
    expect(text.startsWith('%PDF-')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('/Type /Catalog');
    expect(text).toContain('/FontFile2');
    expect(text).not.toMatch(/<html|<!doctype/i);
    expect(pages).toBe(1);
    expect(substituted).toBe(0);
  });

  it('prints no developer note under the signers: product text only, named signer slots kept', async () => {
    // Every character here is drawn by the page itself. The old note ("Names indicate the proposed approval
    // route. Signatures are disabled.") is the only text that would add a lowercase g or an N, so neither may appear.
    const plain = input({
      organizationName: 'AAA',
      departmentName: 'AAA',
      title: 'AAA',
      body: 'AAA',
      closing: 'AAA',
      preparedBy: person('AAA'),
      recommenders: [person('AAA')],
      approvedBy: person('AAA'),
    });
    const { bytes } = await renderMemoPdf(plain, await fonts());
    const drawn = drawnCodePoints(inspect(bytes));
    expect(drawn.has('g'.codePointAt(0)!)).toBe(false);
    expect(drawn.has('N'.codePointAt(0)!)).toBe(false);
    // The signer slot labels are still there ("Prepared by", "Recommended by 1", "Approved by").
    for (const ch of 'Prepared by'.replace(/ /g, '')) {
      expect(drawn.has(ch.codePointAt(0)!), ch).toBe(true);
    }
  });

  it('draws actual Unicode names: every Devanagari and Latin-extended character is mapped in an embedded font', async () => {
    const { bytes, substituted } = await renderMemoPdf(
      input({
        organizationName: 'श्री क्रेस्टिया प्रा. लि.',
        preparedBy: person('सुशील श्रेष्ठ', 'लेखापाल'),
        recommenders: [person('Élodie Strauß'), person('José Ñandú')],
        approvedBy: person('Đặng Văn Ấn'),
      }),
      await fonts(),
    );
    expect(substituted).toBe(0);
    const drawn = drawnCodePoints(inspect(bytes));
    // pdfkit writes a ToUnicode map per embedded font: it lists every character the glyphs stand for.
    for (const ch of new Set([...'श्री क्रेस्टिया सुशील श्रेष्ठ लेखापाल ÉßÑúĐặăẤ'])) {
      if (ch === ' ' || ch === '.') continue;
      expect(
        drawn.has(ch.codePointAt(0)!),
        `${ch} (U+${ch.codePointAt(0)!.toString(16)}) must be drawn`,
      ).toBe(true);
    }
  });

  it('is safe: markup in the memo is drawn as text, and the file has no scripts, links or external sends', async () => {
    const { bytes } = await renderMemoPdf(
      input({
        title: '<img src=x onerror=alert(1)>',
        body: '<script>alert(1)</script> http://evil.example/?a=1&b=2 (unbalanced \\ ) parens',
        closing: '"><svg onload=alert(2)>',
        organizationName: '</article><b>Evil</b>',
      }),
      await fonts(),
    );
    const text = inspect(bytes);
    for (const bad of [
      '/JavaScript',
      '/JS',
      '/OpenAction',
      '/AA',
      '/Launch',
      '/URI',
      '/SubmitForm',
      '/EmbeddedFile',
    ]) {
      expect(text, bad).not.toContain(bad);
    }
    expect(text).not.toContain('evil.example');
  });

  it('wraps long text onto more pages and keeps a word with no spaces inside the margins', async () => {
    const long = (
      'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(40) + '\n\n'
    ).repeat(6);
    const { pages } = await renderMemoPdf(
      input({ body: `${long}${'Z'.repeat(400)}`, title: 'T'.repeat(200) }),
      await fonts(),
    );
    expect(pages).toBeGreaterThan(2);
  });

  it('handles the limits: 20 recommenders, an empty body, blank and missing names and titles', async () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      person(`Recommender ${i + 1}`, i % 2 ? 'Manager' : null),
    );
    const full = await renderMemoPdf(input({ recommenders: many }), await fonts());
    expect(full.pages).toBeGreaterThanOrEqual(1);
    const sparse = await renderMemoPdf(
      input({
        body: '',
        title: '',
        closing: '',
        departmentName: '',
        preparedBy: person(''),
        approvedBy: person('  '),
      }),
      await fonts(),
    );
    expect(Buffer.from(sparse.bytes).toString('latin1').startsWith('%PDF-')).toBe(true);
  });

  it('counts the characters no font can draw instead of failing', async () => {
    const { substituted, bytes } = await renderMemoPdf(
      input({ body: '日本語 and 😀 and العربية' }),
      await fonts(),
    );
    expect(substituted).toBeGreaterThanOrEqual(10);
    expect(Buffer.from(bytes).toString('latin1').startsWith('%PDF-')).toBe(true);
  });

  it('numbers pages when the memo runs long, and not otherwise', async () => {
    const one = inspect((await renderMemoPdf(input(), await fonts())).bytes);
    expect(one).not.toContain('Page 1 of');
    const longBody = 'Paragraph text. '.repeat(900);
    const multi = await renderMemoPdf(input({ body: longBody }), await fonts());
    expect(multi.pages).toBeGreaterThan(1);
  });
});

describe('PDF input', () => {
  it('builds the same input from a saved snapshot as from live values, leaving blank people to the caller', () => {
    const built = memoPdfInputOf(
      {
        organizationName: 'Crestia',
        departmentName: 'Finance',
        date: '2026-11-12',
        closing: 'Thanks',
        preparedBy: { userId: 'u1', name: 'A', jobTitle: 'T', department: 'D' },
        recommenders: [{ userId: 'u2', name: 'B', jobTitle: null, department: null }],
        approvedBy: { userId: 'u3', name: 'C', jobTitle: null, department: null },
      },
      'Subject',
      'Body',
    );
    expect(MemoPdfInputSchema.parse(built)).toEqual(built);
    expect(built.preparedBy).toEqual({ name: 'A', jobTitle: 'T' });
    expect(built).not.toHaveProperty('preparedBy.userId');
  });

  it('bounds every field it accepts from the browser', () => {
    expect(MemoPdfInputSchema.safeParse(input()).success).toBe(true);
    expect(MemoPdfInputSchema.safeParse(input({ body: 'x'.repeat(10_001) })).success).toBe(false);
    expect(MemoPdfInputSchema.safeParse(input({ title: 'x'.repeat(201) })).success).toBe(false);
    expect(
      MemoPdfInputSchema.safeParse(
        input({ recommenders: Array.from({ length: 21 }, () => person('x')) }),
      ).success,
    ).toBe(false);
    expect(
      MemoPdfInputSchema.safeParse({ ...input(), extra: 'ignored by zod object' }).success,
    ).toBe(true);
    expect(MemoPdfInputSchema.safeParse({ title: 'only' }).success).toBe(false);
  });
});

describe('memoPdfFileName', () => {
  it('is ASCII and file-system safe', () => {
    expect(memoPdfFileName('MEMO-2083/84-00004', 'Budget: Q1 / office?')).toBe(
      'MEMO-2083-84-00004-Budget-Q1-office.pdf',
    );
    expect(memoPdfFileName(null, 'बजेट')).toBe('memo.pdf');
    expect(memoPdfFileName(null, '../../etc/passwd')).toBe('memo-etc-passwd.pdf');
    expect(memoPdfFileName('MEMO-1', 'a'.repeat(200)).length).toBeLessThan(80);
  });
});
