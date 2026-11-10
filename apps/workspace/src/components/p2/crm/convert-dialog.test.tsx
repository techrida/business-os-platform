import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  selected: false,
  duplicates: [] as {
    kind: 'customer' | 'contact';
    id: string;
    label: string;
    matchedOn: string;
  }[],
}));
vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>();
  return {
    ...react,
    useActionState: (_action: unknown, initial: object) => [
      { ...initial, duplicates: fixture.duplicates },
      () => {},
      false,
    ],
    useState: (initial: unknown) => {
      const value: unknown = typeof initial === 'function' ? (initial as () => unknown)() : initial;
      return react.useState(
        fixture.selected && value && typeof value === 'object' && 'customerMode' in value
          ? {
              ...value,
              customerMode: 'existing',
              customerId: 'customer-uuid',
              customerLabel: 'Himal Supplies',
              contactMode: 'existing',
              contactId: 'contact-uuid',
              contactLabel: 'Mina',
            }
          : value,
      );
    },
  };
});
const { ConvertDialog } = await import('./convert-dialog');
const render = () =>
  renderToStaticMarkup(
    <ConvertDialog
      lead={{
        id: 'lead-uuid',
        version: 1,
        number: 'LEAD-1',
        title: 'Office supply',
        companyName: 'Himal Supplies',
        contactName: 'Mina',
        email: '',
        phone: '',
      }}
      action={vi.fn()}
    />,
  );

beforeEach(() => {
  fixture.selected = false;
  fixture.duplicates = [];
});

it('offers creation without ID paste fields or roadmap copy', () => {
  const html = render();
  expect(html).toContain('Create a new customer');
  expect(html).not.toContain('Customer id');
  expect(html).not.toContain('Contact id');
  expect(html).not.toContain('customer screens');
  expect(html).not.toContain('name="customerId"');
  expect(html).not.toContain('name="contactId"');
  expect(html).not.toContain('Link to an existing customer');
});

it('keeps named duplicate choices available', () => {
  fixture.duplicates = [
    { kind: 'customer', id: 'customer-uuid', label: 'Himal Supplies', matchedOn: 'name' },
  ];
  const html = render();
  expect(html).toContain('Use existing');
  expect(html).toContain('Himal Supplies');
  expect(html).not.toContain('customer-uuid');
});

it('submits selected duplicate IDs only through hidden fields and displays their names', () => {
  fixture.selected = true;
  const html = render();
  expect(html).toContain('type="hidden" name="customerId" value="customer-uuid"');
  expect(html).toContain('type="hidden" name="contactId" value="contact-uuid"');
  expect(html).toContain('value="Himal Supplies"');
  expect(html).toContain('value="Mina"');
  expect(html).not.toMatch(/<input(?![^>]*type="hidden")[^>]*value="(?:customer|contact)-uuid"/);
});
