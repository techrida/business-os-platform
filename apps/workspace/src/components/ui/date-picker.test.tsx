// @vitest-environment jsdom
import { act, useState } from 'react';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { click, mountForm, settle, submit } from '@/test/form-interactions';
import { DatePicker } from './date-picker';
import { DateTimePicker } from './date-time-picker';
import { Dialog } from './dialog';
import { Field } from './field';

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

it('portals its calendar into an enclosing Dialog automatically via PopoverContainerContext', async () => {
  mounted = await mountForm(
    <Dialog open title="Schedule">
      <DatePicker aria-label="Due date" defaultValue="2026-11-20" />
    </Dialog>,
  );
  const dialog = document.querySelector('[role="dialog"]')!;
  const trigger = dialog.querySelector('button[aria-label="Calendar"]')!;
  await click(trigger);
  const grid = document.querySelector('[role="grid"]')!;
  expect(grid).not.toBeNull();
  expect(dialog.contains(grid)).toBe(true);
});

it('shows the Nepali (BS) date under the field and describes the field with it', async () => {
  mounted = await mountForm(
    <DatePicker aria-label="Due date" name="due" defaultValue="2026-11-21" />,
  );
  const bs = Array.from(mounted.container.querySelectorAll('span')).find((node) =>
    node.textContent?.endsWith(' BS'),
  )!;
  expect(bs).toBeDefined();
  // 2026-11-21 is 5 Mangsir 2083.
  expect(bs.textContent).toBe('05 Mangsir 2083 BS');
  const group = mounted.container.querySelector('[aria-describedby]')!;
  expect(group.getAttribute('aria-describedby')).toContain(bs.id);
  expect(mounted.container.querySelector('input[name="due"]')!.getAttribute('value')).toBe(
    '2026-11-21',
  );
});

it('keeps the caller hint ahead of the BS line in aria-describedby', async () => {
  mounted = await mountForm(
    <Field label="Due" hint="Kathmandu date.">
      {(control) => <DatePicker {...control} name="due" defaultValue="2026-11-21" />}
    </Field>,
  );
  const group = mounted.container.querySelector('[aria-describedby]')!;
  const ids = group.getAttribute('aria-describedby')!.split(' ');
  // React Aria adds its own description id; the caller's hint and the BS line must both be there.
  const texts = ids.map((id) => document.getElementById(id)?.textContent);
  expect(texts).toContain('Kathmandu date.');
  expect(texts).toContain('05 Mangsir 2083 BS');
  expect(texts.indexOf('Kathmandu date.')).toBeLessThan(texts.indexOf('05 Mangsir 2083 BS'));
});

it('shows no BS line for an empty date or when asked not to', async () => {
  mounted = await mountForm(<DatePicker aria-label="Due date" name="due" />);
  expect(mounted.container.textContent).not.toContain(' BS');
  await mounted.unmount();
  mounted = await mountForm(
    <DatePicker aria-label="Due date" name="due" defaultValue="2026-11-21" showBs={false} />,
  );
  expect(mounted.container.textContent).not.toContain(' BS');
});

it('DateTimePicker posts YYYY-MM-DDTHH:mm like a native datetime-local and shows the BS date', async () => {
  mounted = await mountForm(
    <form>
      <DateTimePicker name="dueAt" aria-label="Due" defaultValue="2026-11-21T14:30" />
    </form>,
  );
  const hidden = mounted.container.querySelector<HTMLInputElement>(
    'input[type="hidden"][name="dueAt"]',
  )!;
  expect(hidden.value).toBe('2026-11-21T14:30');
  expect(mounted.container.textContent).toContain('05 Mangsir 2083 BS');
  expect(mounted.container.querySelector('input[type="datetime-local"]')).toBeNull();
});

it('DateTimePicker names its time field by the field label plus Time and shares the hint', async () => {
  mounted = await mountForm(
    <Field label="New due time" hint="Kathmandu time.">
      {(control) => <DateTimePicker {...control} name="dueAt" defaultValue="2026-11-21T14:30" />}
    </Field>,
  );
  const time = Array.from(mounted.container.querySelectorAll('[role="group"]')).find((group) =>
    group.querySelector('[data-type="hour"]'),
  )!;
  const labelledBy = time.getAttribute('aria-labelledby')!.split(' ');
  expect(labelledBy.map((id) => document.getElementById(id)?.textContent)).toEqual([
    'New due time',
    'Time',
  ]);
  const described = time.getAttribute('aria-describedby')!.split(' ');
  expect(described.map((id) => document.getElementById(id)?.textContent)).toContain(
    'Kathmandu time.',
  );
});

it('a form reset after an action does not wipe a controlled DatePicker', async () => {
  function Harness() {
    const [day, setDay] = useState('2026-11-21');
    return <DatePicker aria-label="Valid until" name="validUntil" value={day} onChange={setDay} />;
  }
  mounted = await mountForm(
    <form>
      <Harness />
    </form>,
  );
  await act(() => Promise.resolve(mounted.container.querySelector('form')!.reset()));
  await settle();
  expect(mounted.container.querySelector('input[name="validUntil"]')!.getAttribute('value')).toBe(
    '2026-11-21',
  );
  expect(mounted.container.textContent).toContain('05 Mangsir 2083 BS');
});

it('DateTimePicker posts nothing until both the day and the time are set', async () => {
  mounted = await mountForm(
    <form>
      <DateTimePicker name="dueAt" aria-label="Due" defaultValue="2026-11-21" />
    </form>,
  );
  const hidden = mounted.container.querySelector<HTMLInputElement>(
    'input[type="hidden"][name="dueAt"]',
  )!;
  expect(hidden.value).toBe('');
});

it('keeps a controlled date after the form action resets the form', async () => {
  function Form() {
    const [date, setDate] = useState('2026-12-01');
    return (
      <form action={async () => {}}>
        <DatePicker aria-label="Needed by" name="d" value={date} onChange={setDate} />
        <button type="button" onClick={() => setDate('2026-12-05')}>
          pick
        </button>
      </form>
    );
  }
  mounted = await mountForm(<Form />);
  await click(mounted.container.querySelector('button:not([aria-label])'));
  await submit(mounted.container);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect((mounted.container.querySelector('input[name="d"]') as HTMLInputElement).value).toBe(
    '2026-12-05',
  );
});

it('lets the browser block an empty required picker in a plain form, unless the form opts into aria validation', async () => {
  mounted = await mountForm(
    <>
      <form id="filter" method="get">
        <DatePicker aria-label="From" name="from" required />
      </form>
      <form id="action" action={async () => {}}>
        <DatePicker aria-label="Until" name="until" required validation="aria" />
      </form>
    </>,
  );
  const filter = document.querySelector<HTMLFormElement>('#filter')!;
  const action = document.querySelector<HTMLFormElement>('#action')!;
  expect(filter.checkValidity()).toBe(false);
  expect(action.checkValidity()).toBe(true);
});

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
  mounted = await mountForm(
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
});

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
  mounted = await mountForm(<Harness />);
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
});

it('after the form action resets an incomplete controlled date, it posts the date it shows', async () => {
  function Harness() {
    const [day, setDay] = useState('2026-11-21');
    return (
      <form action={async () => {}}>
        <DatePicker
          aria-label="Received on"
          name="d"
          value={day}
          onChange={setDay}
          validation="aria"
        />
      </form>
    );
  }
  mounted = await mountForm(<Harness />);
  await clearSegment(segment('day'));
  expect(posted('d')).toBe('');
  await submit(mounted.container);
  await new Promise((resolve) => setTimeout(resolve, 10));
  // React Aria refills the segments from the date it holds on a reset; what posts must match.
  const day = segment('day');
  expect(day.hasAttribute('data-placeholder')).toBe(false);
  expect(posted('d')).toBe(`2026-11-${day.textContent.padStart(2, '0')}`);
  expect(segment('month').textContent).toBe('11');
});

it('lets the browser block a required picker left incomplete in a plain form', async () => {
  mounted = await mountForm(
    <form method="get">
      <DatePicker aria-label="From" name="from" defaultValue="2026-11-21" required />
    </form>,
  );
  const form = mounted.container.querySelector('form')!;
  expect(form.checkValidity()).toBe(true);
  await clearSegment(segment('day'));
  expect(form.checkValidity()).toBe(false);
});

it('DateTimePicker posts nothing while its day is incomplete', async () => {
  mounted = await mountForm(
    <form>
      <DateTimePicker name="dueAt" aria-label="Due" defaultValue="2026-11-21T14:30" />
    </form>,
  );
  expect(posted('dueAt')).toBe('2026-11-21T14:30');
  await clearSegment(segment('day'));
  expect(posted('dueAt')).toBe('');
  expect(segment('month').textContent).toBe('11');
  await typeSegment(segment('day'), '21');
  expect(posted('dueAt')).toBe('2026-11-21T14:30');
});

it('completes again when the held date is picked from the calendar', async () => {
  function Harness() {
    const [day, setDay] = useState('2026-11-21');
    return (
      <form>
        <DatePicker aria-label="Received on" name="d" value={day} onChange={setDay} />
      </form>
    );
  }
  mounted = await mountForm(<Harness />);
  await clearSegment(segment('day'));
  expect(posted('d')).toBe('');
  const trigger = mounted.container.querySelector<HTMLElement>('button[aria-label="Calendar"]')!;
  await act(() => Promise.resolve(trigger.click()));
  const selected = document.querySelector<HTMLElement>('[role="grid"] [data-selected]');
  expect(selected).not.toBeNull();
  await act(() => Promise.resolve(selected!.click()));
  expect(segment('day').hasAttribute('data-placeholder')).toBe(false);
  expect(posted('d')).toBe(`2026-11-${segment('day').textContent.padStart(2, '0')}`);
});
