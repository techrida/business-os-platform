// @vitest-environment jsdom
import { act, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { click, mountForm as mountRaw, submit } from '@/test/form-interactions';

import { Checkbox, Radio, RadioGroup } from './checkbox';

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

let views: { unmount(): Promise<void> }[] = [];
async function mountForm(node: React.ReactNode) {
  const view = await mountRaw(node);
  views.push(view);
  return view;
}
afterEach(async () => {
  for (const view of views) await view.unmount();
  views = [];
});

async function key(el: Element, k: string) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    // Radix moves focus (and so the selection) on a timer, while the key is still down.
    await new Promise((resolve) => setTimeout(resolve, 0));
    document.dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true }));
  });
}

it('toggles with a click on its label and on Space, and reports the boolean', async () => {
  const seen: boolean[] = [];
  function Harness() {
    const [on, setOn] = useState(false);
    return (
      <label>
        <Checkbox
          checked={on}
          onCheckedChange={(next) => {
            seen.push(next);
            setOn(next);
          }}
        />
        Remember me
      </label>
    );
  }
  const { container } = await mountForm(<Harness />);
  const box = container.querySelector<HTMLElement>('[role="checkbox"]')!;
  expect(box.getAttribute('aria-checked')).toBe('false');
  await click(container.querySelector('label'));
  expect(box.getAttribute('aria-checked')).toBe('true');
  await act(() => Promise.resolve(box.focus()));
  await act(() => Promise.resolve(box.click()));
  expect(seen).toEqual([true, false]);
  // The label gives it its accessible name.
  expect(box.closest('label')?.textContent).toBe('Remember me');
});

it('submits its name and value in a form only while ticked', async () => {
  const { container } = await mountForm(
    <form>
      <label>
        <Checkbox name="confirmed" value="yes" />
        Confirm
      </label>
    </form>,
  );
  const form = container.querySelector('form')!;
  expect(new FormData(form).get('confirmed')).toBeNull();
  await click(container.querySelector('[role="checkbox"]'));
  expect(new FormData(form).get('confirmed')).toBe('yes');
  await submit(container);
});

it('shows the indeterminate state with aria-checked="mixed" and a dash', async () => {
  const { container } = await mountForm(<Checkbox checked="indeterminate" aria-label="All" />);
  const box = container.querySelector<HTMLElement>('[role="checkbox"]')!;
  expect(box.getAttribute('aria-checked')).toBe('mixed');
  expect(box.getAttribute('data-state')).toBe('indeterminate');
  expect(box.querySelector('path')?.getAttribute('d')).toBe('M2.5 6h7');
});

it('a disabled checkbox cannot be toggled', async () => {
  const onChange = vi.fn();
  const { container } = await mountForm(
    <Checkbox disabled aria-label="Locked" onCheckedChange={onChange} />,
  );
  const box = container.querySelector<HTMLButtonElement>('[role="checkbox"]')!;
  expect(box.disabled).toBe(true);
  await click(box);
  expect(onChange).not.toHaveBeenCalled();
});

it('a checkbox with a disabled reason stays focusable, does not toggle, and explains itself on focus', async () => {
  const onChange = vi.fn();
  const { container } = await mountForm(
    <Checkbox
      aria-label="NPR"
      disabledReason="The base currency is always on"
      onCheckedChange={onChange}
    />,
  );
  const box = container.querySelector<HTMLButtonElement>('[role="checkbox"]')!;
  expect(box.disabled).toBe(false);
  expect(box.getAttribute('aria-disabled')).toBe('true');
  await click(box);
  expect(onChange).not.toHaveBeenCalled();
  expect(box.getAttribute('aria-checked')).toBe('false');
  await act(async () => {
    box.focus();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(document.body.querySelector('[role="tooltip"]')?.textContent).toContain(
    'The base currency is always on',
  );
});

function Choices({ onValue }: { onValue?: (v: string) => void }) {
  return (
    <form>
      <RadioGroup name="mode" defaultValue="a" aria-label="Mode" onValueChange={onValue}>
        <label>
          <Radio value="a" />
          Alpha
        </label>
        <label>
          <Radio value="b" />
          Beta
        </label>
        <label>
          <Radio value="c" disabled />
          Gamma
        </label>
      </RadioGroup>
    </form>
  );
}

it('radios select one at a time, by click and by arrow keys, and submit the chosen value', async () => {
  const onValue = vi.fn();
  const { container } = await mountForm(<Choices onValue={onValue} />);
  const radios = [...container.querySelectorAll<HTMLElement>('[role="radio"]')];
  const form = container.querySelector('form')!;
  expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
  expect(new FormData(form).get('mode')).toBe('a');
  await click(radios[1]!);
  expect(onValue).toHaveBeenLastCalledWith('b');
  expect(new FormData(form).get('mode')).toBe('b');
  await act(() => Promise.resolve(radios[1]!.focus()));
  await key(radios[1]!, 'ArrowUp');
  expect(document.activeElement).toBe(radios[0]);
  expect(radios[0]!.getAttribute('aria-checked')).toBe('true');
  // A disabled radio is skipped.
  await key(radios[0]!, 'ArrowDown');
  await key(document.activeElement!, 'ArrowDown');
  expect(radios[2]!.getAttribute('aria-checked')).toBe('false');
});

it('a radio with a disabled reason stays focusable and is not selected by a click', async () => {
  const { container } = await mountForm(
    <RadioGroup defaultValue="a" aria-label="Mode">
      <Radio value="a" aria-label="A" />
      <Radio value="b" aria-label="B" disabledReason="Not available yet" />
    </RadioGroup>,
  );
  const b = container.querySelectorAll<HTMLElement>('[role="radio"]')[1]!;
  expect(b.getAttribute('aria-disabled')).toBe('true');
  await click(b);
  expect(b.getAttribute('aria-checked')).toBe('false');
});

it('a controlled checkbox keeps its state when the form resets (React resets a form after each action)', async () => {
  function Harness() {
    const [on, setOn] = useState(false);
    return (
      <form>
        <Checkbox aria-label="Opt in" name="optIn" checked={on} onCheckedChange={setOn} />
      </form>
    );
  }
  const { container } = await mountForm(<Harness />);
  const box = container.querySelector<HTMLElement>('[role="checkbox"]')!;
  await click(box);
  expect(box.getAttribute('aria-checked')).toBe('true');
  await act(() => Promise.resolve(container.querySelector('form')!.reset()));
  expect(box.getAttribute('aria-checked')).toBe('true');
});

it('an uncontrolled checkbox returns to its default on reset, like a native one', async () => {
  const { container } = await mountForm(
    <form>
      <Checkbox aria-label="Subscribe" name="subscribe" defaultChecked />
    </form>,
  );
  const box = container.querySelector<HTMLElement>('[role="checkbox"]')!;
  await click(box);
  expect(box.getAttribute('aria-checked')).toBe('false');
  await act(() => Promise.resolve(container.querySelector('form')!.reset()));
  expect(box.getAttribute('aria-checked')).toBe('true');
});

it('a controlled radio group keeps its choice when the form resets', async () => {
  function Harness() {
    const [value, setValue] = useState('a');
    return (
      <form>
        <RadioGroup name="mode" value={value} onValueChange={setValue} aria-label="Mode">
          <Radio value="a" aria-label="A" />
          <Radio value="b" aria-label="B" />
        </RadioGroup>
      </form>
    );
  }
  const { container } = await mountForm(<Harness />);
  const radios = [...container.querySelectorAll<HTMLElement>('[role="radio"]')];
  await click(radios[1]!);
  expect(radios[1]!.getAttribute('aria-checked')).toBe('true');
  await act(() => Promise.resolve(container.querySelector('form')!.reset()));
  expect(radios[1]!.getAttribute('aria-checked')).toBe('true');
  expect(radios[0]!.getAttribute('aria-checked')).toBe('false');
});

it('posts what the screen shows after a form reset (React resets a form after each action)', async () => {
  function Harness() {
    const [on, setOn] = useState(false);
    const [mode, setMode] = useState('a');
    return (
      <form>
        <Checkbox
          aria-label="Opt in"
          name="optIn"
          value="yes"
          checked={on}
          onCheckedChange={setOn}
        />
        <RadioGroup name="mode" value={mode} onValueChange={setMode} aria-label="Mode">
          <Radio value="a" aria-label="A" />
          <Radio value="b" aria-label="B" />
        </RadioGroup>
        <Checkbox aria-label="Subscribe" name="subscribe" defaultChecked />
      </form>
    );
  }
  const { container } = await mountForm(<Harness />);
  const form = container.querySelector('form')!;
  await click(container.querySelector('[aria-label="Opt in"]'));
  await click(container.querySelector('[aria-label="B"]'));
  await click(container.querySelector('[aria-label="Subscribe"]'));
  expect(Object.fromEntries(new FormData(form))).toEqual({ optIn: 'yes', mode: 'b' });
  await act(() => Promise.resolve(form.reset()));
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
  // The controlled ones kept the parent's state and post it, not their first-render values; the
  // uncontrolled box went back to its default (ticked), like a native one.
  expect(Object.fromEntries(new FormData(form))).toEqual({
    optIn: 'yes',
    mode: 'b',
    subscribe: 'on',
  });
});
