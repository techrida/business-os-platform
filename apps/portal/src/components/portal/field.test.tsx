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
});
