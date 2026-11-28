// @vitest-environment jsdom
import { act, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { todayInKathmandu } from '@/app/(app)/settings/format';
import { click, mountForm, submit } from '@/test/form-interactions';

import { ID, KEY } from '../_lib/test-fixtures';

import { PromiseDialog } from './promise-dialog';

const mocks = vi.hoisted(() => ({ action: vi.fn(), refresh: vi.fn(), reload: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
// The real server action needs a session; here it records what the form posted and answers like the action does.
vi.mock('@/app/(app)/invoices/[id]/promise-actions', () => ({
  recordPromiseAction: mocks.action,
}));

const originalLocation = window.location;
let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  mocks.action.mockReset();
  mocks.refresh.mockReset();
  mocks.reload.mockReset();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...originalLocation, reload: mocks.reload },
  });
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
});

async function open(replacing: string | null = null, today = todayInKathmandu()) {
  mounted = await mountForm(
    <PromiseDialog
      invoiceId={ID}
      idempotencyKey={KEY}
      today={today}
      replacing={replacing}
      reloadHref={`/invoices/${ID}`}
    />,
  );
  const trigger = Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent === 'Record promise',
  );
  await click(trigger ?? null);
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!dialog) throw new Error('The dialog did not open');
  return dialog;
}

async function type(el: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
  await act(() => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return Promise.resolve();
  });
}

describe('PromiseDialog', () => {
  it('names the promise it replaces', async () => {
    const dialog = await open('01 Dec 2026');
    expect(dialog.textContent).toContain('This replaces the promise for 01 Dec 2026.');
  });

  it('posts the invoice, the page key and the note, and keeps the note and shows the field error on a refusal', async () => {
    mocks.action.mockImplementation((_prev: unknown, form: FormData) =>
      Promise.resolve({
        key: form.get('idempotencyKey') as string,
        errors: { promisedDate: 'Choose the date the customer promised to pay.' },
      }),
    );
    const dialog = await open();
    expect(dialog.textContent).not.toContain('This replaces');
    await type(
      dialog.querySelector<HTMLTextAreaElement>('textarea[name="note"]')!,
      'After the sale',
    );
    await submit(dialog);

    expect(mocks.action).toHaveBeenCalledTimes(1);
    const posted = mocks.action.mock.calls[0]?.[1] as FormData;
    expect(posted.get('invoiceId')).toBe(ID);
    expect(posted.get('idempotencyKey')).toBe(KEY);
    expect(posted.get('note')).toBe('After the sale');
    expect(posted.has('promisedDate')).toBe(true);
    expect(dialog.textContent).toContain('Choose the date the customer promised to pay.');
    expect(dialog.querySelector<HTMLTextAreaElement>('textarea[name="note"]')!.value).toBe(
      'After the sale',
    );
  });

  it('marks the note Optional beside its label, not inside it (UIP-FORM-008)', async () => {
    const dialog = await open();
    const note = dialog.querySelector<HTMLTextAreaElement>('textarea[name="note"]')!;
    const label = dialog.querySelector(`label[for="${note.id}"]`)!;
    expect(label.textContent).toBe('Note');
    expect(label.parentElement?.textContent).toBe('NoteOptional');
    expect(dialog.textContent).not.toContain('(optional)');
  });

  it('offers no day before today in the calendar', async () => {
    // The 15th of the current month: days 1 to 14 are before it, and the calendar opens on this month.
    const today = `${todayInKathmandu().slice(0, 8)}15`;
    const dialog = await open(null, today);
    await click(dialog.querySelector('button[aria-label="Calendar"]'));
    const cell = (day: string) =>
      Array.from(document.querySelectorAll('[role="gridcell"]')).find(
        (c) => c.textContent?.trim() === day && c.querySelector('[aria-disabled="true"]') !== null,
      );
    expect(cell('14')).toBeDefined();
    expect(cell('16')).toBeUndefined();
  });
});

describe('PromiseDialog after a success (U1-19)', () => {
  it('refreshes the page on Done, never reloads it, and starts a fresh form when the server sends a new key', async () => {
    mocks.action.mockImplementation((_prev: unknown, form: FormData) =>
      Promise.resolve({ key: form.get('idempotencyKey') as string, done: true }),
    );
    const view = (key: string) => (
      <PromiseDialog
        invoiceId={ID}
        idempotencyKey={key}
        today={todayInKathmandu()}
        replacing={null}
        reloadHref={`/invoices/${ID}`}
      />
    );
    function Harness() {
      const [key, setKey] = useState(KEY);
      return (
        <>
          <button type="button" data-testid="server-refresh" onClick={() => setKey('new-key')} />
          {view(key)}
        </>
      );
    }
    mounted = await mountForm(<Harness />);
    const trigger = () =>
      Array.from(document.querySelectorAll('button')).find(
        (b) => b.textContent === 'Record promise',
      );
    await click(trigger() ?? null);
    await submit(document.querySelector<HTMLElement>('[role="dialog"]')!);
    const done = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Done',
    );
    await click(done ?? null);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.reload).not.toHaveBeenCalled();

    // The page re-rendered on the server: a new render key arrives and the form is not stuck on "done".
    await click(document.querySelector('[data-testid="server-refresh"]'));
    await click(trigger() ?? null);
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.querySelector('form')).not.toBeNull();
    expect(dialog.querySelector<HTMLInputElement>('input[name="idempotencyKey"]')!.value).toBe(
      'new-key',
    );
  });
});
