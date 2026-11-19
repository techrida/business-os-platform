// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { click, mountForm } from '@/test/form-interactions';
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
  const trigger = container.querySelector('button')!;
  expect(trigger.textContent).toContain('Current person (name unavailable)');
  // The user can pick a named person; the raw id is submitted but never shown.
  await click(trigger);
  const labels = Array.from(document.querySelectorAll('[role="option"]')).map((o) =>
    o.textContent?.trim(),
  );
  expect(labels).toEqual(['Current person (name unavailable)', 'Mina']);
  expect(
    `${container.textContent}${document.body.textContent}`.replace(/old-opaque/g, ''),
  ).not.toContain('opaque');
  // No raw-ID text input: the only visible control is the dropdown; the one named input is hidden.
  const named = Array.from(container.querySelectorAll('input[name="userId"]'));
  expect(named).toHaveLength(1);
  expect(container.querySelectorAll('input:not([type="hidden"])')).toHaveLength(0);
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
  expect(container.querySelector('button')!.disabled).toBe(true);
  expect(Array.from(new FormData(container.querySelector('form')!).keys())).toEqual([]);
  // No raw-ID text box is offered; the only input is the hidden form field.
  expect(container.querySelectorAll('input:not([type="hidden"])')).toHaveLength(0);
});
