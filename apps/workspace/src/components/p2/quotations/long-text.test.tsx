// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RichText } from '@/components/ui/rich-text';
import { click, mountForm } from '@/test/form-interactions';

import { LongText } from './long-text';

let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const LONG = `Scope of work. ${'Install and test the cabling. '.repeat(20)}`;

describe('LongText', () => {
  it('shows short text in full with no toggle', () => {
    const html = renderToStaticMarkup(<LongText text="One short line.">One short line.</LongText>);
    expect(html).toContain('One short line.');
    expect(html).not.toContain('<button');
  });

  it('starts collapsed with the whole text still in the page', () => {
    const html = renderToStaticMarkup(<LongText text={LONG}>{LONG}</LongText>);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('Show more');
    expect(html).toContain(LONG.trim());
  });

  it('toggles Show more and Show less and keeps aria in step', async () => {
    mounted = await mountForm(<LongText text={LONG}>{LONG}</LongText>);
    const button = () => mounted!.container.querySelector('button');
    const paragraph = () => mounted!.container.querySelector('[id]');

    expect(button()?.textContent).toBe('Show more');
    expect(button()?.getAttribute('aria-expanded')).toBe('false');
    expect(button()?.getAttribute('aria-controls')).toBe(paragraph()?.id);
    const collapsedClass = paragraph()?.className;

    await click(button());
    expect(button()?.textContent).toBe('Show less');
    expect(button()?.getAttribute('aria-expanded')).toBe('true');
    expect(paragraph()?.className).not.toBe(collapsedClass);

    await click(button());
    expect(button()?.textContent).toBe('Show more');
    expect(button()?.getAttribute('aria-expanded')).toBe('false');
    expect(paragraph()?.className).toBe(collapsedClass);
  });

  it('collapses text with many typed line breaks even when it is short', () => {
    const html = renderToStaticMarkup(<LongText text={'a\nb\nc\nd\ne\nf\ng'}>a</LongText>);
    expect(html).toContain('Show more');
  });

  it('holds rich wording as a list and never a script', () => {
    const value = '<ul><li>One</li><li>Two</li></ul><script>alert(1)</script>';
    const html = renderToStaticMarkup(
      <LongText text="- One\n- Two">
        <RichText value={value} />
      </LongText>,
    );
    expect(html).toContain('<ul><li>One</li><li>Two</li></ul>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('alert(1)');
  });
});
