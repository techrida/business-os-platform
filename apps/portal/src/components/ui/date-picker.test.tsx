// @vitest-environment jsdom
import { act, useState } from 'react';
import { afterEach, expect, it } from 'vitest';

import { mountNode } from '@/test/number-entry';
import { DatePicker } from './date-picker';

// The portal's copy of the workspace DatePicker must behave the same; these mirror its tests.

let mounted: Awaited<ReturnType<typeof mountNode>>;
const mountForm = async (node: React.ReactNode) => (mounted = await mountNode(node));
afterEach(async () => {
  await mounted?.unmount();
  document.body.innerHTML = '';
});

async function submit(container: HTMLElement) {
  await act(() => Promise.resolve(container.querySelector('form')!.requestSubmit()));
}
// A browser types into a segment with beforeinput and clears it with Backspace keydowns.
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

it('posts nothing while a segment is cleared, and the date again once it is complete', async () => {
  await mountForm(
    <form>
      <DatePicker aria-label="Received on" name="d" defaultValue="2026-11-21" />
    </form>,
  );
  expect(posted('d')).toBe('2026-11-21');
  await clearSegment(segment('day'));
  expect(posted('d')).toBe('');
  expect(mounted.container.textContent).not.toContain(' BS');
  await typeSegment(segment('day'), '21');
  expect(posted('d')).toBe('2026-11-21');
  await clearSegment(segment('day'));
  await typeSegment(segment('day'), '25');
  expect(posted('d')).toBe('2026-11-25');
}, 15_000);

it('tells a controlled parent the date is empty while incomplete, without wiping the other segments', async () => {
  const heard: string[] = [];
  function Harness() {
    const [day, setDay] = useState('2026-11-21');
    return (
      <form>
        <DatePicker
          aria-label="Received on"
          name="d"
          value={day}
          onChange={(next) => {
            heard.push(next);
            setDay(next);
          }}
        />
      </form>
    );
  }
  await mountForm(<Harness />);
  await clearSegment(segment('day'));
  // The first Backspace leaves day 2, a complete date; the second clears the day.
  expect(heard).toEqual(['2026-11-02', '']);
  expect(posted('d')).toBe('');
  expect(segment('month').textContent).toBe('11');
  expect(segment('year').textContent).toBe('2026');
  await typeSegment(segment('day'), '21');
  // Typing 2 completes the field again as day 2, then 1 makes it 21.
  expect(heard).toEqual(['2026-11-02', '', '2026-11-02', '2026-11-21']);
  expect(posted('d')).toBe('2026-11-21');
  expect(mounted.container.textContent).toContain('05 Mangsir 2083 BS');
}, 15_000);

it('after a refused submit resets an incomplete controlled date, it shows, posts and reports empty', async () => {
  const heard: string[] = [];
  const sent: unknown[] = [];
  function Harness() {
    const [day, setDay] = useState('2026-11-21');
    return (
      <form
        noValidate
        action={(form: FormData) => {
          sent.push(form.get('d'));
        }}
      >
        <DatePicker
          aria-label="Received on"
          name="d"
          value={day}
          onChange={(next) => {
            heard.push(next);
            setDay(next);
          }}
          required
        />
      </form>
    );
  }
  await mountForm(<Harness />);
  await clearSegment(segment('day'));
  expect(posted('d')).toBe('');
  await submit(mounted.container);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(sent).toEqual(['']);
  // React Aria would refill the day from the date it held (2, after the first Backspace).
  expect(segment('day').hasAttribute('data-placeholder')).toBe(true);
  expect(posted('d')).toBe('');
  expect(heard).toEqual(['2026-11-02', '']);
  await submit(mounted.container);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(sent).toEqual(['', '']);
}, 15_000);

it('lets the browser block a required picker left incomplete in a plain form', async () => {
  await mountForm(
    <form method="get">
      <DatePicker aria-label="From" name="from" defaultValue="2026-11-21" required />
    </form>,
  );
  const form = mounted.container.querySelector('form')!;
  expect(form.checkValidity()).toBe(true);
  await clearSegment(segment('day'));
  expect(form.checkValidity()).toBe(false);
}, 15_000);

it('completes again when the held date is picked from the calendar', async () => {
  function Harness() {
    const [day, setDay] = useState('2026-11-21');
    return (
      <form>
        <DatePicker aria-label="Received on" name="d" value={day} onChange={setDay} />
      </form>
    );
  }
  await mountForm(<Harness />);
  await clearSegment(segment('day'));
  expect(posted('d')).toBe('');
  const trigger = mounted.container.querySelector<HTMLElement>('button[aria-label="Calendar"]')!;
  await act(() => Promise.resolve(trigger.click()));
  const selected = document.querySelector<HTMLElement>('[role="grid"] [data-selected]');
  expect(selected).not.toBeNull();
  await act(() => Promise.resolve(selected!.click()));
  expect(segment('day').hasAttribute('data-placeholder')).toBe(false);
  expect(posted('d')).toBe(`2026-11-${segment('day').textContent.padStart(2, '0')}`);
}, 15_000);

it('blocks a plain form while an optional date is incomplete, as a native date input does', async () => {
  await mountForm(
    <form method="get">
      <DatePicker aria-label="From" name="from" defaultValue="2026-11-21" />
    </form>,
  );
  const form = mounted.container.querySelector('form')!;
  expect(form.checkValidity()).toBe(true);
  await clearSegment(segment('day'));
  expect(form.checkValidity()).toBe(false);
  await typeSegment(segment('day'), '21');
  expect(form.checkValidity()).toBe(true);
}, 15_000);

it('blocks a plain form when only part of an empty date is typed', async () => {
  await mountForm(
    <form method="get">
      <DatePicker aria-label="From" name="from" />
    </form>,
  );
  const form = mounted.container.querySelector('form')!;
  await act(() => Promise.resolve((segment('day') as HTMLElement).focus()));
  await typeSegment(segment('day'), '21');
  expect(posted('from')).toBe('');
  expect(form.checkValidity()).toBe(false);
}, 15_000);
