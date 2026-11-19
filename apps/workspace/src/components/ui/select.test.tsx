// @vitest-environment jsdom
import { act, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { choose, mountForm, submit } from '@/test/form-interactions';
import { Dialog } from './dialog';
import { Field, Select } from './field';
import type { SelectChangeEvent, SelectHandle } from './select';

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

const departments = (
  <>
    <option value="">Choose department</option>
    <option value="d1">Finance</option>
    <option value="d2">Operations</option>
    <option value="d3" disabled>
      Closed
    </option>
  </>
);

function submitted(container: HTMLElement) {
  return Object.fromEntries(new FormData(container.querySelector('form')!).entries());
}

it('submits the chosen value with the form', async () => {
  mounted = await mountForm(
    <form>
      <Select name="departmentId" aria-label="Department" required>
        {departments}
      </Select>
    </form>,
  );
  await choose(mounted.container, 'departmentId', 'Operations');
  expect(submitted(mounted.container)).toEqual({ departmentId: 'd2' });
});

it('shows the empty option as a placeholder, never as a choice, when required', async () => {
  mounted = await mountForm(
    <form>
      <Select name="departmentId" aria-label="Department" required>
        {departments}
      </Select>
    </form>,
  );
  const trigger = mounted.container.querySelector('button')!;
  expect(trigger.textContent).toContain('Choose department');
  await act(() => Promise.resolve(trigger.click()));
  const options = Array.from(document.querySelectorAll('[role="option"]')).map((o) =>
    o.textContent?.trim(),
  );
  expect(options).toEqual(['Finance', 'Operations', 'Closed']);
  expect(document.querySelector('[role="listbox"]')).not.toBeNull();
  expect(document.querySelector('[role="option"][aria-disabled="true"]')?.textContent).toBe(
    'Closed',
  );
  expect(submitted(mounted.container)).toEqual({ departmentId: '' });
});

it('keeps an empty option as a real choice when not required', async () => {
  mounted = await mountForm(
    <form>
      <Select name="status" aria-label="Status" defaultValue="open">
        <option value="">All statuses</option>
        <option value="open">Open</option>
      </Select>
    </form>,
  );
  expect(submitted(mounted.container)).toEqual({ status: 'open' });
  await choose(mounted.container, 'status', 'All statuses');
  expect(submitted(mounted.container)).toEqual({ status: '' });
});

it('calls onChange with the value and the form, after the form value has updated', async () => {
  let seen: {
    value: string;
    form: HTMLFormElement | null;
    field: FormDataEntryValue | null;
  } | null = null;
  const onChange = vi.fn((event: SelectChangeEvent) => {
    const form = event.currentTarget.form;
    seen = {
      value: event.target.value,
      form,
      field: form ? new FormData(form).get('status') : null,
    };
  });
  mounted = await mountForm(
    <form>
      <Select name="status" aria-label="Status" defaultValue="" onChange={onChange}>
        <option value="">All</option>
        <option value="open">Open</option>
      </Select>
    </form>,
  );
  await choose(mounted.container, 'status', 'Open');
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(seen).toMatchObject({ value: 'open', field: 'open' });
  expect(seen!.form).toBe(mounted.container.querySelector('form'));
});

it('follows a controlled value and reports the change to its owner', async () => {
  function Owner() {
    const [kind, setKind] = useState('b');
    return (
      <form>
        <Select
          name="kind"
          aria-label="Kind"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          <option value="a">Alpha</option>
          <option value="b">Beta</option>
        </Select>
      </form>
    );
  }
  mounted = await mountForm(<Owner />);
  expect(mounted.container.querySelector('button')!.textContent).toContain('Beta');
  await choose(mounted.container, 'kind', 'Alpha');
  expect(mounted.container.querySelector('button')!.textContent).toContain('Alpha');
  expect(submitted(mounted.container)).toEqual({ kind: 'a' });

  const fixed = await mountForm(
    <form>
      <Select name="kind" aria-label="Kind" value="b" onChange={() => undefined}>
        <option value="a">Alpha</option>
        <option value="b">Beta</option>
      </Select>
    </form>,
  );
  await choose(fixed.container, 'kind', 'Alpha');
  expect(fixed.container.querySelector('button')!.textContent).toContain('Beta');
  await fixed.unmount();
});

it('names the control by its label, and exposes error and focus', async () => {
  const ref = { current: null as SelectHandle | null };
  mounted = await mountForm(
    <form>
      <Field label="Department" error="Pick a department">
        {(control) => (
          <Select name="departmentId" ref={ref} required {...control}>
            {departments}
          </Select>
        )}
      </Field>
    </form>,
  );
  const trigger = mounted.container.querySelector('button')!;
  expect(trigger.getAttribute('aria-haspopup')).toBe('listbox');
  const labelledBy = trigger.getAttribute('aria-labelledby') ?? '';
  const names = labelledBy
    .split(' ')
    .map((id) => mounted.container.querySelector(`[id="${id}"]`)?.textContent)
    .join(' ');
  expect(names).toContain('Department');
  expect(mounted.container.querySelector('[class*="invalid"]')).not.toBeNull();
  await act(() => Promise.resolve(ref.current?.focus()));
  expect(document.activeElement).toBe(trigger);
});

it('opens with the keyboard, moves with arrows and picks with Enter', async () => {
  mounted = await mountForm(
    <form>
      <Select name="kind" aria-label="Kind" defaultValue="a">
        <option value="a">Alpha</option>
        <option value="b">Beta</option>
        <option value="c">Gamma</option>
      </Select>
    </form>,
  );
  const trigger = mounted.container.querySelector('button')!;
  trigger.focus();
  const press = (target: Element, key: string) =>
    act(() => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
      return Promise.resolve();
    });
  await press(trigger, 'ArrowDown');
  const listbox = document.querySelector('[role="listbox"]')!;
  expect(listbox).not.toBeNull();
  await press(document.activeElement!, 'ArrowDown');
  await press(document.activeElement!, 'Enter');
  expect(submitted(mounted.container)).toEqual({ kind: 'b' });
  expect(document.querySelector('[role="listbox"]')).toBeNull();
});

it('closes on Escape without changing the value', async () => {
  mounted = await mountForm(
    <form>
      <Select name="kind" aria-label="Kind" defaultValue="a">
        <option value="a">Alpha</option>
        <option value="b">Beta</option>
      </Select>
    </form>,
  );
  const trigger = mounted.container.querySelector('button')!;
  trigger.focus();
  await act(() => Promise.resolve(trigger.click()));
  expect(document.querySelector('[role="listbox"]')).not.toBeNull();
  await act(() => {
    const target = document.querySelector('[role="listbox"]')!;
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    target.dispatchEvent(
      new KeyboardEvent('keyup', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    return new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(document.querySelector('[role="listbox"]')).toBeNull();
  expect(submitted(mounted.container)).toEqual({ kind: 'a' });
});

it('disables the trigger and leaves the field out of the submission', async () => {
  mounted = await mountForm(
    <form>
      <Select name="kind" aria-label="Kind" defaultValue="a" disabled>
        <option value="a">Alpha</option>
      </Select>
    </form>,
  );
  expect(mounted.container.querySelector('button')!.disabled).toBe(true);
  expect(submitted(mounted.container)).toEqual({});
});

it('blocks submission while a required Select is empty', async () => {
  const onSubmit = vi.fn((event: Event) => event.preventDefault());
  mounted = await mountForm(
    <form>
      <Select name="departmentId" aria-label="Department" required>
        {departments}
      </Select>
    </form>,
  );
  const form = mounted.container.querySelector('form')!;
  form.addEventListener('submit', onSubmit);
  expect(form.checkValidity()).toBe(false);
  await choose(mounted.container, 'departmentId', 'Finance');
  expect(form.checkValidity()).toBe(true);
  await submit(mounted.container);
  expect(onSubmit).toHaveBeenCalledTimes(1);
});

it('lists inside a dialog, where the rest of the page is inert', async () => {
  mounted = await mountForm(
    <Dialog open title="Choose">
      <form>
        <Select name="kind" aria-label="Kind" defaultValue="a">
          <option value="a">Alpha</option>
          <option value="b">Beta</option>
        </Select>
      </form>
    </Dialog>,
  );
  const dialog = document.querySelector('[role="dialog"]')!;
  const trigger = dialog.querySelector('button[aria-haspopup="listbox"]') as HTMLElement;
  await act(() => Promise.resolve(trigger.click()));
  const listbox = document.querySelector('[role="listbox"]')!;
  expect(dialog.contains(listbox)).toBe(true);
});

it('starts on the first option when nothing is chosen and there is no empty option, as a native select does', async () => {
  mounted = await mountForm(
    <form>
      <Select name="currency" aria-label="Currency" required>
        <option value="NPR">Nepalese rupee</option>
        <option value="USD">US dollar</option>
      </Select>
    </form>,
  );
  expect(submitted(mounted.container)).toEqual({ currency: 'NPR' });
});

it('stays valid once a value is chosen, even while an error is shown', async () => {
  mounted = await mountForm(
    <form>
      <Field label="Department" error="Pick a department">
        {(control) => (
          <Select name="departmentId" required {...control}>
            {departments}
          </Select>
        )}
      </Field>
    </form>,
  );
  const form = mounted.container.querySelector('form')!;
  expect(form.checkValidity()).toBe(false);
  await choose(mounted.container, 'departmentId', 'Finance');
  expect(form.checkValidity()).toBe(true);
});

it('lets a plain <label for> name and focus the control through `id`', async () => {
  mounted = await mountForm(
    <form>
      <label htmlFor="status-pick">Status</label>
      <Select id="status-pick" name="status" defaultValue="">
        <option value="">All</option>
        <option value="open">Open</option>
      </Select>
    </form>,
  );
  const trigger = mounted.container.querySelector('button')!;
  expect(trigger.id).toBe('status-pick');
  expect(trigger.labels?.[0]?.textContent).toBe('Status');
});

it('keeps a controlled choice through a form reset, and does not report one', async () => {
  const onChange = vi.fn();
  function Owner() {
    const [kind, setKind] = useState('a');
    return (
      <form>
        <Select
          name="kind"
          aria-label="Kind"
          value={kind}
          onChange={(e) => {
            onChange(e.target.value);
            setKind(e.target.value);
          }}
        >
          <option value="a">Alpha</option>
          <option value="b">Beta</option>
        </Select>
      </form>
    );
  }
  mounted = await mountForm(<Owner />);
  await choose(mounted.container, 'kind', 'Beta');
  onChange.mockClear();
  const form = mounted.container.querySelector('form')!;
  await act(() => {
    form.reset();
    return new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(onChange).not.toHaveBeenCalled();
  expect(submitted(mounted.container)).toEqual({ kind: 'b' });
});

it('follows a changed defaultValue and returns to it on reset when uncontrolled', async () => {
  function Owner({ initial }: { initial: string }) {
    return (
      <form>
        <Select name="status" aria-label="Status" defaultValue={initial}>
          <option value="">All</option>
          <option value="open">Open</option>
          <option value="done">Done</option>
        </Select>
      </form>
    );
  }
  mounted = await mountForm(<Owner initial="open" />);
  await choose(mounted.container, 'status', 'Done');
  expect(submitted(mounted.container)).toEqual({ status: 'done' });
  await act(() => {
    mounted.container.querySelector('form')!.reset();
    return new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(submitted(mounted.container)).toEqual({ status: 'open' });
});

it('marks the trigger invalid for assistive technology', async () => {
  mounted = await mountForm(
    <form>
      <Field label="Department" error="Pick a department">
        {(control) => (
          <Select name="departmentId" {...control}>
            {departments}
          </Select>
        )}
      </Field>
    </form>,
  );
  expect(mounted.container.querySelector('button')!.getAttribute('aria-invalid')).toBe('true');
});
