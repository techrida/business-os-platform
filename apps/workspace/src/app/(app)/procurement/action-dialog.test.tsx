// @vitest-environment jsdom
// U1-19: a purchase order or receipt action dialog refreshes the page on Done and never reloads the document; a new
// render key from the server starts a fresh form.
import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { click, mountForm, submit } from '@/test/form-interactions';

const mocks = vi.hoisted(() => ({ action: vi.fn(), refresh: vi.fn(), reload: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));

import { ProcurementActionDialog } from './action-dialog';

const originalLocation = window.location;
let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  mocks.action
    .mockReset()
    .mockImplementation((_prev: unknown, form: FormData) =>
      Promise.resolve({ key: form.get('idempotencyKey') as string, done: 'Issued.' }),
    );
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

const button = (text: string) =>
  Array.from(document.querySelectorAll('button')).find((b) => b.textContent === text) ?? null;

function Harness() {
  const [key, setKey] = useState('key-0001');
  return (
    <>
      <button type="button" data-testid="server-refresh" onClick={() => setKey('key-0002')} />
      <ProcurementActionDialog
        triggerLabel="Issue"
        title="Issue the order"
        intro="Issue it."
        action={mocks.action}
        idempotencyKey={key}
        recordField="purchaseOrderId"
        recordId="po-1"
        reloadHref="/procurement/orders/po-1"
        reloadLabel="Reload this purchase order"
        submitLabel="Issue"
        pendingWords="Issuing"
      />
    </>
  );
}

it('refreshes on Done without a reload and starts a fresh form on the next render key', async () => {
  mounted = await mountForm(<Harness />);
  await click(button('Issue'));
  await submit(document.querySelector<HTMLElement>('[role="dialog"]')!);
  await click(button('Done'));
  expect(mocks.refresh).toHaveBeenCalledTimes(1);
  expect(mocks.reload).not.toHaveBeenCalled();

  await click(document.querySelector('[data-testid="server-refresh"]'));
  await click(button('Issue'));
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.querySelector('form')).not.toBeNull();
  expect(dialog.querySelector<HTMLInputElement>('input[name="idempotencyKey"]')!.value).toBe(
    'key-0002',
  );
});
