// @vitest-environment jsdom
import { act, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { click, fill, mountForm } from '@/test/form-interactions';
import { Combobox } from './combobox';
import type { ComboboxOption } from './combobox-model';
import { Dialog } from './dialog';

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

const PEOPLE: readonly ComboboxOption[] = [
  { id: 'u1', label: 'Aarav Sharma', description: 'Sales' },
  { id: 'u2', label: 'Bina Gurung', description: 'Finance' },
  { id: 'u3', label: 'Chandra Lama', description: 'Operations' },
];

function Host({
  initial = '',
  onChange,
  onSubmit,
}: {
  initial?: string;
  onChange?: (id: string) => void;
  onSubmit?: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [open, setOpen] = useState(false);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit?.();
      }}
    >
      <Combobox
        label="Owner"
        options={PEOPLE}
        value={value}
        onChange={(next) => {
          setValue(next);
          onChange?.(next);
        }}
        open={open}
        onOpenChange={setOpen}
        placeholder="Search staff"
      />
    </form>
  );
}

async function key(target: Element, name: string) {
  await act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }),
    );
    target.dispatchEvent(
      new KeyboardEvent('keyup', { key: name, bubbles: true, cancelable: true }),
    );
    return Promise.resolve();
  });
}

it('navigates with Arrows, Home, End, typeahead filtering, Enter and Escape', async () => {
  const seen: string[] = [];
  const onSubmit = vi.fn();
  mounted = await mountForm(<Host onChange={(id) => seen.push(id)} onSubmit={onSubmit} />);
  const input = mounted.container.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  input.focus();

  await key(input, 'ArrowDown');
  expect(document.querySelector('[role="listbox"]')).not.toBeNull();
  const activeOption = () => {
    const id = input.getAttribute('aria-activedescendant');
    return id ? document.getElementById(id)?.textContent?.trim() : null;
  };
  expect(activeOption()).toContain('Aarav Sharma');

  await key(input, 'End');
  expect(activeOption()).toContain('Chandra Lama');

  await key(input, 'Home');
  expect(activeOption()).toContain('Aarav Sharma');

  await key(input, 'Escape');
  expect(document.querySelector('[role="listbox"]')).toBeNull();
  expect(seen).toEqual([]);

  await fill(input, 'Bina');
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(1);
  await key(input, 'Enter');
  expect(seen).toEqual(['u2']);
  expect(onSubmit).not.toHaveBeenCalled();
  expect(document.querySelector('[role="listbox"]')).toBeNull();
});

it('portals through React Aria Popover and flips above when near the viewport bottom', async () => {
  const origViewport = window.visualViewport;
  const origClientHeight = Object.getOwnPropertyDescriptor(
    document.documentElement,
    'clientHeight',
  );
  const origClientWidth = Object.getOwnPropertyDescriptor(document.documentElement, 'clientWidth');
  const origOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  const origOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');

  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: {
      width: 1440,
      height: 900,
      offsetTop: 0,
      offsetLeft: 0,
      pageTop: 0,
      pageLeft: 0,
      scale: 1,
      addEventListener() {},
      removeEventListener() {},
    },
  });
  Object.defineProperty(document.documentElement, 'clientHeight', {
    configurable: true,
    value: 900,
  });
  Object.defineProperty(document.documentElement, 'clientWidth', {
    configurable: true,
    value: 1440,
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute('data-placement') || this.querySelector('[role="listbox"]')
        ? 180
        : 42;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() {
      return 260;
    },
  });

  try {
    mounted = await mountForm(<Host />);
    const input = mounted.container.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    input.getBoundingClientRect = () => new DOMRect(100, 800, 260, 42);
    await click(input);
    const listbox = document.querySelector<HTMLElement>('[role="listbox"]')!;
    const popover = listbox.closest<HTMLElement>('[data-placement]')!;
    expect(popover).not.toBeNull();
    // Portalled to body, not stuck inside the form wrapper.
    expect(mounted.container.contains(popover)).toBe(false);
    expect(popover.getAttribute('data-placement')).toBe('top');
    expect(popover.style.bottom).toBe('108px');
    expect(popover.style.maxHeight).toBe('784px');
  } finally {
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: origViewport });
    if (origClientHeight) {
      Object.defineProperty(document.documentElement, 'clientHeight', origClientHeight);
    }
    if (origClientWidth) {
      Object.defineProperty(document.documentElement, 'clientWidth', origClientWidth);
    }
    if (origOffsetHeight) {
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', origOffsetHeight);
    }
    if (origOffsetWidth) {
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', origOffsetWidth);
    }
  }
});

it('portals into the dialog container instead of being clipped by the scrolling dialog body', async () => {
  mounted = await mountForm(
    <Dialog open title="Pick owner">
      <Host />
    </Dialog>,
  );
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  const form = dialog.querySelector('form')!;
  const input = dialog.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  await click(input);
  const listbox = document.querySelector('[role="listbox"]')!;
  expect(dialog.contains(listbox)).toBe(true);
  expect(form.contains(listbox)).toBe(false);
});

it('shows the label and muted description when closed, the label alone while focused, and posts the id by name', async () => {
  mounted = await mountForm(
    <form>
      <Combobox
        label="Owner"
        options={PEOPLE}
        value="u1"
        onChange={() => undefined}
        open={false}
        onOpenChange={() => undefined}
        showDescriptionWhenClosed
        name="ownerId"
      />
    </form>,
  );
  const input = mounted.container.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  expect(input.value).toBe('Aarav Sharma Sales');
  expect(mounted.container.querySelector<HTMLInputElement>('input[name="ownerId"]')?.value).toBe(
    'u1',
  );
  await act(() => {
    input.focus();
    return Promise.resolve();
  });
  expect(input.value).toBe('Aarav Sharma');
});

it('offers a trailing custom "Create" row for text that matches nothing, and shows the option an empty value stands for', async () => {
  const added: string[] = [];
  mounted = await mountForm(
    <form>
      <Combobox
        label="Company"
        options={PEOPLE}
        value=""
        emptyStandsFor="u2"
        onChange={() => undefined}
        open
        onOpenChange={() => undefined}
        addOption={{ onAdd: (t) => added.push(t), label: (t) => `Create "${t}"` }}
      />
    </form>,
  );
  const input = mounted.container.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  expect(input.value).toBe('Bina Gurung');
  await fill(input, 'Zed Corp');
  const rows = [...document.querySelectorAll('[role="option"]')];
  expect(rows.at(-1)?.textContent).toContain('Create "Zed Corp"');
  await click(rows.at(-1)!);
  expect(added).toEqual(['Zed Corp']);
});
