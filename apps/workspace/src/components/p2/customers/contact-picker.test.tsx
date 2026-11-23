// @vitest-environment jsdom
// UIP-FORM-009 for a customer's contacts: one box that filters as you type (no Search button), rows show the name
// and what else matched, the last row is Create "<typed>" and it opens the real add-contact dialog with that name
// filled in; the saved contact becomes the choice. Real ContactPicker, ContactForm and Combobox; fake action.
import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { Field } from '@/components/ui/field';
import { click, fill, mountForm } from '@/test/form-interactions';

import { ContactPicker } from './contact-picker';
import type { ContactFormState } from './form-state';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ toast }));

const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const ASHA = '33333333-3333-4333-8333-333333333333';
const BINOD = '44444444-4444-4444-8444-444444444444';
const NEW = '55555555-5555-4555-8555-555555555555';
let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Element.prototype.scrollIntoView = () => {};
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
});

type Action = (prev: ContactFormState, form: FormData) => Promise<ContactFormState>;

function Harness({ action, withCreate = true }: { action: Action; withCreate?: boolean }) {
  const [value, setValue] = useState('');
  return (
    <Field label="Contact" optional>
      {(control) => (
        <ContactPicker
          control={control}
          name="contactId"
          options={[
            { id: ASHA, name: 'Asha Rai', detail: 'Sales lead · asha@acme.test' },
            { id: BINOD, name: 'Binod Karki', detail: 'binod@acme.test' },
          ]}
          value={value}
          onChange={setValue}
          create={withCreate ? { action, customerId: CUSTOMER } : null}
        />
      )}
    </Field>
  );
}

const savingAction = () =>
  vi.fn<Action>((prev, form) =>
    Promise.resolve({
      ...prev,
      errors: {},
      saved: `${form.get('fullName') as string} was added.`,
      contactId: NEW,
      savedCount: prev.savedCount + 1,
    }),
  );

const box = (root: ParentNode) => root.querySelector<HTMLInputElement>('input[role="combobox"]')!;
const hidden = (root: ParentNode) =>
  root.querySelector<HTMLInputElement>('input[type="hidden"][name="contactId"]')!;
const options = () =>
  Array.from(document.querySelectorAll('[role="option"]')).map((o) => o.textContent?.trim());

it('filters while typing, with no Search button, and matches what the row shows besides the name', async () => {
  mounted = await mountForm(<Harness action={savingAction()} />);
  const root = mounted.container;
  expect(
    Array.from(root.querySelectorAll('button')).some((b) => /search/i.test(b.textContent ?? '')),
  ).toBe(false);

  await fill(box(root), 'binod@');
  expect(options()).toEqual([expect.stringContaining('Binod Karki'), 'Create "binod@"']);
  expect(options()[0]).toContain('binod@acme.test');

  await fill(box(root), 'sales');
  expect(options()[0]).toContain('Asha Rai');
  await click(document.querySelector('[role="option"]'));
  expect(hidden(root).value).toBe(ASHA);
  expect(box(root).value).toContain('Asha Rai');
});

it('offers only Create "<typed>" when nothing matches, and opens the add-contact dialog with the name filled in', async () => {
  const action = savingAction();
  mounted = await mountForm(<Harness action={action} />);
  const root = mounted.container;
  await fill(box(root), 'Zed Zee');
  expect(options()).toEqual(['Create "Zed Zee"']);
  await click(document.querySelector('[role="option"]'));

  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.textContent).toContain('Add Contact');
  expect(dialog.querySelector<HTMLInputElement>('input[name="fullName"]')!.value).toBe('Zed Zee');
  // A picker does not know whether the customer has a main contact: the tick is not offered.
  expect(dialog.querySelector('input[name="isPrimary"]')).toBeNull();

  await click(dialog.querySelector('footer button[type="submit"]'));
  expect(action).toHaveBeenCalledTimes(1);
  expect(action.mock.calls[0]![1].get('customerId')).toBe(CUSTOMER);
  expect(action.mock.calls[0]![1].get('fullName')).toBe('Zed Zee');
  // The saved contact is now the choice and the dialog is gone.
  expect(hidden(root).value).toBe(NEW);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it('has no Create row when the page does not let the person add contacts', async () => {
  mounted = await mountForm(<Harness action={savingAction()} withCreate={false} />);
  await fill(box(mounted.container), 'Zed');
  expect(options()).toEqual([]);
  expect(document.body.textContent).toContain('No matching contact for this customer.');
});

it('puts "Optional" beside the label and no hint under the box', async () => {
  mounted = await mountForm(<Harness action={savingAction()} />);
  const label = mounted.container.querySelector('label')!;
  expect(label.parentElement!.textContent).toBe('ContactOptional');
  expect(mounted.container.textContent).not.toContain('Optional.');
});

it('lists more than 20 contacts as one flat list, with no "Unassigned" header', async () => {
  // Fails on the old picker: past 20 options the Combobox grouped them and put every ungrouped one under "Unassigned".
  const many = Array.from({ length: 25 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    name: `Contact ${String(i).padStart(2, '0')}`,
  }));
  function Many() {
    const [value, setValue] = useState('');
    return (
      <Field label="Contact" optional>
        {(control) => (
          <ContactPicker
            control={control}
            name="contactId"
            options={many}
            value={value}
            onChange={setValue}
          />
        )}
      </Field>
    );
  }
  mounted = await mountForm(<Many />);
  await click(box(mounted.container));
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(25);
  expect(document.body.textContent).not.toContain('Unassigned');
});
