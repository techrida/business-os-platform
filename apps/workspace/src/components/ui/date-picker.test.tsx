// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { click, mountForm, submit } from '@/test/form-interactions';
import { DatePicker } from './date-picker';
import { Dialog } from './dialog';

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
