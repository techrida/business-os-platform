import { describe, expect, it } from 'vitest';

import {
  isRichText,
  richTextSchema,
  richTextToHtml,
  richTextToPlain,
  sanitizeRichText,
} from './rich-text.js';

describe('sanitizeRichText', () => {
  it('keeps paragraphs, lists, bold and italic', () => {
    const html =
      '<p>Pay <strong>50%</strong> up front, <em>rest</em> on delivery.</p><ul><li>One</li><li>Two</li></ul><ol><li>First</li></ol>';
    expect(sanitizeRichText(html)).toBe(html);
  });

  it('is idempotent', () => {
    const messy = '<div>a<b>b</b><script>x</script><ul><li>i<li>j</ul>tail';
    const once = sanitizeRichText(messy);
    expect(sanitizeRichText(once)).toBe(once);
  });

  it('removes scripts and styles with their content', () => {
    expect(sanitizeRichText('<p>a</p><script>alert(1)</script><style>p{x:y}</style><p>b</p>')).toBe(
      '<p>a</p><p>b</p>',
    );
    expect(sanitizeRichText('<p>a<script>never closed')).toBe('<p>a</p>');
    expect(sanitizeRichText('<script><script>x</script>y</script><p>ok</p>')).toBe('<p>ok</p>');
  });

  it('strips links but keeps their text, and drops every attribute', () => {
    expect(sanitizeRichText('<p><a href="javascript:alert(1)" onclick="x()">click</a></p>')).toBe(
      '<p>click</p>',
    );
    expect(
      sanitizeRichText(
        '<p style="color:red" class="x" onmouseover="y()"><strong id="z">b</strong></p>',
      ),
    ).toBe('<p><strong>b</strong></p>');
    expect(sanitizeRichText('<p><img src=x onerror=alert(1)>text</p>')).toBe('<p>text</p>');
  });

  it('escapes text so no angle bracket becomes a tag', () => {
    expect(sanitizeRichText('<p>1 < 2 && 3 > 2</p>')).toBe('<p>1 &lt; 2 &amp;&amp; 3 &gt; 2</p>');
    expect(sanitizeRichText('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    );
    expect(sanitizeRichText('<p>&#60;script&#62;</p>')).toBe('<p>&lt;script&gt;</p>');
  });

  it('drops comments, doctypes and processing instructions', () => {
    expect(sanitizeRichText('<!-- <script>x</script> --><p>a</p><!DOCTYPE html><?php x ?>')).toBe(
      '<p>a</p>',
    );
  });

  it('maps b and i to strong and em, and block-like tags to paragraphs', () => {
    expect(sanitizeRichText('<div>a <b>b</b> <i>c</i></div><h2>Title</h2>')).toBe(
      '<p>a <strong>b</strong> <em>c</em></p><p>Title</p>',
    );
  });

  it('wraps stray text and repairs list structure', () => {
    expect(sanitizeRichText('plain words')).toBe('<p>plain words</p>');
    expect(sanitizeRichText('<li>loose</li>')).toBe('<ul><li>loose</li></ul>');
    expect(sanitizeRichText('<ul>text<li>a</li></ul>')).toBe('<ul><li>text</li><li>a</li></ul>');
    expect(sanitizeRichText('<p>a<p>b')).toBe('<p>a</p><p>b</p>');
  });

  it('accepts the paragraph-in-item shape the editor produces', () => {
    expect(sanitizeRichText('<ul><li><p>one</p></li><li><p>two</p><p>more</p></li></ul>')).toBe(
      '<ul><li>one</li><li>two<br>more</li></ul>',
    );
  });

  it('keeps nested lists and caps their depth', () => {
    expect(sanitizeRichText('<ul><li>a<ul><li>b</li></ul></li></ul>')).toBe(
      '<ul><li>a<ul><li>b</li></ul></li></ul>',
    );
    const deep =
      '<ul><li>1<ul><li>2<ul><li>3<ul><li>4<ul><li>5</li></ul></li></ul></li></ul></li></ul></li></ul>';
    expect(sanitizeRichText(deep).match(/<ul>/g)?.length).toBeLessThanOrEqual(4);
  });

  it('drops empty paragraphs, items and emphasis', () => {
    expect(sanitizeRichText('<p></p><p><br></p><ul><li></li></ul><p><strong></strong>x</p>')).toBe(
      '<p>x</p>',
    );
  });

  it('survives hostile fragments without leaving a tag the allow-list lacks', () => {
    const hostile = [
      '<scr<script>ipt>alert(1)</scr</script>ipt>',
      '<p><svg onload=alert(1)><circle/></svg>x</p>',
      '<iframe src="javascript:1"></iframe>',
      '<p>a</p\n>',
      '<a\nhref=x>t</a>',
      '<p onclick="a>b">t</p>',
      '<<p>>',
      '<p>\u0000<strong>x',
      '<math><mi xlink:href="javascript:1">x</mi></math>',
    ];
    for (const input of hostile) {
      const out = sanitizeRichText(input);
      expect(out).not.toMatch(/<(?!\/?(?:p|ul|ol|li|strong|em|br)>)/);
      expect(out).not.toMatch(/\son\w+=|javascript:|<script/i);
    }
  });

  it('copes with very large input', () => {
    const big = `<p>${'x'.repeat(500_000)}</p>`;
    expect(sanitizeRichText(big).length).toBeLessThan(210_000);
  });
});

describe('richTextToHtml', () => {
  it('draws legacy plain text as escaped paragraphs', () => {
    expect(richTextToHtml('Net 30\nlate fee 2%\n\nSecond <b>block</b>')).toBe(
      '<p>Net 30<br>late fee 2%</p><p>Second &lt;b&gt;block&lt;/b&gt;</p>',
    );
  });

  it('sanitises rich text again at render time', () => {
    expect(richTextToHtml('<p>ok</p><script>x</script>')).toBe('<p>ok</p>');
  });

  it('draws nothing for empty values', () => {
    expect(richTextToHtml(null)).toBe('');
    expect(richTextToHtml('   ')).toBe('');
  });
});

describe('richTextToPlain and the length cap', () => {
  it('lists items with bullets and numbers', () => {
    expect(
      richTextToPlain('<p>Intro</p><ul><li>a</li><li>b</li></ul><ol><li>x</li><li>y</li></ol>'),
    ).toBe('Intro\n- a\n- b\n1. x\n2. y');
  });

  it('returns legacy text unchanged', () => {
    expect(richTextToPlain('plain\ntext')).toBe('plain\ntext');
  });

  it('counts the words, not the markup, against the cap', () => {
    const schema = richTextSchema(10);
    expect(schema.safeParse('<p><strong>abcd</strong> <em>efgh</em></p>').success).toBe(true);
    expect(schema.safeParse('<p>12345678901</p>').success).toBe(false);
    expect(schema.safeParse('<p></p>').success).toBe(false);
  });

  it('stores rich input sanitised and leaves plain input as typed', () => {
    const schema = richTextSchema(100);
    expect(schema.parse('<p>a</p><script>x</script>')).toBe('<p>a</p>');
    expect(schema.parse('  Net 30  ')).toBe('Net 30');
  });
});

describe('isRichText', () => {
  it('tells editor output from legacy text', () => {
    expect(isRichText('<p>x</p>')).toBe(true);
    expect(isRichText('  <ul><li>x</li></ul>')).toBe(true);
    expect(isRichText('Net 30 <p>')).toBe(false);
    expect(isRichText('a < b')).toBe(false);
  });
});
