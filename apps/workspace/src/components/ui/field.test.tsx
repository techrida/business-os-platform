import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';

import { Field, Input } from './field';

it('renders help and errors below the input and associates both with it', () => {
  const html = renderToStaticMarkup(
    <Field label="Amount" hint="Enter the amount in rupees." error="Use a positive amount.">
      {(control) => <Input name="amount" {...control} />}
    </Field>,
  );

  const input = html.match(/<input[^>]+>/)?.[0];
  const id = input?.match(/\sid="([^"]+)"/)?.[1];
  expect(id).toBeTruthy();
  expect(html).toContain(`id="${id}-label" for="${id}"`);
  expect(input).toContain(`aria-labelledby="${id}-label"`);
  expect(input).toContain(`aria-describedby="${id}-hint ${id}-error"`);
  expect(input).toContain('aria-invalid="true"');
  expect(html.indexOf(`id="${id}-label"`)).toBeLessThan(html.indexOf('<input'));
  expect(html.indexOf('<input')).toBeLessThan(html.indexOf(`id="${id}-hint"`));
  expect(html.indexOf(`id="${id}-hint"`)).toBeLessThan(html.indexOf(`id="${id}-error"`));
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
