// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mountForm, submit, typeKeys } from '@/test/form-interactions';
import { DatePicker } from './date-picker';
import { DateTimePicker } from './date-time-picker';
import { Field, Input } from './field';
import { useFieldSecondary } from './field-scope';
import { MoneyInput } from './number-input';
import { PanInput } from './pan-input';

// UIP-FORM-010: ONE reserved message line under each Field. These tests put each control that used to print a
// second line (its own refusal, its words, its blocker) inside a Field and count the lines.

let mounted: Awaited<ReturnType<typeof mountForm>>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Element.prototype.scrollIntoView = () => {};
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

const q = <T extends Element>(root: ParentNode, selector: string) =>
  root.querySelector<T>(selector);
const segment = (root: ParentNode, type: string) => q(root, `[data-type="${type}"]`)!;
const messageOf = (field: Element) => q<HTMLElement>(field, '[data-message]')!;

async function clearSegment(element: Element) {
  await act(() => Promise.resolve((element as HTMLElement).focus()));
  for (let i = 0; i < 4 && !element.hasAttribute('data-placeholder'); i++) {
    const event = new KeyboardEvent('keydown', {
      key: 'Backspace',
      bubbles: true,
      cancelable: true,
    });
    await act(() => Promise.resolve(element.dispatchEvent(event)));
  }
}

describe('a date picker in a Field (UnfinishedBlocker)', () => {
  it('puts "Finish the date" in the Field message line, not in a second line of its own', async () => {
    mounted = await mountForm(
      <form noValidate>
        <Field label="Due" hint="Pick a day.">
          {(control) => <DatePicker {...control} name="due" defaultValue="2026-11-21" />}
        </Field>
      </form>,
    );
    const field = q(mounted.container, 'form > div')!;
    await clearSegment(segment(field, 'day'));
    await act(() => Promise.resolve((segment(field, 'month') as HTMLElement).focus()));
    await submit(mounted.container);

    const alerts = Array.from(field.querySelectorAll('[role="alert"]'));
    expect(alerts.map((node) => node.textContent)).toEqual(['Finish the date']);
    // The one alert sits inside the field's reserved message line, which no longer shows the hint.
    expect(messageOf(field).contains(alerts[0]!)).toBe(true);
    expect(messageOf(field).textContent).toBe('Finish the date');
    // The segment is described by that line.
    const described = segment(field, 'day').getAttribute('aria-describedby')?.split(' ') ?? [];
    expect(described).toContain(messageOf(field).id);
    // Finishing the date gives the line back to the hint.
    await act(() => Promise.resolve());
    const day = segment(field, 'day');
    for (const data of '21') {
      const event = new InputEvent('beforeinput', {
        data,
        inputType: 'insertText',
        bubbles: true,
        cancelable: true,
      });
      await act(() => Promise.resolve(day.dispatchEvent(event)));
    }
    expect(field.querySelector('[role="alert"]')).toBeNull();
    expect(messageOf(field).textContent).toContain('Pick a day.');
  });

  it('two unfinished pickers in one form each show one message, in their own Field', async () => {
    mounted = await mountForm(
      <form noValidate>
        <Field label="From">
          {(control) => <DatePicker {...control} name="from" defaultValue="2026-11-01" />}
        </Field>
        <Field label="To">
          {(control) => <DatePicker {...control} name="to" defaultValue="2026-11-30" />}
        </Field>
      </form>,
    );
    const [from, to] = Array.from(mounted.container.querySelectorAll('form > div'));
    await clearSegment(segment(to!, 'day'));
    await clearSegment(segment(from!, 'day'));
    await act(() => Promise.resolve((segment(from!, 'month') as HTMLElement).focus()));
    await submit(mounted.container);

    for (const field of [from!, to!]) {
      expect(messageOf(field).textContent).toBe('Finish the date');
      expect(field.querySelectorAll('[role="alert"]')).toHaveLength(1);
    }
    // Nothing is printed outside the two message lines.
    expect(mounted.container.querySelectorAll('[role="alert"]')).toHaveLength(2);
  });

  it('a date-time picker in a Field shows one message when both its parts are unfinished', async () => {
    mounted = await mountForm(
      <form method="get" noValidate>
        <Field label="Due">
          {(control) => (
            <DateTimePicker {...control} name="dueAt" defaultValue="2026-11-21T14:30" />
          )}
        </Field>
      </form>,
    );
    const field = q(mounted.container, 'form > div')!;
    await clearSegment(segment(field, 'day'));
    await act(() => Promise.resolve((segment(field, 'hour') as HTMLElement).focus()));
    await submit(mounted.container);
    const alerts = Array.from(field.querySelectorAll('[role="alert"]'));
    // Old code: "Finish the date" and "Enter the date and time" were both printed.
    expect(alerts.map((node) => node.textContent)).toEqual(['Enter the date and time']);
    expect(messageOf(field).contains(alerts[0]!)).toBe(true);
  });
});

describe('a money input in a Field (NumberInput)', () => {
  it("puts the amount in words in the Field's message line, not under the box", async () => {
    mounted = await mountForm(
      <form>
        <Field label="Amount" hint="Including VAT.">
          {(control) => (
            <MoneyInput {...control} name="amount" currency="NPR" showWords defaultValue="1250" />
          )}
        </Field>
      </form>,
    );
    const field = q(mounted.container, 'form > div')!;
    expect(messageOf(field).textContent).toMatch(/thousand/i);
    expect(messageOf(field).textContent).toContain('Including VAT.');
    // Old code: the words were their own span under the box, a second line.
    expect(q(field, '[id$="-words"]')).toBeNull();
  });

  it("takes the Field's line for a refusal instead of printing a line of its own", async () => {
    mounted = await mountForm(
      <form>
        <Field label="Amount" hint="Including VAT.">
          {(control) => <MoneyInput {...control} name="amount" currency="NPR" />}
        </Field>
      </form>,
    );
    const field = q(mounted.container, 'form > div')!;
    const box = q<HTMLInputElement>(field, 'input:not([type="hidden"])')!;
    expect(q(field, '[data-field-override]')).toBeNull();
    await typeKeys(box, '12');
    await typeKeys(box, 'x');
    expect(q(field, '[data-field-override]')).not.toBeNull();
    // Out of flow, so it adds no height under the box.
    expect(q(field, '[role="status"]')!.className).toMatch(/statusInField/);
  });

  it('a money input outside a Field keeps its own words line', async () => {
    mounted = await mountForm(
      <form>
        <MoneyInput
          aria-label="Amount"
          name="amount"
          currency="NPR"
          showWords
          defaultValue="1250"
        />
      </form>,
    );
    expect(q(mounted.container, '[id$="-words"]')?.textContent).toMatch(/thousand/i);
    expect(q(mounted.container, '[role="status"]')!.className).not.toMatch(/statusInField/);
  });
});

describe('PanInput in a Field', () => {
  it('shows one message when a refusal and a blur error would both stand', async () => {
    mounted = await mountForm(
      <form>
        <Field label="PAN">{(control) => <PanInput {...control} name="pan" />}</Field>
      </form>,
    );
    const box = q<HTMLInputElement>(mounted.container, 'input:not([type="hidden"])')!;
    await typeKeys(box, '12345');
    await act(() => Promise.resolve(box.blur()));
    const status = q(mounted.container, '[role="status"]')!;
    expect(status.textContent).toBe('A PAN is 9 digits; this has 5.');
    await typeKeys(box, 'x');
    // Old code: the refusal and the standing error were two stacked spans.
    expect(status.children).toHaveLength(1);
    expect(status.textContent).toBe('A PAN takes digits only.');
    expect(box.value).toBe('12345');
  });
});

describe('the Field label row and the message line', () => {
  it('keeps a long label to one clipped line with its full text in the <label>', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync(resolve(process.cwd(), 'src/components/ui/field.module.css'), 'utf8');
    const rule = (selector: string) =>
      css.match(new RegExp(`(?:^|\\n)${selector}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
    // A fixed height, not only a minimum: a label that wraps cannot push its box below the next field's box.
    expect(rule('\\.labelRow')).toMatch(/(?:^|\s)height: var\(--line-height-body-small\)/);
    expect(rule('\\.label')).toContain('white-space: nowrap');
    expect(rule('\\.label')).toContain('text-overflow: ellipsis');
    expect(rule('\\.label')).toContain('overflow: hidden');
    const html = renderToStaticMarkup(
      <Field label="A label that is much too long for its column to hold on one line">
        {(control) => <Input name="x" {...control} />}
      </Field>,
    );
    expect(html).toMatch(
      /<label[^>]*>A label that is much too long for its column to hold on one line<\/label>/,
    );
  });

  it('keeps the instruction reachable through `help` when an error takes the hint line', () => {
    const html = renderToStaticMarkup(
      <Field
        label="Serial numbers"
        hint="One per line."
        help="One serial number per line, as many as units received."
        error="Enter 3 serial numbers."
      >
        {(control) => <Input name="x" {...control} />}
      </Field>,
    );
    expect(html).toContain('Enter 3 serial numbers.');
    expect(html).not.toContain('One per line.');
    expect(html).toContain('aria-label="About Serial numbers"');
    // The button sits in the label row, outside the <label>, so the control's name stays the label text.
    expect(html).toMatch(/<label[^>]*>Serial numbers<\/label>/);
  });

  it('has one secondary slot, and only the control that carries the field id may use it', async () => {
    function Stranger({ id }: { id: string | undefined }) {
      useFieldSecondary(id, 'stranger text');
      return null;
    }
    function Owner({ id }: { id: string | undefined }) {
      useFieldSecondary(id, 'owner text');
      return null;
    }
    const render = (child: (id: string) => ReactNode) =>
      mountForm(
        <Field label="Thing" hint="the hint">
          {(control) => (
            <>
              <Input {...control} name="x" />
              {child(control.id)}
            </>
          )}
        </Field>,
      );
    mounted = await render(() => <Stranger id="some-other-control" />);
    expect(messageOf(mounted.container).textContent).toBe('the hint');
    await mounted.unmount();
    mounted = await render((id) => <Owner id={id} />);
    expect(messageOf(mounted.container).textContent).toBe('owner text · the hint');
  });
});
