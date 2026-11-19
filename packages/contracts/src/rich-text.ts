// Rich text for terms and similar wording (D31): paragraphs, bulleted and numbered lists, bold and italic, nothing else.
//
// One module for the API (validates on write), the workspace and portal (draw it) and the PDF renderers, so a term
// reads the same everywhere. The stored form is a small HTML subset: <p>, <ul>, <ol>, <li>, <strong>, <em>, <br>,
// never with an attribute. The sanitiser does not clean markup, it rebuilds it: the input is cut into tags and text,
// only the allow-listed tags are written out again (without attributes), and every piece of text is escaped. A script,
// style, link, image, handler or comment therefore cannot survive, whatever the input looks like.
//
// Wording saved before D31 is plain text. It stays plain in its column, so a sent document and its content hash do
// not change; `richTextToHtml` draws it as escaped paragraphs. A value counts as rich text only when it starts with
// <p>, <ul> or <ol>.
import { z } from 'zod';

const BLOCK_TAGS = new Set(['p', 'ul', 'ol', 'li']);
const INLINE_TAGS = new Set(['strong', 'em', 'br']);
const INLINE_ALIASES: Record<string, string> = { b: 'strong', i: 'em' };
/** Elements dropped together with everything inside them. */
const DROP_WITH_CONTENT = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'noscript',
  'template',
  'textarea',
  'title',
  'svg',
  'math',
  'head',
]);
/** Elements that are not allowed themselves but end a line, so their text becomes a paragraph. */
const BLOCK_ALIASES = new Set([
  'div',
  'section',
  'article',
  'blockquote',
  'pre',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'tr',
  'table',
]);

const MAX_INPUT = 200_000;
const MAX_LIST_DEPTH = 4;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code =
        body[1]?.toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      if (
        !Number.isInteger(code) ||
        code < 32 ||
        code > 0x10ffff ||
        (code >= 0xd800 && code < 0xe000)
      ) {
        return code === 9 || code === 10 ? String.fromCodePoint(code) : '';
      }
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

const escapeText = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

type Token =
  { kind: 'text'; value: string } | { kind: 'open' | 'close'; name: string; selfClosing: boolean };

const TAG_AT = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^<>]*|\/)?>/;

/** Cuts the input into text and tags. A `<` that does not start a tag is plain text. */
function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let text = '';
  const flush = (): void => {
    if (text !== '') tokens.push({ kind: 'text', value: text });
    text = '';
  };
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch !== '<') {
      text += ch;
      i += 1;
      continue;
    }
    if (input.startsWith('<!--', i)) {
      const end = input.indexOf('-->', i + 4);
      i = end === -1 ? input.length : end + 3;
      continue;
    }
    if (input.startsWith('<!', i) || input.startsWith('<?', i)) {
      const end = input.indexOf('>', i + 2);
      i = end === -1 ? input.length : end + 1;
      continue;
    }
    const match = TAG_AT.exec(input.slice(i, i + 4096));
    if (!match) {
      text += ch;
      i += 1;
      continue;
    }
    flush();
    const whole = match[0];
    tokens.push({
      kind: match[1] === '/' ? 'close' : 'open',
      name: (match[2] as string).toLowerCase(),
      selfClosing: whole.endsWith('/>'),
    });
    i += whole.length;
  }
  flush();
  return tokens;
}

/**
 * Rebuilds the input as the allowed subset. Idempotent: sanitising the result returns it unchanged.
 * Empty paragraphs and empty list items are dropped; stray text is wrapped in a paragraph.
 */
export function sanitizeRichText(input: string): string {
  const tokens = tokenize(input.length > MAX_INPUT ? input.slice(0, MAX_INPUT) : input);
  const out: string[] = [];
  /** Open allow-listed elements, innermost last. */
  const stack: string[] = [];
  /** Where the current paragraph or item started in `out`, to drop it when it stayed empty. */
  const starts: number[] = [];
  const hasContent: boolean[] = [];
  let listDepth = 0;
  let skippedLists = 0;
  let dropUntil: string | null = null;
  let dropDepth = 0;

  const top = (): string | undefined => stack[stack.length - 1];
  const markContent = (): void => {
    hasContent.fill(true);
  };
  const openEl = (name: string): void => {
    out.push(`<${name}>`);
    stack.push(name);
    starts.push(out.length - 1);
    hasContent.push(false);
    if (name === 'ul' || name === 'ol') listDepth += 1;
  };
  const closeTop = (): void => {
    const name = stack.pop() as string;
    const start = starts.pop() as number;
    const had = hasContent.pop() as boolean;
    if (name === 'ul' || name === 'ol') listDepth -= 1;
    if (!had && name !== 'br') {
      out.length = start;
      return;
    }
    out.push(`</${name}>`);
  };
  const closeTo = (name: string): void => {
    while (stack.length > 0 && top() !== name) closeTop();
    if (top() === name) closeTop();
  };
  const closeParagraph = (): void => {
    if (stack.includes('p')) closeTo('p');
  };
  const ensureTextContainer = (): void => {
    const t = top();
    if (t === undefined) openEl('p');
    else if (t === 'ul' || t === 'ol') {
      openEl('li');
    }
  };

  for (const token of tokens) {
    if (dropUntil !== null) {
      if (token.kind === 'open' && token.name === dropUntil && !token.selfClosing) dropDepth += 1;
      if (token.kind === 'close' && token.name === dropUntil) {
        dropDepth -= 1;
        if (dropDepth === 0) dropUntil = null;
      }
      continue;
    }
    if (token.kind === 'text') {
      const value = decodeEntities(token.value);
      if (value.trim() === '' && (top() === undefined || top() === 'ul' || top() === 'ol'))
        continue;
      ensureTextContainer();
      out.push(escapeText(value));
      if (value.trim() !== '') markContent();
      continue;
    }
    const name = INLINE_ALIASES[token.name] ?? token.name;
    if (DROP_WITH_CONTENT.has(name)) {
      if (token.kind === 'open' && !token.selfClosing) {
        dropUntil = name;
        dropDepth = 1;
      }
      continue;
    }
    if (token.kind === 'open') {
      if (name === 'br') {
        ensureTextContainer();
        out.push('<br>');
        continue;
      }
      if (BLOCK_ALIASES.has(name) || name === 'p') {
        const item = stack.lastIndexOf('li');
        if (item !== -1) {
          // Inside a list item the editor wraps each line in <p>: keep one item, separate its lines with a break.
          while (stack.length - 1 > item) closeTop();
          if (hasContent[item] === true && !out[out.length - 1]?.endsWith('<br>')) out.push('<br>');
        } else {
          while (stack.length > 0) closeTop();
          openEl('p');
        }
        continue;
      }
      if (name === 'ul' || name === 'ol') {
        if (listDepth >= MAX_LIST_DEPTH) {
          // Too deep: the list is flattened into its parent, so its close tag must be skipped too.
          skippedLists += 1;
          continue;
        }
        if (top() === 'p') closeParagraph();
        if (top() === 'ul' || top() === 'ol') openEl('li');
        openEl(name);
        continue;
      }
      if (name === 'li') {
        if (top() === 'li') closeTop();
        if (top() !== 'ul' && top() !== 'ol') {
          // A stray item outside a list opens a bulleted one.
          if (top() === 'p') closeParagraph();
          openEl('ul');
        }
        openEl('li');
        continue;
      }
      if (INLINE_TAGS.has(name)) {
        ensureTextContainer();
        if (!token.selfClosing) openEl(name);
        continue;
      }
      continue;
    }
    // A closing tag.
    if (BLOCK_ALIASES.has(name)) {
      if (!stack.includes('li')) while (stack.length > 0) closeTop();
      continue;
    }
    if ((name === 'ul' || name === 'ol') && skippedLists > 0) {
      skippedLists -= 1;
      continue;
    }
    if (name === 'p' && stack.includes('li')) continue;
    if ((BLOCK_TAGS.has(name) || INLINE_TAGS.has(name)) && stack.includes(name)) closeTo(name);
  }
  while (stack.length > 0) closeTop();
  return out.join('');
}

/** True for a value written with the editor: it starts with a paragraph or list. */
export function isRichText(value: string): boolean {
  return /^\s*<(p|ul|ol)(\s[^>]*)?>/i.test(value);
}

/**
 * Plain wording as escaped paragraphs: a blank line starts a paragraph, a single newline is a line break. Extra
 * blank lines keep their height (one empty paragraph per blank line beyond the first) and spaces that start a line
 * keep their indent, so a term typed before rich text existed looks as it was typed.
 */
function plainToHtml(value: string): string {
  const parts = value.replace(/\r\n?/g, '\n').split(/(\n{2,})/);
  const out: string[] = [];
  for (const part of parts) {
    if (/^\n{2,}$/.test(part)) {
      // Only gaps between two blocks count; the first blank line is the paragraph break itself.
      if (out.length > 0) for (let i = 2; i < part.length; i++) out.push('<p><br></p>');
      continue;
    }
    const block = part.replace(/^\n+/, '').trimEnd();
    if (block.trim() === '') continue;
    const lines = block.split('\n').map((line) => {
      const indent = /^ +/.exec(line)?.[0].length ?? 0;
      return '&nbsp;'.repeat(indent) + escapeText(line.slice(indent));
    });
    out.push(`<p>${lines.join('<br>')}</p>`);
  }
  return out.join('');
}

/**
 * The HTML to draw for a stored term, safe to place inside an element: rich text is sanitised again (a hand-edited
 * row cannot inject), plain text is escaped. Every surface that shows terms calls this one function.
 */
export function richTextToHtml(value: string | null | undefined): string {
  if (value === null || value === undefined || value.trim() === '') return '';
  return isRichText(value) ? sanitizeRichText(value) : plainToHtml(value);
}

/** The words only, one line per paragraph or list item (items start with "- " or "1. "), for lengths, search and plain emails. */
export function richTextToPlain(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (!isRichText(value)) return value;
  const html = sanitizeRichText(value);
  const lines: string[] = [];
  const counters: number[] = [];
  const kinds: string[] = [];
  let line = '';
  const endLine = (): void => {
    if (line.trim() !== '') lines.push(line.replace(/\s+$/g, ''));
    line = '';
  };
  for (const token of tokenize(html)) {
    if (token.kind === 'text') {
      line += decodeEntities(token.value);
    } else if (token.name === 'br') {
      endLine();
    } else if (token.kind === 'open' && (token.name === 'ul' || token.name === 'ol')) {
      endLine();
      kinds.push(token.name);
      counters.push(0);
    } else if (token.kind === 'close' && (token.name === 'ul' || token.name === 'ol')) {
      endLine();
      kinds.pop();
      counters.pop();
    } else if (token.kind === 'open' && token.name === 'li') {
      endLine();
      const n = (counters[counters.length - 1] ?? 0) + 1;
      counters[counters.length - 1] = n;
      const indent = '  '.repeat(Math.max(0, kinds.length - 1));
      line = `${indent}${kinds[kinds.length - 1] === 'ol' ? `${n}. ` : '- '}`;
    } else if (token.name === 'p' || token.name === 'li') {
      endLine();
    }
  }
  endLine();
  return lines.join('\n');
}

/** A text field that takes rich text: sanitised on the way in, capped by the length of its words, not of its markup. */
export function richTextSchema(maxPlainChars: number) {
  return z
    .string()
    .max(Math.max(maxPlainChars * 8, 4_000))
    .transform((value) => (isRichText(value) ? sanitizeRichText(value) : value.trim()))
    .refine((value) => value.length > 0, 'must not be empty')
    .refine(
      (value) => richTextToPlain(value).length <= maxPlainChars,
      `must be at most ${maxPlainChars} characters`,
    );
}
