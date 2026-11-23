// @vitest-environment jsdom
import { act, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { mountForm, submit } from '@/test/form-interactions';
import { DateTimePicker } from './date-time-picker';

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

async function typeSegment(segment: Element, text: string) {
  for (const data of text) {
    const event = new InputEvent('beforeinput', {
      data,
      inputType: 'insertText',
      bubbles: true,
      cancelable: true,
    });
    await act(() => Promise.resolve(segment.dispatchEvent(event)));
  }
}

async function clearSegment(segment: Element) {
  await act(() => Promise.resolve((segment as HTMLElement).focus()));
  for (let i = 0; i < 4 && !segment.hasAttribute('data-placeholder'); i++) {
    const event = new KeyboardEvent('keydown', {
      key: 'Backspace',
      bubbles: true,
      cancelable: true,
    });
    await act(() => Promise.resolve(segment.dispatchEvent(event)));
  }
  expect(segment.hasAttribute('data-placeholder')).toBe(true);
}

const segment = (type: string) => mounted.container.querySelector(`[data-type="${type}"]`)!;
const posted = (name: string) => new FormData(mounted.container.querySelector('form')!).get(name);

it('holds a noValidate action form while the day of a controlled picker is cleared, and keeps the typed time', async () => {
  const sent: unknown[] = [];
  function Harness() {
    const [value, setValue] = useState('2026-11-21T14:30');
    return (
      <form
        noValidate
        action={(form: FormData) => {
          sent.push(form.get('deadline'));
        }}
      >
        <DateTimePicker
          aria-label="Deadline"
          name="deadline"
          value={value}
          onChange={setValue}
          required
        />
      </form>
    );
  }
  mounted = await mountForm(<Harness />);
  await clearSegment(segment('day'));
  expect(posted('deadline')).toBe('');
  await submit(mounted.container);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(sent).toEqual([]);
  expect(segment('hour').textContent).toBe('2');
  expect(segment('minute').textContent).toBe('30');
  expect(segment('day').hasAttribute('data-placeholder')).toBe(true);
  expect(segment('month').hasAttribute('data-placeholder')).toBe(false);
  expect(document.activeElement).toBe(segment('day'));
  await typeSegment(segment('day'), '22');
  expect(posted('deadline')).toBe('2026-11-22T14:30');
  await submit(mounted.container);
  expect(sent).toEqual(['2026-11-22T14:30']);
});

it('holds a noValidate action form while the day of an uncontrolled picker is cleared', async () => {
  const action = vi.fn(async () => {});
  mounted = await mountForm(
    <form noValidate action={action}>
      <DateTimePicker aria-label="Due" name="dueAt" defaultValue="2026-11-21T14:30" />
    </form>,
  );
  await clearSegment(segment('day'));
  await submit(mounted.container);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(action).not.toHaveBeenCalled();
  expect(segment('day').hasAttribute('data-placeholder')).toBe(true);
  expect(segment('month').textContent).not.toBe('mm');
});

it('blocks a plain form while a required picker lacks its day or its time', async () => {
  mounted = await mountForm(
    <form method="get">
      <DateTimePicker aria-label="Due" name="dueAt" defaultValue="2026-11-21T14:30" required />
    </form>,
  );
  const form = mounted.container.querySelector('form')!;
  expect(form.checkValidity()).toBe(true);
  await clearSegment(segment('hour'));
  expect(posted('dueAt')).toBe('');
  expect(form.checkValidity()).toBe(false);
  // The hour segment is 12-hour and keeps PM.
  await typeSegment(segment('hour'), '2');
  expect(posted('dueAt')).toBe('2026-11-21T14:30');
  expect(form.checkValidity()).toBe(true);
});

it('blocks a plain form when an optional picker has a day but no time', async () => {
  mounted = await mountForm(
    <form method="get">
      <DateTimePicker aria-label="Due" name="dueAt" defaultValue="2026-11-21T14:30" />
    </form>,
  );
  const form = mounted.container.querySelector('form')!;
  expect(form.checkValidity()).toBe(true);
  await clearSegment(segment('hour'));
  expect(form.checkValidity()).toBe(false);
});

it('tells a controlled parent the value is empty while the time is incomplete, and keeps the day', async () => {
  const heard: string[] = [];
  function Harness() {
    const [value, setValue] = useState('2026-11-21T14:30');
    return (
      <form>
        <DateTimePicker
          aria-label="Due"
          name="dueAt"
          value={value}
          onChange={(next) => {
            heard.push(next);
            setValue(next);
          }}
        />
      </form>
    );
  }
  mounted = await mountForm(<Harness />);
  await clearSegment(segment('hour'));
  expect(heard).toEqual(['']);
  expect(posted('dueAt')).toBe('');
  expect(segment('day').textContent).toBe('21');
  expect(segment('minute').textContent).toBe('30');
  await typeSegment(segment('hour'), '2');
  expect(heard).toEqual(['', '2026-11-21T14:30']);
  expect(posted('dueAt')).toBe('2026-11-21T14:30');
});

it('holds a noValidate action form while the time of a controlled picker is cleared', async () => {
  const heard: string[] = [];
  const sent: unknown[] = [];
  function Harness() {
    const [value, setValue] = useState('2026-11-21T14:30');
    return (
      <form
        noValidate
        action={(form: FormData) => {
          sent.push(form.get('deadline'));
        }}
      >
        <DateTimePicker
          aria-label="Deadline"
          name="deadline"
          value={value}
          onChange={(next) => {
            heard.push(next);
            setValue(next);
          }}
          required
        />
      </form>
    );
  }
  mounted = await mountForm(<Harness />);
  await clearSegment(segment('hour'));
  await submit(mounted.container);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(sent).toEqual([]);
  expect(posted('deadline')).toBe('');
  expect(heard).toEqual(['']);
  expect(segment('hour').hasAttribute('data-placeholder')).toBe(true);
  expect(segment('day').textContent).toBe('21');
  expect(segment('minute').textContent).toBe('30');
  await typeSegment(segment('hour'), '2');
  await submit(mounted.container);
  expect(sent).toEqual(['2026-11-21T14:30']);
});

it('holds a noValidate action form while the time of an uncontrolled picker is cleared', async () => {
  const action = vi.fn(async () => {});
  mounted = await mountForm(
    <form noValidate action={action}>
      <DateTimePicker aria-label="Due" name="dueAt" defaultValue="2026-11-21T14:30" />
    </form>,
  );
  await clearSegment(segment('hour'));
  expect(posted('dueAt')).toBe('');
  await submit(mounted.container);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(action).not.toHaveBeenCalled();
  expect(segment('hour').hasAttribute('data-placeholder')).toBe(true);
  expect(segment('minute').textContent).toBe('30');
});

it('shows "Enter the date and time" when a required, empty picker blocks a plain form', async () => {
  mounted = await mountForm(
    <form method="get">
      <DateTimePicker aria-label="Due" name="dueAt" required />
    </form>,
  );
  await submit(mounted.container);
  const alerts = () =>
    Array.from(mounted.container.querySelectorAll('[role="alert"]')).filter(
      (node) => node.textContent === 'Enter the date and time',
    );
  expect(alerts()).toHaveLength(1);
  const message = alerts()[0]!;
  expect(message.closest('[hidden], [aria-hidden="true"]')).toBeNull();
  const focused = document.activeElement!;
  expect(focused.hasAttribute('data-placeholder')).toBe(true);
  expect(focused.getAttribute('aria-describedby')?.split(' ')).toContain(message.id);
  // The time field shares the message.
  expect(segment('hour').getAttribute('aria-describedby')?.split(' ')).toContain(message.id);
  await typeSegment(segment('day'), '21');
  await typeSegment(segment('month'), '11');
  await typeSegment(segment('year'), '2026');
  expect(alerts()).toHaveLength(1);
  await typeSegment(segment('hour'), '2');
  await typeSegment(segment('minute'), '30');
  await typeSegment(segment('dayPeriod'), 'P');
  expect(posted('dueAt')).not.toBe('');
  expect(alerts()).toHaveLength(0);
  expect(mounted.container.querySelector(`[aria-describedby~="${message.id}"]`)).toBeNull();
});

it('describes the cleared day with both messages when it blocks a plain form, and drops both once it is typed', async () => {
  mounted = await mountForm(
    <form method="get">
      <DateTimePicker aria-label="Due" name="dueAt" defaultValue="2026-11-21T14:30" />
    </form>,
  );
  await clearSegment(segment('day'));
  await act(() => Promise.resolve((segment('hour') as HTMLElement).focus()));
  await submit(mounted.container);
  const alerts = () => Array.from(mounted.container.querySelectorAll('[role="alert"]'));
  expect(alerts().map((node) => node.textContent)).toEqual([
    'Finish the date',
    'Enter the date and time',
  ]);
  expect(document.activeElement).toBe(segment('day'));
  const described = segment('day').getAttribute('aria-describedby')?.split(' ') ?? [];
  for (const node of alerts()) expect(described).toContain(node.id);
  await typeSegment(segment('day'), '21');
  expect(posted('dueAt')).toBe('2026-11-21T14:30');
  expect(alerts()).toHaveLength(0);
  expect(mounted.container.querySelector('form')!.checkValidity()).toBe(true);
  expect(mounted.container.querySelector('[aria-invalid="true"]')).toBeNull();
});
