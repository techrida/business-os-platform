import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * UIP-BUILD-002: the browser's own validation bubble ("Please fill out this field") must never show; an error is the
 * app's Field error text. A `<form>` without `noValidate` lets the browser block a submit on a `required`, `pattern`,
 * `min`, `max` or `type="email"` control and draw that bubble, so every `<form>` in the workspace and the portal
 * carries `noValidate`, and the app checks the value itself. There is no allow-list: a form with nothing to validate
 * (a sign-out button) takes the attribute too.
 */
const here = dirname(fileURLToPath(import.meta.url));
const roots = [resolve(here, '..'), resolve(here, '../../../portal/src')];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sources(path);
    return /\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name) ? [path] : [];
  });
}

/** Blank out comments (keeping every offset), so a `<form>` in a doc comment is not a form. */
function withoutComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\\])\/\/[^\n]*/gm, (line, lead: string) => lead + ' '.repeat(line.length - 1));
}

/** The opening tag of every `<form`, read to its closing `>` (not one inside `{...}` or a string). */
export function formTags(code: string): { tag: string; line: number }[] {
  const text = withoutComments(code);
  const found: { tag: string; line: number }[] = [];
  for (const match of text.matchAll(/<form(?=[\s>])/g)) {
    let depth = 0;
    let quote: string | null = null;
    let end = match.index + 5;
    for (; end < text.length; end++) {
      const c = text[end]!;
      if (quote) {
        if (c === quote) quote = null;
      } else if (depth === 0 && (c === '"' || c === "'")) quote = c;
      else if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    found.push({
      tag: text.slice(match.index, end + 1),
      line: text.slice(0, match.index).split('\n').length,
    });
  }
  return found;
}

const hasNoValidate = (tag: string) => /\snoValidate(?=[\s/>])/.test(tag);

describe('every <form> carries noValidate', () => {
  it('has no form without it in the workspace or the portal', () => {
    const missing: string[] = [];
    let seen = 0;
    for (const root of roots) {
      for (const file of sources(root)) {
        for (const { tag, line } of formTags(readFileSync(file, 'utf8'))) {
          seen++;
          if (!hasNoValidate(tag))
            missing.push(`${relative(resolve(here, '../../../..'), file)}:${line}`);
        }
      }
    }
    // A scan that found no forms would pass for the wrong reason.
    expect(seen).toBeGreaterThan(30);
    expect(missing).toEqual([]);
  });

  it('the scanner sees a bare form, a multi-line form, and ignores a doc comment', () => {
    const bare = formTags('const a = <form action={go}><input required /></form>;');
    expect(bare).toHaveLength(1);
    expect(hasNoValidate(bare[0]!.tag)).toBe(false);

    const multi = formTags(
      [
        '<form',
        '  action={(d) => go(d)}',
        '  onSubmit={(e) => e.preventDefault()}',
        '>',
        '</form>',
      ].join('\n'),
    );
    expect(hasNoValidate(multi[0]!.tag)).toBe(false);

    const ok = formTags('<form noValidate action={go} onSubmit={(e) => x > 1}>');
    expect(hasNoValidate(ok[0]!.tag)).toBe(true);

    expect(
      formTags('/*\n * a plain <form action> works\n */\n// or <form method="get">\n'),
    ).toEqual([]);
  });
});
