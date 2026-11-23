import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Runs in the Dockerfile `test` stage, where cwd is apps/login and the patches are applied.
const read = (relative: string) => readFileSync(resolve(process.cwd(), relative), 'utf8');

describe('light-only lock', () => {
  it('pins the login layout, the error boundary and the theme provider to light', () => {
    expect(read('src/lib/theme-mode.ts')).toMatch(/BOS_LIGHT_ONLY\s*=\s*true/);
    expect(read('src/app/(login)/layout.tsx')).toContain(
      'data-theme={BOS_LIGHT_ONLY ? "light" : undefined}',
    );
    expect(read('src/app/global-error.tsx')).toContain(
      'data-theme={BOS_LIGHT_ONLY ? "light" : undefined}',
    );
    expect(read('src/components/theme-provider.tsx')).toContain(
      'forcedTheme={BOS_LIGHT_ONLY ? "light" : undefined}',
    );
  });
});

describe('brand tiles', () => {
  const rule = (css: string, selector: string) => {
    const match = css.match(
      new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`),
    );
    return match?.[1] ?? '';
  };
  const px = (block: string, prop: string) =>
    block.match(new RegExp(`${prop}:\\s*([\\d.]+)px`))?.[1];

  it.each(['.bos-brand-mark', '.bos-aside-monogram'])(
    '%s is a fixed square that does not shrink',
    (selector) => {
      const block = rule(read('src/styles/bos-shell.css'), selector);
      expect(px(block, 'width')).toBeDefined();
      expect(px(block, 'width')).toBe(px(block, 'height'));
      expect(block).toMatch(/flex:\s*(none|0 0 [\d.]+px)/);
    },
  );
});

describe('unknown addresses', () => {
  it('render the 404 inside the login layout, not as the bare Next page', () => {
    expect(read('src/app/(login)/[...unmatched]/page.tsx')).toContain('notFound()');
    expect(read('src/app/(login)/not-found.tsx')).toContain('AuthHeading');
  });
});
