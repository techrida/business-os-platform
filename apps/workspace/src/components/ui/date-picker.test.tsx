// @vitest-environment jsdom
import { act, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

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
  // The BS date and the caller's hint share the field's one message line (UIP-FORM-010), the date first.
  const texts = ids.map((id) => document.getElementById(id)?.textContent ?? '');
  const line = texts.find((t) => t.includes('Kathmandu date.')) ?? '';
  expect(line).toContain('05 Mangsir 2083 BS');
  expect(line.indexOf('05 Mangsir 2083 BS')).toBeLessThan(line.indexOf('Kathmandu date.'));
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
  expect(
    described.some((id) => document.getElementById(id)?.textContent?.includes('Kathmandu time.')),
  ).toBe(true);
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

it('holds a noValidate action form while a controlled date is incomplete, keeping the other segments', async () => {
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
  mounted = await mountForm(<Harness />);
  await clearSegment(segment('day'));
  expect(posted('d')).toBe('');
  await submit(mounted.container);
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Without the hold the action ran with '' and reset the form, which left every segment empty.
  expect(sent).toEqual([]);
  expect(segment('day').hasAttribute('data-placeholder')).toBe(true);
  expect(segment('month').hasAttribute('data-placeholder')).toBe(false);
  expect(segment('year').hasAttribute('data-placeholder')).toBe(false);
  expect(posted('d')).toBe('');
  expect(heard).toEqual(['2026-11-02', '']);
  await typeSegment(segment('day'), '21');
  await submit(mounted.container);
  expect(sent).toEqual(['2026-11-21']);
});

it('holds a noValidate action form while an uncontrolled date is incomplete', async () => {
  const action = vi.fn(async () => {});
  mounted = await mountForm(
    <form noValidate action={action}>
      <DatePicker aria-label="Received on" name="d" defaultValue="2026-11-21" />
    </form>,
  );
  await clearSegment(segment('day'));
  await submit(mounted.container);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(action).not.toHaveBeenCalled();
  expect(segment('day').hasAttribute('data-placeholder')).toBe(true);
  expect(segment('month').hasAttribute('data-placeholder')).toBe(false);
});

it('holds a noValidate action form when only part of an empty date is typed', async () => {
  const action = vi.fn(async () => {});
  mounted = await mountForm(
    <form noValidate action={action}>
      <DatePicker aria-label="Received on" name="d" />
    </form>,
  );
  await act(() => Promise.resolve((segment('day') as HTMLElement).focus()));
  await typeSegment(segment('day'), '21');
  await submit(mounted.container);
  expect(action).not.toHaveBeenCalled();
  expect(segment('day').textContent).toBe('21');
});

it('holds an aria-validated noValidate action form too, but does not block a plain form natively', async () => {
  const action = vi.fn(async () => {});
  mounted = await mountForm(
    <form noValidate action={action}>
      <DatePicker aria-label="From" name="from" defaultValue="2026-11-21" validation="aria" />
    </form>,
  );
  await clearSegment(segment('day'));
  await submit(mounted.container);
  expect(action).not.toHaveBeenCalled();
  expect(segment('month').hasAttribute('data-placeholder')).toBe(false);
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

it('blocks a plain form while an optional date is incomplete, as a native date input does', async () => {
  mounted = await mountForm(
    <form method="get">
      <DatePicker aria-label="From" name="from" defaultValue="2026-11-21" />
    </form>,
  );
  const form = mounted.container.querySelector('form')!;
  expect(form.checkValidity()).toBe(true);
  await clearSegment(segment('day'));
  expect(form.checkValidity()).toBe(false);
  const blocker = Array.from(form.elements).find(
    (element) => (element as HTMLInputElement).validationMessage === 'Finish the date',
  );
  expect(blocker).toBeDefined();
  await typeSegment(segment('day'), '21');
  expect(form.checkValidity()).toBe(true);
});

it('blocks a plain form when only part of an empty date is typed', async () => {
  mounted = await mountForm(
    <form method="get">
      <DatePicker aria-label="From" name="from" />
    </form>,
  );
  const form = mounted.container.querySelector('form')!;
  expect(form.checkValidity()).toBe(true);
  await act(() => Promise.resolve((segment('day') as HTMLElement).focus()));
  await typeSegment(segment('day'), '21');
  expect(posted('from')).toBe('');
  expect(form.checkValidity()).toBe(false);
});

it('never blocks an aria-validated form while the date is incomplete', async () => {
  mounted = await mountForm(
    <form action={async () => {}}>
      <DatePicker aria-label="From" name="from" defaultValue="2026-11-21" validation="aria" />
    </form>,
  );
  await clearSegment(segment('day'));
  expect(mounted.container.querySelector('form')!.checkValidity()).toBe(true);
  expect(posted('from')).toBe('');
});

it('shows "Finish the date" beside the picker when an incomplete date blocks a plain form', async () => {
  mounted = await mountForm(
    <form method="get">
      <DatePicker aria-label="From" name="from" defaultValue="2026-11-21" />
    </form>,
  );
  await clearSegment(segment('day'));
  await act(() => Promise.resolve((segment('month') as HTMLElement).focus()));
  await submit(mounted.container);
  const alerts = () =>
    Array.from(mounted.container.querySelectorAll('[role="alert"]')).filter(
      (node) => node.textContent === 'Finish the date',
    );
  expect(alerts()).toHaveLength(1);
  const message = alerts()[0]!;
  expect(message.id).not.toBe('');
  expect(message.closest('[hidden], [aria-hidden="true"]')).toBeNull();
  const focused = document.activeElement!;
  expect(focused.getAttribute('data-type')).toBe('day');
  expect(focused.hasAttribute('data-placeholder')).toBe(true);
  expect(focused.getAttribute('aria-describedby')?.split(' ')).toContain(message.id);
  const group = mounted.container.querySelector('[role="group"][aria-describedby]')!;
  expect(group.getAttribute('aria-describedby')!.split(' ')).toContain(message.id);
  // A second submit still lands on the empty segment and keeps one message.
  await act(() => Promise.resolve((segment('month') as HTMLElement).focus()));
  await submit(mounted.container);
  expect(document.activeElement).toBe(segment('day'));
  expect(alerts()).toHaveLength(1);
  await typeSegment(segment('day'), '21');
  expect(alerts()).toHaveLength(0);
  expect(mounted.container.querySelector('form')!.checkValidity()).toBe(true);
  expect(mounted.container.querySelector('[aria-invalid="true"]')).toBeNull();
  expect(mounted.container.querySelector(`[aria-describedby~="${message.id}"]`)).toBeNull();
});

it('holds the submit of a noValidate action form while a date is partly typed, keeps the segments and shows "Finish the date"', async () => {
  const action = vi.fn(async () => {});
  const onSubmit = vi.fn();
  mounted = await mountForm(
    <form action={action} onSubmit={onSubmit} noValidate>
      <DatePicker aria-label="Needed by" name="neededBy" defaultValue="2027-12-15" />
    </form>,
  );
  await clearSegment(segment('day'));
  await act(() => Promise.resolve((segment('month') as HTMLElement).focus()));
  await submit(mounted.container);

  // The browser is never asked to validate a noValidate form, so without the hold the form went to its action with ''
  // and was reset, which left every segment empty and the generic server message.
  expect(action).not.toHaveBeenCalled();
  expect(onSubmit).not.toHaveBeenCalled();
  const alerts = Array.from(mounted.container.querySelectorAll('[role="alert"]')).filter(
    (node) => node.textContent === 'Finish the date',
  );
  expect(alerts).toHaveLength(1);
  expect(document.activeElement).toBe(segment('day'));
  expect(segment('day').hasAttribute('data-placeholder')).toBe(true);
  expect(segment('month').hasAttribute('data-placeholder')).toBe(false);
  expect(segment('year').hasAttribute('data-placeholder')).toBe(false);

  // Finishing the date lets the form through again.
  await typeSegment(segment('day'), '15');
  await submit(mounted.container);
  expect(action).toHaveBeenCalledTimes(1);
});

it('focuses the first date segment when its Field label is clicked', async () => {
  mounted = await mountForm(
    <Field label="Due">
      {(control) => <DatePicker {...control} name="due" defaultValue="2026-11-21" />}
    </Field>,
  );
  const label = mounted.container.querySelector('label')!;
  const first = mounted.container.querySelector('[role="spinbutton"]');
  expect(first).not.toBeNull();
  // Old code: the label's `for` names React Aria's group, a div, so the click focused nothing.
  await click(label);
  expect(document.activeElement).toBe(first);
});

it('leaves the focus alone on a label click while the picker is disabled', async () => {
  mounted = await mountForm(
    <Field label="Due">
      {(control) => <DatePicker {...control} name="due" defaultValue="2026-11-21" disabled />}
    </Field>,
  );
  await click(mounted.container.querySelector('label'));
  expect(document.activeElement).toBe(document.body);
});

it('DateTimePicker focuses its first date segment when its Field label is clicked', async () => {
  mounted = await mountForm(
    <Field label="Due">
      {(control) => <DateTimePicker {...control} name="dueAt" defaultValue="2026-11-21T09:30" />}
    </Field>,
  );
  const first = mounted.container.querySelector('[role="spinbutton"]');
  expect(first).not.toBeNull();
  await click(mounted.container.querySelector('label'));
  expect(document.activeElement).toBe(first);
});
