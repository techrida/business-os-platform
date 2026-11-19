// @vitest-environment jsdom
import { act, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { MultiSelect } from './multi-select';

// Real React handlers and native form serialization, without a browser (portal has no shared helper).
async function mountForm(node: ReactNode) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(() => Promise.resolve(root.render(node)));
  return {
    container,
    async unmount() {
      await act(() => Promise.resolve(root.unmount()));
      container.remove();
    },
  };
}

async function click(element: Element | null) {
  if (!(element instanceof HTMLElement)) throw new Error('Missing clickable element');
  await act(() => Promise.resolve(element.click()));
}

let mounted: Awaited<ReturnType<typeof mountForm>>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(async () => {
  await mounted?.unmount();
  document.body.innerHTML = '';
});

const STATUSES = [
  { value: 'new', label: 'New' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'qualified', label: 'Qualified' },
];

const trigger = () => mounted.container.querySelector<HTMLButtonElement>('form button')!;
const triggerText = () => trigger().textContent?.trim();
const options = () => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
const option = (label: string) => options().find((o) => o.textContent?.trim() === label)!;
const clearButton = () =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.textContent?.trim() === 'Clear',
  )!;
const submitted = () =>
  new FormData(mounted.container.querySelector('form')!).getAll('status') as string[];

async function key(target: Element, name: string) {
  await act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
    target.dispatchEvent(new KeyboardEvent('keyup', { key: name, bubbles: true }));
    return Promise.resolve();
  });
}

const field = (props: Partial<Parameters<typeof MultiSelect>[0]> = {}) => (
  <form>
    <MultiSelect
      name="status"
      label="Status"
      options={STATUSES}
      allLabel="All statuses"
      pluralLabel="statuses"
      {...props}
    />
  </form>
);

it('reads "All statuses", the one label, then "N statuses"', async () => {
  mounted = await mountForm(field());
  expect(triggerText()).toBe('All statuses');
  await click(trigger());
  await click(option('Contacted'));
  expect(triggerText()).toBe('Contacted');
  await click(option('New'));
  expect(triggerText()).toBe('2 statuses');
  await click(option('Qualified'));
  expect(triggerText()).toBe('3 statuses');
});

it('names the control and its list, and marks the list multi-select', async () => {
  mounted = await mountForm(field());
  expect(trigger().getAttribute('aria-haspopup')).toBe('listbox');
  await click(trigger());
  const list = document.querySelector('[role="listbox"]')!;
  expect(list.getAttribute('aria-label')).toBe('Status');
  expect(list.getAttribute('aria-multiselectable')).toBe('true');
  expect(trigger().getAttribute('aria-expanded')).toBe('true');
});

it('toggles values on and off and keeps the list open', async () => {
  const seen: string[][] = [];
  mounted = await mountForm(field({ onChange: (v) => seen.push(v) }));
  await click(trigger());
  await click(option('Qualified'));
  await click(option('New'));
  expect(seen).toEqual([['qualified'], ['new', 'qualified']]);
  expect(option('New').getAttribute('aria-selected')).toBe('true');
  expect(document.querySelector('[role="listbox"]')).not.toBeNull();
  await click(option('Qualified'));
  expect(seen.at(-1)).toEqual(['new']);
  expect(option('Qualified').getAttribute('aria-selected')).toBe('false');
});

it('submits one repeated param per selected value, in option order', async () => {
  mounted = await mountForm(field({ defaultValue: ['qualified', 'new'] }));
  expect(submitted()).toEqual(['new', 'qualified']);
  const hidden = mounted.container.querySelectorAll('input[type="hidden"][name="status"]');
  expect(hidden).toHaveLength(2);
  await click(trigger());
  await click(option('Contacted'));
  expect(submitted()).toEqual(['new', 'contacted', 'qualified']);
});

it('submits nothing when nothing is selected', async () => {
  mounted = await mountForm(field());
  expect(submitted()).toEqual([]);
});

it('drops duplicates and values that match no option', async () => {
  mounted = await mountForm(field({ defaultValue: ['new', 'new', 'gone'] }));
  expect(submitted()).toEqual(['new']);
  expect(triggerText()).toBe('New');
});

it('clears everything with the Clear row, closes, and returns focus to the trigger', async () => {
  const seen: string[][] = [];
  mounted = await mountForm(
    field({ defaultValue: ['new', 'contacted'], onChange: (v) => seen.push(v) }),
  );
  await click(trigger());
  expect(clearButton().disabled).toBe(false);
  await click(clearButton());
  expect(seen).toEqual([[]]);
  expect(triggerText()).toBe('All statuses');
  expect(submitted()).toEqual([]);
  expect(document.querySelector('[role="listbox"]')).toBeNull();
  expect(document.activeElement).toBe(trigger());
});

it('disables Clear when nothing is selected and keeps it out of the options', async () => {
  mounted = await mountForm(field());
  await click(trigger());
  expect(clearButton().disabled).toBe(true);
  expect(options().map((o) => o.textContent?.trim())).toEqual(['New', 'Contacted', 'Qualified']);
});

it('is uncontrolled: it keeps its own selection and follows a changed defaultValue', async () => {
  function Host() {
    const [d, setD] = useState<string[]>(['new']);
    return (
      <>
        <button type="button" id="back" onClick={() => setD(['qualified'])} />
        {field({ defaultValue: d })}
      </>
    );
  }
  mounted = await mountForm(<Host />);
  expect(triggerText()).toBe('New');
  await click(mounted.container.querySelector('#back'));
  expect(triggerText()).toBe('Qualified');
  expect(submitted()).toEqual(['qualified']);
});

it('is controlled: shows the value it is given and only changes when the parent does', async () => {
  const onChange = vi.fn();
  function Host() {
    const [v, setV] = useState<string[]>(['contacted']);
    return field({
      value: v,
      onChange: (next) => {
        onChange(next);
        setV(next);
      },
    });
  }
  mounted = await mountForm(<Host />);
  expect(triggerText()).toBe('Contacted');
  await click(trigger());
  await click(option('New'));
  expect(onChange).toHaveBeenCalledWith(['new', 'contacted']);
  expect(triggerText()).toBe('2 statuses');

  // A parent that ignores the change leaves the display alone.
  await mounted.unmount();
  mounted = await mountForm(field({ value: ['contacted'], onChange }));
  await click(trigger());
  await click(option('New'));
  expect(triggerText()).toBe('Contacted');
  expect(submitted()).toEqual(['contacted']);
});

it('opens with the arrow key, toggles with Space and Enter, and closes with Escape', async () => {
  const seen: string[][] = [];
  mounted = await mountForm(field({ onChange: (v) => seen.push(v) }));
  trigger().focus();
  await key(trigger(), 'ArrowDown');
  expect(document.querySelector('[role="listbox"]')).not.toBeNull();
  const first = document.activeElement!;
  expect(first.getAttribute('role')).toBe('option');
  await key(first, ' ');
  await key(document.activeElement!, 'ArrowDown');
  await key(document.activeElement!, 'Enter');
  expect(seen).toEqual([['new'], ['new', 'contacted']]);
  expect(triggerText()).toBe('2 statuses');
  await key(document.activeElement!, 'Escape');
  expect(document.querySelector('[role="listbox"]')).toBeNull();
});

it('falls back to "All" and "selected" when no labels are given', async () => {
  mounted = await mountForm(field({ allLabel: undefined, pluralLabel: undefined }));
  expect(triggerText()).toBe('All');
  await click(trigger());
  await click(option('New'));
  await click(option('Contacted'));
  expect(triggerText()).toBe('2 selected');
});

it('resets to its default with the form', async () => {
  mounted = await mountForm(field({ defaultValue: ['new'] }));
  await click(trigger());
  await click(option('Contacted'));
  expect(triggerText()).toBe('2 statuses');
  await act(async () => {
    mounted.container.querySelector('form')!.reset();
    await new Promise((r) => setTimeout(r, 5));
  });
  expect(triggerText()).toBe('New');
});
