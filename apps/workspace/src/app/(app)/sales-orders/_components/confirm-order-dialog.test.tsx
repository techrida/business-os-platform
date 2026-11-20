// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { click, mountForm } from '@/test/form-interactions';

import type { ActionState } from '../_lib/state';

const mocks = vi.hoisted(() => ({
  confirmOrderAction: vi.fn(),
  overrideCreditHoldAction: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../_lib/actions', () => ({ confirmOrderAction: mocks.confirmOrderAction }));
vi.mock('@/app/(app)/opportunities/actions', () => ({
  overrideCreditHoldAction: mocks.overrideCreditHoldAction,
}));
vi.mock('@/components/ui/toast', () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const { ConfirmOrderDialog } = await import('./confirm-order-dialog');

const KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEAL = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function confirmWith(answer: ActionState) {
  mocks.confirmOrderAction.mockResolvedValue(answer);
  const mounted = await mountForm(
    <ConfirmOrderDialog
      options={[{ versionId: '22222222-2222-4222-8222-222222222222', label: 'QT-1 · Acme' }]}
      idempotencyKey={KEY}
      reloadHref="/sales-orders"
    />,
  );
  await click(mounted.container.querySelector('button'));
  const form = document.querySelector('[role="dialog"] form');
  await act(() => Promise.resolve((form as HTMLFormElement | null)?.requestSubmit()));
  for (let i = 0; i < 4; i += 1) await act(() => Promise.resolve());
  return mounted;
}

const dialogLinks = () =>
  [...(document.querySelector('[role="dialog"]')?.querySelectorAll('a') ?? [])].map((a) => [
    a.textContent,
    a.getAttribute('href'),
  ]);

const HELD = 'This customer is over its credit limit, so the sales order is on hold.';
const OVERRIDE = 'Override credit hold';
const buttonNamed = (label: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === label) ?? null;
const dialogs = () => [...document.querySelectorAll('[role="dialog"]')];

it('lets a credit.override holder who cannot open the deal override it in place (F1-Q20)', async () => {
  const mounted = await confirmWith({
    key: KEY,
    error: HELD,
    creditHold: { opportunityId: DEAL, number: null, canOpen: false, canOverride: true },
  });
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('over its credit limit');
  // No link to a deal this person would get a 404 on.
  expect(dialogLinks().map(([, href]) => href)).not.toContain(`/opportunities/${DEAL}`);

  mocks.overrideCreditHoldAction.mockResolvedValue({ ok: true });
  await click(buttonNamed(OVERRIDE));
  expect(dialogs()).toHaveLength(2);
  const override = dialogs().at(-1)!;
  expect(override.textContent).toContain('The opportunity can then be confirmed');
  const reason = override.querySelector('textarea')!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
    reason,
    'Cheque received today.',
  );
  await act(() => Promise.resolve(reason.dispatchEvent(new Event('input', { bubbles: true }))));
  await click(
    [...override.querySelectorAll('button')].find((b) => b.textContent === 'Override hold') ?? null,
  );
  for (let i = 0; i < 4; i += 1) await act(() => Promise.resolve());

  expect(mocks.overrideCreditHoldAction).toHaveBeenCalledOnce();
  const sent = mocks.overrideCreditHoldAction.mock.calls[0]?.[1] as FormData;
  expect(sent.get('opportunityId')).toBe(DEAL);
  expect(sent.get('reason')).toBe('Cheque received today.');
  // Overriding is its own form: it never re-sends the confirm.
  expect(mocks.confirmOrderAction).toHaveBeenCalledOnce();
  expect(mocks.success).toHaveBeenCalledWith('Credit hold overridden. Confirm the order again.');
  expect(document.querySelector('[role="dialog"] [role="status"]')?.textContent).toContain(
    'Credit hold overridden',
  );
  expect(buttonNamed(OVERRIDE)).toBeNull();
  await mounted.unmount();
});

it('links to the deal for someone who can open it, with no Override they do not hold', async () => {
  const mounted = await confirmWith({
    key: KEY,
    error: HELD,
    creditHold: { opportunityId: DEAL, number: 'DEAL-0042', canOpen: true, canOverride: false },
  });
  expect(dialogLinks()).toContainEqual(['Open DEAL-0042', `/opportunities/${DEAL}`]);
  expect(buttonNamed(OVERRIDE)).toBeNull();
  await mounted.unmount();
});

it('adds nothing for someone who can neither open nor override the deal', async () => {
  const mounted = await confirmWith({
    key: KEY,
    error: HELD,
    creditHold: { opportunityId: DEAL, number: null, canOpen: false, canOverride: false },
  });
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('over its credit limit');
  expect(dialogLinks().map(([, href]) => href)).not.toContain(`/opportunities/${DEAL}`);
  expect(buttonNamed(OVERRIDE)).toBeNull();
  await mounted.unmount();
});

it('offers no deal help for any other refusal', async () => {
  const mounted = await confirmWith({
    key: KEY,
    error: 'The evidence this step needs is missing.',
  });
  expect(dialogLinks().map(([, href]) => href)).not.toContain(`/opportunities/${DEAL}`);
  expect(buttonNamed(OVERRIDE)).toBeNull();
  await mounted.unmount();
});
