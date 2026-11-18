// @vitest-environment jsdom
import { act } from 'react';
import { expect, it, vi } from 'vitest';

import { click, mountForm } from '@/test/form-interactions';

import { ReverseDialog } from './receipt-actions';

const api = vi.hoisted(() => ({
  getReceipt: vi.fn(),
  reverseReceipt: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/bff', () => ({
  requireStaffSession: () => Promise.resolve({ roles: ['warehouse'] }),
}));
vi.mock('@/lib/api-purchase-orders', () => api);

it('submits the receipt and its reason from the fixed footer', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  const receiptId = '11111111-1111-4111-8111-111111111111';
  const purchaseOrderId = '22222222-2222-4222-8222-222222222222';
  const key = '33333333-3333-4333-8333-333333333333';
  api.getReceipt.mockResolvedValue({ kind: 'goods', purchaseOrderId });
  api.reverseReceipt.mockResolvedValue({ number: 'GRN-2' });

  const mounted = await mountForm(
    <ReverseDialog
      receiptId={receiptId}
      number="GRN-1"
      idempotencyKey={key}
      reloadHref={`/procurement/receipts/${receiptId}`}
    />,
  );
  try {
    await click(mounted.container.querySelector('button'));
    const reason = document.querySelector<HTMLTextAreaElement>('textarea[name="reason"]');
    const submitButton = document.querySelector<HTMLButtonElement>('footer button[type="submit"]');
    expect(reason?.form).toBeInstanceOf(HTMLFormElement);
    expect(submitButton?.form).toBe(reason?.form);

    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
      reason,
      'Wrong delivery',
    );
    await act(() => Promise.resolve(reason?.dispatchEvent(new Event('input', { bubbles: true }))));
    await click(submitButton);

    expect(api.reverseReceipt).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      receiptId,
      'Wrong delivery',
      key,
    );
    expect(document.querySelector('footer')?.textContent).toBe('Done');
  } finally {
    await mounted.unmount();
    vi.unstubAllGlobals();
  }
});
