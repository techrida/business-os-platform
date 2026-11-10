import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { UserField } from './user-field';

it('shows named choices, retains an unavailable selection, and offers no raw-ID input', () => {
  const html = renderToStaticMarkup(
    <UserField
      name="userId"
      label="Person"
      users={[{ id: 'opaque', label: 'Mina', name: 'Mina', email: null }]}
      defaultValue="old-opaque"
    />,
  );
  expect(html).toContain('Mina');
  expect(html).toContain('value="old-opaque" selected');
  expect(html).toContain('Current person (name unavailable)');
  expect(html.replace(/<[^>]*>/g, '')).not.toContain('opaque');
  expect(html).not.toContain('<input');
});
it('disables new selection when the directory could not load', () => {
  const html = renderToStaticMarkup(<UserField name="userId" label="Person" users={null} />);
  expect(html).toContain('disabled');
  expect(html).toContain('People could not be loaded');
  expect(html).not.toContain('<input');
});
