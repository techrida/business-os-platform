import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// jsdom has no layout. FQA2 measured the vendor home and onboarding 435px wide in a 390px window:
// the tables' visually hidden cells are `position: absolute`, and a scroll box that is not itself
// positioned does not contain them, so one sat past the frame and widened the whole page.
// e2e/p4/vendor-portal-mobile.spec.ts measures the real pages at 390px.
describe.each([
  'src/components/vendor/vendor.module.css',
  'src/components/portal/quotation.module.css',
  'src/app/(portal)/invoices/_components/invoice-view.module.css',
])('%s', (file) => {
  const css = readFileSync(join(process.cwd(), file), 'utf8');

  it('positions every scrolling table frame so hidden cells stay inside it', () => {
    const frames = [...css.matchAll(/\n(\.\w*[Ff]rame) \{([^}]*)\}/g)].filter(([, , body]) =>
      /overflow-x: auto/.test(body ?? ''),
    );
    expect(frames.length).toBeGreaterThan(0);
    for (const [, name, body] of frames) {
      expect(body, `${name} in ${file}`).toMatch(/position: relative;/);
    }
  });
});
