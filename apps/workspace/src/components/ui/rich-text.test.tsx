import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { RichText } from './rich-text';

const html = (value: string | null | undefined, className?: string) =>
  renderToStaticMarkup(<RichText value={value} {...(className ? { className } : {})} />);

describe('RichText', () => {
  it('draws paragraphs, bulleted and numbered lists, bold and italic', () => {
    const out = html(
      '<p>Pay <strong>in full</strong> or <em>in parts</em></p><ul><li>One</li><li>Two</li></ul><ol><li>First</li></ol>',
    );
    expect(out).toContain('<p>Pay <strong>in full</strong> or <em>in parts</em></p>');
    expect(out).toContain('<ul><li>One</li><li>Two</li></ul>');
    expect(out).toContain('<ol><li>First</li></ol>');
  });

  it('keeps nested lists nested', () => {
    const out = html('<ul><li>Parent<ul><li>Child</li></ul></li></ul>');
    expect(out.match(/<ul>/g)).toHaveLength(2);
    expect(out).toContain('Parent');
    expect(out).toContain('Child');
  });

  it('strips a script and a javascript: link', () => {
    const out = html(
      '<p>Terms</p><script>alert(1)</script><p><a href="javascript:alert(1)" onclick="x()">click</a></p>',
    );
    expect(out).toContain('<p>Terms</p>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
    expect(out).not.toContain('<a');
    expect(out).not.toContain('href');
    expect(out).not.toContain('javascript:');
    expect(out).not.toContain('onclick');
  });

  it('draws legacy plain text as escaped paragraphs', () => {
    const out = html('Net 30 days\n\nPay <b>now</b> & save');
    expect(out).toContain('<p>Net 30 days</p>');
    expect(out).toContain('<p>Pay &lt;b&gt;now&lt;/b&gt; &amp; save</p>');
    expect(out).not.toContain('<b>');
  });

  it('renders nothing for an empty value', () => {
    expect(html(null)).toBe('');
    expect(html(undefined)).toBe('');
    expect(html('')).toBe('');
    expect(html('   \n ')).toBe('');
  });

  it('adds the caller class next to its own', () => {
    expect(html('<p>Hi</p>', 'extra')).toContain('extra');
  });
});
