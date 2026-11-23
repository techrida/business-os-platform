import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';

import { Field, Input } from './field';

it('puts a muted "Optional" in the label row, outside the label', () => {
  const html = renderToStaticMarkup(
    <Field label="Branch" optional>
      {(control) => <Input name="branch" {...control} />}
    </Field>,
  );
  expect(html).toMatch(/<label[^>]*>Branch<\/label>/);
  expect(html.indexOf('Optional')).toBeGreaterThan(html.indexOf('</label>'));
  expect(html.indexOf('Optional')).toBeLessThan(html.indexOf('<input'));
  // The control is described by the marker too, so a screen reader hears it.
  const id = html.match(/<input[^>]*\sid="([^"]+)"/)?.[1];
  expect(html.match(/<input[^>]*>/)?.[0]).toContain(`${id}-optional`);
});

it('has one reserved message line: the error replaces the hint and nothing sits above the box', () => {
  const withHint = renderToStaticMarkup(
    <Field label="Amount" hint="In rupees.">
      {(control) => <Input name="amount" {...control} />}
    </Field>,
  );
  const withError = renderToStaticMarkup(
    <Field label="Amount" hint="In rupees." error="Too big.">
      {(control) => <Input name="amount" {...control} />}
    </Field>,
  );
  const empty = renderToStaticMarkup(
    <Field label="Amount">{(control) => <Input name="amount" {...control} />}</Field>,
  );
  expect(withHint.indexOf('In rupees.')).toBeGreaterThan(withHint.indexOf('<input'));
  expect(withError).not.toContain('In rupees.');
  for (const html of [withHint, withError, empty])
    expect(html.match(/data-message/g)).toHaveLength(1);
});
