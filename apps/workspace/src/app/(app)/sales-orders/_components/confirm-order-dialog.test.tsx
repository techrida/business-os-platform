// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { click, mountForm } from '@/test/form-interactions';

import type { ActionState } from '../_lib/state';

const mocks = vi.hoisted(() => ({ confirmOrderAction: vi.fn() }));
vi.mock('../_lib/actions', () => ({ confirmOrderAction: mocks.confirmOrderAction }));
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

it('links to the deal when the confirm is refused for a credit hold (F1-Q20)', async () => {
  const mounted = await confirmWith({
    key: KEY,
    error: 'This customer is over its credit limit, so the sales order is on hold.',
    creditHoldOpportunityId: DEAL,
  });
  expect(mocks.confirmOrderAction).toHaveBeenCalledOnce();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('over its credit limit');
  expect(dialogLinks()).toContainEqual([
    'Open the opportunity on credit hold',
    `/opportunities/${DEAL}`,
  ]);
  await mounted.unmount();
});

it('offers no deal link for any other refusal', async () => {
  const mounted = await confirmWith({
    key: KEY,
    error: 'The evidence this step needs is missing.',
  });
  expect(dialogLinks().map(([label]) => label)).not.toContain(
    'Open the opportunity on credit hold',
  );
  await mounted.unmount();
});
