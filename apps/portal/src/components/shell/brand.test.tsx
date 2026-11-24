import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Brand } from './brand';

describe('Brand (R6Q20)', () => {
  it('shows the company logo as an image named by the company, in place of the name text', () => {
    const html = renderToStaticMarkup(<Brand name="Techrida" logoSrc="/brand/logo/t/d" />);
    expect(html).toMatch(/<img[^>]*src="\/brand\/logo\/t\/d"[^>]*alt="Techrida"/);
    expect(html).not.toContain('>Techrida<');
  });

  it('falls back to the company name as text with no logo', () => {
    const html = renderToStaticMarkup(<Brand name="  Techrida " />);
    expect(html).not.toContain('<img');
    expect(html).toContain('>Techrida<');
  });

  it('falls back to the product name when nothing is set', () => {
    for (const html of [
      renderToStaticMarkup(<Brand />),
      renderToStaticMarkup(<Brand name={null} logoSrc={null} />),
      renderToStaticMarkup(<Brand name="   " />),
    ]) {
      expect(html).not.toContain('<img');
      expect(html).toContain('>Business OS<');
    }
  });
});
