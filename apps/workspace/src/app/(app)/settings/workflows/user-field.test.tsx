// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mountForm } from '@/test/form-interactions';
import { UserField } from './user-field';

let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
});

it('shows named choices, retains an unavailable selection, and offers no raw-ID input', async () => {
  mounted = await mountForm(
    <form>
      <UserField
        name="userId"
        label="Person"
        users={[{ id: 'opaque', label: 'Mina', name: 'Mina', email: null }]}
        defaultValue="old-opaque"
      />
    </form>,
  );
  const { container } = mounted;
  // The saved target is retained and shown by a name, never by its raw id.
  const hidden = container.querySelector<HTMLInputElement>('input[name="userId"]')!;
  expect(hidden.value).toBe('old-opaque');
  const box = container.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  expect(box.value).toBe('Current person (name unavailable)');
  // Nothing shows the raw id.
  expect(`${container.textContent}${box.value}`.replace(/old-opaque/g, '')).not.toContain('opaque');
  // The one named input is the hidden one; the visible box posts nothing.
  expect(Array.from(container.querySelectorAll('input[name="userId"]'))).toHaveLength(1);
  expect(Array.from(new FormData(container.querySelector('form')!).entries())).toEqual([
    ['userId', 'old-opaque'],
  ]);
});

it('shows a chosen person as name and role', async () => {
  mounted = await mountForm(
    <form>
      <UserField
        name="userId"
        label="Person"
        users={[{ id: 'p1', label: 'Mina (m@x.test)', name: 'Mina', email: 'm@x.test', role: 'Sales' }]}
        defaultValue="p1"
      />
    </form>,
  );
  expect(mounted.container.querySelector<HTMLInputElement>('input[role="combobox"]')!.value).toBe(
    'Mina Sales',
  );
});

it('disables new selection when the directory could not load', async () => {
  mounted = await mountForm(
    <form>
      <UserField name="userId" label="Person" users={null} />
    </form>,
  );
  const { container } = mounted;
  expect(container.textContent).toContain('People could not be loaded');
  // The field is disabled and so is its trigger; nothing is submitted.
  expect(container.querySelector<HTMLInputElement>('input[name="userId"]')!.disabled).toBe(true);
  expect(container.querySelector<HTMLInputElement>('input[role="combobox"]')!.disabled).toBe(true);
  expect(Array.from(new FormData(container.querySelector('form')!).keys())).toEqual([]);
  // Nothing the user could type an id into: the search box is disabled.
  expect(container.querySelectorAll('input:not([type="hidden"]):not(:disabled)')).toHaveLength(0);
});
