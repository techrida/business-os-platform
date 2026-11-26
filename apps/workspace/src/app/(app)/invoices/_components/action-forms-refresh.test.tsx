// @vitest-environment jsdom
// U1-19: an invoice action dialog refreshes the page on Done instead of reloading the document, and the form is keyed
// on the invoice version, so the next action expects the new version and cannot send the old one (a 409).
import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { click, mountForm, submit } from '@/test/form-interactions';

import { ID } from '../_lib/test-fixtures';

const mocks = vi.hoisted(() => ({ action: vi.fn(), refresh: vi.fn(), reload: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/bff', () => ({ requireStaffSession: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock('@/app/(app)/invoices/[id]/actions', () => ({
  submitInvoiceAction: mocks.action,
  issueInvoiceAction: vi.fn(),
  editInvoiceDueDateAction: vi.fn(),
  reopenInvoiceAction: vi.fn(),
  discardInvoiceAction: vi.fn(),
}));

import { SubmitDialog } from './action-forms';

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
      Promise.resolve({
        key: form.get('idempotencyKey') as string,
        done: true,
        message: 'Submitted.',
      }),
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
  // The server re-renders the page after the refresh: the invoice's version goes from 3 to 4.
  const [version, setVersion] = useState(3);
  return (
    <>
      <button type="button" data-testid="server-refresh" onClick={() => setVersion(4)} />
      <SubmitDialog
        invoiceId={ID}
        version={version}
        name="Invoice"
        idempotencyKey="key-0001"
        reloadHref={`/invoices/${ID}`}
      />
    </>
  );
}

it('refreshes on Done without a reload, and the next action carries the new version', async () => {
  mounted = await mountForm(<Harness />);
  await click(button('Submit for approval'));
  expect(document.querySelector<HTMLInputElement>('input[name="expectedVersion"]')!.value).toBe(
    '3',
  );
  await submit(document.querySelector<HTMLElement>('[role="dialog"]')!);
  expect(mocks.action).toHaveBeenCalledTimes(1);
  await click(button('Done'));
  expect(mocks.refresh).toHaveBeenCalledTimes(1);
  expect(mocks.reload).not.toHaveBeenCalled();

  await click(document.querySelector('[data-testid="server-refresh"]'));
  await click(button('Submit for approval'));
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.querySelector('form')).not.toBeNull();
  expect(dialog.querySelector<HTMLInputElement>('input[name="expectedVersion"]')!.value).toBe('4');
});
