// @vitest-environment jsdom
import { act, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { fill, mountForm } from '@/test/form-interactions';
import { MemberPicker, memberComboboxOptions, type MemberOption } from './member-picker';

let mounted: Awaited<ReturnType<typeof mountForm>>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(async () => {
  await mounted?.unmount();
  document.body.innerHTML = '';
});

const PEOPLE: readonly MemberOption[] = [
  { id: 'u1', name: 'Dev Sales', role: 'Sales' },
  { id: 'u2', name: 'Bina Gurung', role: 'Accountant · Finance' },
  { id: 'u3', name: 'Chandra Lama', role: null },
];

async function key(target: Element, name: string) {
  await act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }),
    );
    return Promise.resolve();
  });
}

function Host({
  initial = '',
  onChange,
  people = PEOPLE,
}: {
  initial?: string;
  onChange?: (id: string) => void;
  people?: readonly MemberOption[];
}) {
  const [value, setValue] = useState(initial);
  return (
    <form>
      <MemberPicker
        label="Owner"
        name="ownerUserId"
        people={people}
        value={value}
        onChange={(id) => {
          setValue(id);
          onChange?.(id);
        }}
      />
    </form>
  );
}

const input = (c: HTMLElement) => c.querySelector<HTMLInputElement>('input[role="combobox"]')!;

it('shows the chosen person as name and role in the closed field, and only the name while typing', async () => {
  mounted = await mountForm(<Host initial="u1" />);
  const box = input(mounted.container);
  expect(box.value).toBe('Dev Sales Sales');
  // The muted role is painted over the box, so a reader sees what the list row shows.
  expect(mounted.container.querySelector('[aria-hidden="true"]')?.textContent).toBe(
    'Dev SalesSales',
  );
  await act(() => {
    box.focus();
    return Promise.resolve();
  });
  expect(box.value).toBe('Dev Sales');
});

it('shows only the name for a person without a role', async () => {
  mounted = await mountForm(<Host initial="u3" />);
  expect(input(mounted.container).value).toBe('Chandra Lama');
});

it('posts the chosen user id through a hidden input', async () => {
  mounted = await mountForm(<Host initial="u2" />);
  const hidden = mounted.container.querySelector<HTMLInputElement>('input[name="ownerUserId"]');
  expect(hidden?.type).toBe('hidden');
  expect(hidden?.value).toBe('u2');
});

it('filters by name or role as the user types and chooses with the keyboard', async () => {
  const seen: string[] = [];
  mounted = await mountForm(<Host onChange={(id) => seen.push(id)} />);
  const box = input(mounted.container);
  box.focus();
  await fill(box, 'financ');
  const options = [...document.querySelectorAll('[role="option"]')];
  expect(options).toHaveLength(1);
  expect(options[0]?.textContent).toContain('Bina Gurung');
  expect(options[0]?.textContent).toContain('Accountant · Finance');
  await key(box, 'Enter');
  expect(seen).toEqual(['u2']);
  await act(() => {
    box.blur();
    return Promise.resolve();
  });
  expect(box.value).toBe('Bina Gurung Accountant · Finance');
});

it('opens with ArrowDown and moves with the arrows', async () => {
  const seen: string[] = [];
  mounted = await mountForm(<Host onChange={(id) => seen.push(id)} />);
  const box = input(mounted.container);
  box.focus();
  await key(box, 'ArrowDown');
  expect(document.querySelector('[role="listbox"]')).not.toBeNull();
  await key(box, 'ArrowDown');
  await key(box, 'Enter');
  expect(seen).toHaveLength(1);
});

it('keeps a saved person the list no longer holds, by name, but does not offer them again', async () => {
  mounted = await mountForm(
    <MemberPicker
      label="Owner"
      people={PEOPLE}
      value="gone"
      current={{ id: 'gone', name: 'Old Owner', role: 'Sales' }}
    />,
  );
  expect(input(mounted.container).value).toBe('Old Owner Sales');
});

it('tells two people with the same name and role apart', () => {
  const options = memberComboboxOptions([
    { id: 'aaaaaaaa-1111', name: 'Sam', role: 'Sales' },
    { id: 'bbbbbbbb-2222', name: 'Sam', role: 'Sales' },
    { id: 'cccccccc-3333', name: 'Sam', role: 'Finance' },
  ]);
  expect(options.map((o) => o.description)).toEqual([
    'Sales · ref aaa-1111',
    'Sales · ref bbb-2222',
    'Finance',
  ]);
});

it('works uncontrolled from a default value', async () => {
  mounted = await mountForm(
    <form>
      <MemberPicker label="Owner" name="o" people={PEOPLE} defaultValue="u2" />
    </form>,
  );
  expect(input(mounted.container).value).toBe('Bina Gurung Accountant · Finance');
  expect(mounted.container.querySelector<HTMLInputElement>('input[name="o"]')?.value).toBe('u2');
});

it('shows the person an empty value stands for while posting nothing, and flat lists stay ungrouped', async () => {
  const many = Array.from({ length: 25 }, (_, i) => ({
    id: `u${i}`,
    name: `Person ${String(i).padStart(2, '0')}`,
    role: 'Sales',
  }));
  mounted = await mountForm(
    <form>
      <MemberPicker label="Owner" name="o" people={many} value="" emptyStandsFor="u3" />
    </form>,
  );
  const box = input(mounted.container);
  expect(box.value).toBe('Person 03 Sales');
  expect(mounted.container.querySelector<HTMLInputElement>('input[name="o"]')?.value).toBe('');
  await act(() => {
    box.focus();
    box.click();
    return Promise.resolve();
  });
  // 25 people without departments: one flat list, no "Unassigned" heading.
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(25);
  expect(document.body.textContent).not.toContain('Unassigned');
});
