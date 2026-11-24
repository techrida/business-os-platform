// @vitest-environment jsdom
// Deallocate, Release delivery, Confirm order and Mark billable each take their own trigger off the page
// once they succeed (the allocation is reversed, the delivery released, the draft confirmed, the step
// billable). Radix would hand focus back to a trigger that is gone, so focus fell to <body>: it must go to
// the page heading instead.
import type { ReactNode } from 'react';
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { click, mountForm } from '@/test/form-interactions';

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/components/ui/evidence-upload', () => ({ EvidenceUpload: () => null }));

const done = (prev: { key: string }) => Promise.resolve({ ...prev, done: true });
vi.mock('@/app/(app)/payments/[id]/allocate-actions', () => ({ deallocateAction: done }));
vi.mock('@/app/(app)/sales-orders/[id]/release-delivery-action', () => ({
  releaseDeliveryAction: done,
}));
vi.mock('@/app/(app)/sales-orders/_lib/actions', () => ({
  confirmDraftAction: done,
  markBillableAction: done,
}));

const { DeallocateDialog } = await import('@/app/(app)/payments/[id]/deallocate-dialog');
const { ReleaseDelivery } = await import('@/app/(app)/sales-orders/[id]/release-delivery');
const { ConfirmDraftDialog } =
  await import('@/app/(app)/sales-orders/_components/confirm-draft-dialog');
const { MarkBillableDialog } =
  await import('@/app/(app)/sales-orders/_components/mark-billable-dialog');

const ID = '11111111-1111-4111-8111-111111111111';
const KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function succeed(dialog: ReactNode, trigger: string, reason: boolean) {
  mounted = await mountForm(
    <main>
      <h1>Page heading</h1>
      {dialog}
    </main>,
  );
  const opener = [...document.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === trigger,
  );
  await click(opener ?? null);
  await flush();
  if (reason) {
    const box = document.querySelector<HTMLTextAreaElement>('textarea[name="reason"]')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'Why');
    await act(() => {
      box.dispatchEvent(new Event('input', { bubbles: true }));
      return Promise.resolve();
    });
  }
  await click(document.querySelector('button[type="submit"][form]'));
  await flush();
  await flush();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(document.querySelector('main h1'));
}

it('puts focus on the page heading after Deallocate succeeds', async () => {
  await succeed(
    <DeallocateDialog
      paymentId={ID}
      allocationId={ID}
      label="INV-1"
      idempotencyKey={KEY}
      reloadHref="/"
    />,
    'Deallocate INV-1',
    true,
  );
});

it('puts focus on the page heading after Release delivery succeeds', async () => {
  await succeed(
    <ReleaseDelivery
      salesOrderId={ID}
      can={{ releaseDelivery: true } as never}
      idempotencyKey={KEY}
      reloadHref="/"
    />,
    'Release delivery',
    true,
  );
});

it('puts focus on the page heading after Confirm order succeeds', async () => {
  await succeed(
    <ConfirmDraftDialog quotationVersionId={ID} idempotencyKey={KEY} reloadHref="/" />,
    'Confirm order',
    false,
  );
});

it('puts focus on the page heading after Mark billable succeeds', async () => {
  await succeed(
    <MarkBillableDialog
      salesOrderId={ID}
      scheduleLineId={ID}
      lineLabel="Milestone 1"
      version={1}
      evidence={[]}
      idempotencyKey={KEY}
      reloadHref="/"
    />,
    'Mark billable',
    false,
  );
});
