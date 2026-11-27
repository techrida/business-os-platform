// @vitest-environment jsdom
// U1-19: closing a quotation action dialog on success refreshes the server page; it never reloads the document.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { click, mountForm } from '@/test/form-interactions';

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

import { ActionDialog } from './action-dialog';

const reload = vi.fn();
let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;
const originalLocation = window.location;

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...originalLocation, reload },
  });
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
});

function button(text: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find((b) => b.textContent === text);
}

it('closing a done dialog refreshes the page and does not reload the document', async () => {
  mounted = await mountForm(
    <ActionDialog
      triggerLabel="Send to customer"
      title="Send"
      intro="Send it."
      formId="f"
      submitLabel="Send"
      pending={false}
      done
      refreshOnDone
    >
      <p>Sent.</p>
    </ActionDialog>,
  );
  await click(button('Send to customer') ?? null);
  expect(router.refresh).not.toHaveBeenCalled();
  await click(button('Done') ?? null);
  expect(router.refresh).toHaveBeenCalledTimes(1);
  expect(reload).not.toHaveBeenCalled();
});

it('a dialog whose form is not keyed on the record keeps the document reload', async () => {
  mounted = await mountForm(
    <ActionDialog
      triggerLabel="Match"
      title="Match"
      intro="Match it."
      formId="f"
      submitLabel="Match"
      pending={false}
      done
    >
      <p>Matched.</p>
    </ActionDialog>,
  );
  await click(button('Match') ?? null);
  await click(button('Done') ?? null);
  expect(reload).toHaveBeenCalledTimes(1);
  expect(router.refresh).not.toHaveBeenCalled();
});

it('closing a dialog that did nothing refreshes nothing', async () => {
  mounted = await mountForm(
    <ActionDialog
      triggerLabel="Send to customer"
      title="Send"
      intro="Send it."
      formId="f"
      submitLabel="Send"
      pending={false}
    >
      <p>Form.</p>
    </ActionDialog>,
  );
  await click(button('Send to customer') ?? null);
  await click(button('Cancel') ?? null);
  expect(router.refresh).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
});
