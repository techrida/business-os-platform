// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act } from 'react';
import { afterEach, expect, it } from 'vitest';

import { Field } from '@/components/portal/field';
import { mountNode } from '@/test/number-entry';
import { DatePicker } from './date-picker';
import { MoneyInput } from './number-input';

// UIP-FORM-010: ONE reserved message line under each Field. The portal's copies of the date picker and the money
// input follow the workspace ones: what they used to print as a second line goes into the Field's message line.

let mounted: Awaited<ReturnType<typeof mountNode>>;
afterEach(async () => {
  await mounted?.unmount();
  document.body.innerHTML = '';
});

const q = <T extends Element>(root: ParentNode, selector: string) =>
  root.querySelector<T>(selector);

it('puts "Finish the date" in the Field message line, not in a second line of its own', async () => {
  mounted = await mountNode(
    <form noValidate>
      <Field label="Due" hint="Pick a day.">
        {(control) => <DatePicker {...control} name="due" defaultValue="2026-11-21" />}
      </Field>
    </form>,
  );
  const field = q(mounted.container, 'form > div')!;
  const day = q<HTMLElement>(field, '[data-type="day"]')!;
  await act(() => Promise.resolve(day.focus()));
  for (let i = 0; i < 4 && !day.hasAttribute('data-placeholder'); i++) {
    const event = new KeyboardEvent('keydown', {
      key: 'Backspace',
      bubbles: true,
      cancelable: true,
    });
    await act(() => Promise.resolve(day.dispatchEvent(event)));
  }
  await act(() => Promise.resolve(q<HTMLElement>(field, '[data-type="month"]')!.focus()));
  await act(() => Promise.resolve(q<HTMLFormElement>(mounted.container, 'form')!.requestSubmit()));
  const message = q<HTMLElement>(field, '[data-message]')!;
  const alerts = Array.from(field.querySelectorAll('[role="alert"]'));
  expect(alerts.map((node) => node.textContent)).toEqual(['Finish the date']);
  expect(message.contains(alerts[0]!)).toBe(true);
  expect(message.textContent).toBe('Finish the date');
});

it("puts the amount in words in the Field's message line, not under the box", async () => {
  mounted = await mountNode(
    <form>
      <Field label="Amount" hint="Including VAT.">
        {(control) => (
          <MoneyInput {...control} name="amount" currency="NPR" showWords defaultValue="2018180" />
        )}
      </Field>
    </form>,
  );
  const field = q(mounted.container, 'form > div')!;
  const message = q<HTMLElement>(field, '[data-message]')!;
  expect(message.textContent).toMatch(/lakh/i);
  expect(message.textContent).toContain('Including VAT.');
  // Old code: the words were their own span under the box, a second line.
  expect(q(field, '[id$="-words"]')).toBeNull();
});

it('keeps a Field label to one clipped line so a long one cannot push its box down', () => {
  const css = readFileSync(
    resolve(process.cwd(), 'src/components/portal/field.module.css'),
    'utf8',
  );
  const rule = (selector: string) =>
    css.match(new RegExp(`(?:^|\\n)${selector}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
  expect(rule('\\.labelRow')).toMatch(/(?:^|\s)height: var\(--line-height-body-small\)/);
  expect(rule('\\.label')).toContain('white-space: nowrap');
  expect(rule('\\.label')).toContain('text-overflow: ellipsis');
});
