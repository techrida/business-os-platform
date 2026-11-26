import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({
    href,
    prefetch,
    children,
    ...rest
  }: {
    href: string;
    prefetch?: boolean;
    children?: ReactNode;
  }) =>
    createElement(
      'a',
      { href, 'data-router': 'true', 'data-prefetch': String(prefetch), ...rest },
      children,
    ),
}));

import { LinkButton } from './button';
import { linkKind } from './link-kind';

const render = (props: Parameters<typeof LinkButton>[0]) =>
  renderToStaticMarkup(createElement(LinkButton, props, 'Go'));

describe('LinkButton', () => {
  it('sends an internal page path through next/link without a prefetch', () => {
    const html = render({ href: '/quotations/new' });
    expect(html).toContain('data-router="true"');
    expect(html).toContain('data-prefetch="false"');
    expect(html).toContain('href="/quotations/new"');
  });

  it('keeps a plain anchor for route handlers, downloads, new tabs, external links and `native`', () => {
    const plain = [
      { href: '/auth/login' },
      { href: '/api/documents/1/versions/2/download' },
      { href: '/payables/vat-register/export?from=2026-01-01' },
      { href: '/imports/customers/template' },
      { href: '/imports/result/1/errors' },
      { href: '/quotations/1/versions/2/document' },
      { href: '/quotations/1/versions/2/document/preview' },
      { href: '/quotations/new', download: '' },
      { href: '/quotations/new', target: '_blank' },
      { href: 'https://example.com/x' },
      { href: '//example.com/x' },
      { href: '/quotations/new', native: true },
    ];
    for (const props of plain) {
      const html = render(props);
      expect(html, JSON.stringify(props)).not.toContain('data-router');
      expect(html).toContain('<a ');
    }
  });
});

// Every literal LinkButton href in the app must classify, and none may be a route handler the
// router would fetch. Handlers come from the route.ts files themselves.
const SRC = join(__dirname, '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function handlerMatchers(): RegExp[] {
  return walk(join(SRC, 'app'))
    .filter((f) => /[\\/]route\.ts$/.test(f))
    .map((f) =>
      relative(join(SRC, 'app'), f)
        .split(sep)
        .slice(0, -1)
        .filter((s) => !/^\(.*\)$/.test(s))
        .map((s) => (/^\[.*\]$/.test(s) ? '[^/]+' : s.replace(/[.*+?^${}()|\\]/g, '\\$&')))
        .join('/'),
    )
    .map((p) => new RegExp(`^/${p}$`));
}

/** href attribute of each <LinkButton ...> in a source file: literal text, or the expression. */
function linkButtonHrefs(source: string): { literal: string | null; expr: string }[] {
  const found: { literal: string | null; expr: string }[] = [];
  for (const m of source.matchAll(/<LinkButton\b/g)) {
    const rest = source.slice((m.index ?? 0) + m[0].length);
    const h = /\bhref=(?:"([^"]*)"|\{`([^`]*)`\}|\{'([^']*)'\})/.exec(rest);
    const attr = /\bhref=/.exec(rest);
    if (attr === null) continue;
    const literal = h?.[1] ?? h?.[2] ?? h?.[3] ?? null;
    if (h !== null && h.index === attr.index) found.push({ literal, expr: h[0] });
    else found.push({ literal: null, expr: rest.slice(attr.index, attr.index + 80) });
  }
  return found;
}

describe('literal LinkButton hrefs', () => {
  const matchers = handlerMatchers();
  const files = walk(SRC).filter(
    (f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx') && !f.endsWith(join('ui', 'button.tsx')),
  );
  const literals: string[] = [];
  for (const f of files) {
    for (const { literal } of linkButtonHrefs(readFileSync(f, 'utf8'))) {
      if (literal !== null) literals.push(literal.replace(/\$\{[^}]*\}/g, 'x'));
    }
  }

  it('finds the literal hrefs', () => {
    expect(literals.length).toBeGreaterThan(5);
  });

  it('classifies every literal href, and never gives the router a route handler', () => {
    for (const href of literals) {
      const kind = linkKind({ href });
      expect(['router', 'native'], href).toContain(kind);
      const path = href.split(/[?#]/, 1)[0] ?? '';
      if (matchers.some((re) => re.test(path))) {
        expect(kind, `${href} is a route handler`).toBe('native');
      }
    }
  });
});
