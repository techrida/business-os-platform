import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';

import { Field, Input } from './field';

it('puts the hint, or the error in its place, in one message line below the input', () => {
  const withError = renderToStaticMarkup(
    <Field label="Amount" hint="Enter the amount in rupees." error="Use a positive amount.">
      {(control) => <Input name="amount" {...control} />}
    </Field>,
  );
  const input = withError.match(/<input[^>]+>/)?.[0];
  const id = input?.match(/\sid="([^"]+)"/)?.[1];
  expect(id).toBeTruthy();
  expect(withError).toContain(`id="${id}-label" for="${id}"`);
  expect(input).toContain(`aria-labelledby="${id}-label"`);
  expect(input).toContain(`aria-describedby="${id}-error"`);
  expect(input).toContain('aria-invalid="true"');
  expect(withError.indexOf('<input')).toBeLessThan(withError.indexOf(`id="${id}-error"`));
  // The error replaces the hint: one message element, never two lines.
  expect(withError).not.toContain('Enter the amount in rupees.');
  expect(withError.match(/data-message/g)).toHaveLength(1);
  const withHint = renderToStaticMarkup(
    <Field label="Amount" hint="Enter the amount in rupees.">
      {(control) => <Input name="amount" {...control} />}
    </Field>,
  );
  expect(withHint).toContain('Enter the amount in rupees.');
  expect(withHint.match(/data-message/g)).toHaveLength(1);
});

it('reserves the message line even when there is no hint or error (UIP-FORM-010)', () => {
  const html = renderToStaticMarkup(
    <Field label="Name">{(control) => <Input name="name" {...control} />}</Field>,
  );
  expect(html).toMatch(/<span[^>]*data-message[^>]*><\/span>/);
  // Nothing sits between the label row and the box.
  const between = html.slice(html.indexOf('</label>'), html.indexOf('<input'));
  expect(between).not.toMatch(/<span/);
});

it('the box sits in the same place with or without an error, and beside a field with a hint', () => {
  const markup = (props: { hint?: string; error?: string }) =>
    renderToStaticMarkup(
      <Field label="Percent" optional {...props}>
        {(control) => <Input name="p" {...control} />}
      </Field>,
    );
  // Everything before the control is identical whatever the message says, so the box starts at one height.
  const before = (html: string) =>
    html.slice(0, html.indexOf('<input')).replace(/:r[0-9a-z]+:/g, 'ID');
  expect(before(markup({}))).toBe(before(markup({ error: 'Too big.' })));
  expect(before(markup({ hint: 'Whole numbers.' }))).toBe(before(markup({ error: 'Too big.' })));
});

it('puts a muted "Optional" in the label row, never in the hint', () => {
  const html = renderToStaticMarkup(
    <Field label="Branch" optional>
      {(control) => <Input name="branch" {...control} />}
    </Field>,
  );
  expect(html).toContain('Optional');
  // Inside the label row, after the label, before the control.
  expect(html.indexOf('>Branch</label>')).toBeLessThan(html.indexOf('Optional'));
  expect(html.indexOf('Optional')).toBeLessThan(html.indexOf('<input'));
  // The label's accessible name stays "Branch": the marker sits outside the <label>.
  expect(html).toMatch(/<label[^>]*>Branch<\/label>/);
  const none = renderToStaticMarkup(
    <Field label="Branch">{(control) => <Input name="branch" {...control} />}</Field>,
  );
  expect(none).not.toContain('Optional');
});

it('the stylesheet gives the label row and the message line a fixed minimum height', async () => {
  // jsdom has no layout, so the heights are asserted where they are set. The message line is one caption line high
  // and holds its space when empty; the error rule has it too, so swapping hint for error moves nothing.
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('./field.module.css', import.meta.url), 'utf8');
  const rule = (selector: string) =>
    css.match(new RegExp(`(?:^|\\n)${selector}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
  expect(rule('\\.labelRow')).toContain('min-height: var(--line-height-body-small)');
  expect(rule('\\.error')).toContain('min-height: var(--line-height-caption)');
  expect(css).toMatch(/\.message,\s*\.hint\s*\{[^}]*min-height: var\(--line-height-caption\)/);
});
