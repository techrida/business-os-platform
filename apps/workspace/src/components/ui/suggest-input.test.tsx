// @vitest-environment jsdom
import { act, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { click, fill, mountForm } from '@/test/form-interactions';
import { Dialog } from './dialog';
import { Field } from './field';
import { SuggestInput } from './suggest-input';

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

const types = ['invoice', 'memo', 'quotation', 'memo_request'];

function submitted(container: HTMLElement) {
  return Object.fromEntries(new FormData(container.querySelector('form')!).entries());
}

function input(container: HTMLElement) {
  return container.querySelector('input[name]') as HTMLInputElement;
}

async function focus(element: HTMLElement) {
  await act(() => Promise.resolve(element.focus()));
}

function listed() {
  return Array.from(document.querySelectorAll('[role="option"]')).map((o) => o.textContent?.trim());
}

async function press(target: Element, key: string) {
  await act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
    return new Promise((resolve) => setTimeout(resolve, 50));
  });
}

it('submits free text that is not a suggestion', async () => {
  mounted = await mountForm(
    <form>
      <SuggestInput name="documentType" aria-label="Document type" suggestions={types} />
    </form>,
  );
  const field = input(mounted.container);
  expect(field.type).toBe('text');
  await focus(field);
  await fill(field, 'purchase_order');
  await act(() => Promise.resolve(field.blur()));
  expect(submitted(mounted.container)).toEqual({ documentType: 'purchase_order' });
});

it('submits a picked suggestion', async () => {
  mounted = await mountForm(
    <form>
      <SuggestInput name="documentType" aria-label="Document type" suggestions={types} />
    </form>,
  );
  await focus(input(mounted.container));
  expect(listed()).toEqual(types);
  const option = Array.from(document.querySelectorAll('[role="option"]')).find(
    (el) => el.textContent?.trim() === 'quotation',
  );
  await click(option ?? null);
  expect(submitted(mounted.container)).toEqual({ documentType: 'quotation' });
  expect(document.querySelector('[role="listbox"]')).toBeNull();
});

it('opens on focus with every suggestion and narrows to those containing the typed text', async () => {
  mounted = await mountForm(
    <form>
      <SuggestInput name="documentType" aria-label="Document type" suggestions={types} />
    </form>,
  );
  const field = input(mounted.container);
  await focus(field);
  expect(document.querySelector('[role="listbox"]')).not.toBeNull();
  expect(listed()).toEqual(types);
  await fill(field, 'EMO');
  expect(listed()).toEqual(['memo', 'memo_request']);
  await fill(field, 'zzz');
  expect(document.querySelector('[role="listbox"]')).toBeNull();
  expect(submitted(mounted.container)).toEqual({ documentType: 'zzz' });
});

it('shows every suggestion for an existing value, so it can be swapped', async () => {
  mounted = await mountForm(
    <form>
      <SuggestInput
        name="documentType"
        aria-label="Document type"
        suggestions={types}
        defaultValue="memo"
      />
    </form>,
  );
  const field = input(mounted.container);
  expect(field.value).toBe('memo');
  await focus(field);
  expect(listed()).toEqual(types);
});

it('closes on Escape and keeps the typed text', async () => {
  mounted = await mountForm(
    <form>
      <SuggestInput name="documentType" aria-label="Document type" suggestions={types} />
    </form>,
  );
  const field = input(mounted.container);
  await focus(field);
  await fill(field, 'mem');
  expect(document.querySelector('[role="listbox"]')).not.toBeNull();
  await press(field, 'Escape');
  expect(document.querySelector('[role="listbox"]')).toBeNull();
  expect(submitted(mounted.container)).toEqual({ documentType: 'mem' });
});

it('picks with the arrow keys and Enter', async () => {
  mounted = await mountForm(
    <form>
      <SuggestInput name="documentType" aria-label="Document type" suggestions={types} />
    </form>,
  );
  const field = input(mounted.container);
  await focus(field);
  await press(field, 'ArrowDown');
  await press(field, 'ArrowDown');
  await press(field, 'Enter');
  expect(submitted(mounted.container)).toEqual({ documentType: 'memo' });
});

it('reports every change as text, and follows a controlled value', async () => {
  const seen: string[] = [];
  function Owner() {
    const [text, setText] = useState('inv');
    return (
      <form>
        <SuggestInput
          name="groupKey"
          aria-label="Group key"
          suggestions={types}
          value={text}
          onChange={(next) => {
            seen.push(next);
            setText(next);
          }}
        />
      </form>
    );
  }
  mounted = await mountForm(<Owner />);
  const field = input(mounted.container);
  expect(field.value).toBe('inv');
  await focus(field);
  await fill(field, 'invoice2');
  expect(seen).toEqual(['invoice2']);
  expect(submitted(mounted.container)).toEqual({ groupKey: 'invoice2' });
  await fill(field, 'mem');
  const option = Array.from(document.querySelectorAll('[role="option"]')).find(
    (el) => el.textContent?.trim() === 'memo_request',
  );
  await click(option ?? null);
  expect(seen.at(-1)).toBe('memo_request');
  expect(field.value).toBe('memo_request');

  const fixed = await mountForm(
    <form>
      <SuggestInput
        name="groupKey"
        aria-label="Group key"
        suggestions={types}
        value="memo"
        onChange={() => undefined}
      />
    </form>,
  );
  await fill(input(fixed.container), 'quote');
  expect(input(fixed.container).value).toBe('memo');
  await fixed.unmount();
});

it('is labelled by its Field, and carries placeholder, required and error', async () => {
  mounted = await mountForm(
    <form>
      <Field label="Document type" error="Pick one">
        {(control) => (
          <SuggestInput
            name="documentType"
            suggestions={types}
            placeholder="All documents"
            autoComplete="off"
            required
            {...control}
          />
        )}
      </Field>
    </form>,
  );
  const field = input(mounted.container);
  const label = mounted.container.querySelector('label')!;
  expect(label.htmlFor).toBe(field.id);
  expect(field.placeholder).toBe('All documents');
  expect(field.autocomplete).toBe('off');
  expect(field.getAttribute('aria-invalid')).toBe('true');
  expect(field.required).toBe(true);
  expect(mounted.container.querySelectorAll(`[id="${field.id}"]`)).toHaveLength(1);
});

it('does not block the form because an error is shown', async () => {
  mounted = await mountForm(
    <form>
      <Field label="Document type" error="Unknown type">
        {(control) => (
          <SuggestInput name="documentType" suggestions={types} required {...control} />
        )}
      </Field>
    </form>,
  );
  const form = mounted.container.querySelector('form')!;
  const field = input(mounted.container);
  expect(field.getAttribute('aria-invalid')).toBe('true');
  await fill(field, 'anything');
  expect(form.checkValidity()).toBe(true);
  expect(field.getAttribute('aria-invalid')).toBe('true');
});

it('blocks submission while a required field is empty', async () => {
  mounted = await mountForm(
    <form>
      <SuggestInput name="documentType" aria-label="Document type" suggestions={types} required />
    </form>,
  );
  const form = mounted.container.querySelector('form')!;
  expect(form.checkValidity()).toBe(false);
  await fill(input(mounted.container), 'anything');
  expect(form.checkValidity()).toBe(true);
});

it('leaves a disabled field out of the submission', async () => {
  mounted = await mountForm(
    <form>
      <SuggestInput name="documentType" aria-label="Document type" suggestions={types} disabled />
    </form>,
  );
  expect(input(mounted.container)?.disabled ?? true).toBe(true);
  expect(submitted(mounted.container)).toEqual({});
});

it('lists inside a dialog, where the rest of the page is inert', async () => {
  const onChange = vi.fn();
  mounted = await mountForm(
    <Dialog open title="Delegate">
      <form>
        <SuggestInput
          name="documentType"
          aria-label="Document type"
          suggestions={types}
          onChange={onChange}
        />
      </form>
    </Dialog>,
  );
  const dialog = document.querySelector('[role="dialog"]')!;
  await focus(dialog.querySelector('input[name]') as HTMLElement);
  const listbox = document.querySelector('[role="listbox"]')!;
  expect(listbox).not.toBeNull();
  expect(dialog.contains(listbox)).toBe(true);
});

it('closes only its list on Escape inside a dialog', async () => {
  const onOpenChange = vi.fn();
  mounted = await mountForm(
    <Dialog open onOpenChange={onOpenChange} title="Delegate">
      <form>
        <SuggestInput name="documentType" aria-label="Document type" suggestions={types} />
      </form>
    </Dialog>,
  );
  const field = document.querySelector('[role="dialog"] input[name]') as HTMLInputElement;
  await focus(field);
  expect(document.querySelector('[role="listbox"]')).not.toBeNull();
  await press(field, 'Escape');
  expect(document.querySelector('[role="listbox"]')).toBeNull();
  expect(onOpenChange).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
});
