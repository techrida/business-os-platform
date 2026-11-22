// @vitest-environment jsdom
import { act } from 'react';
import { expect, it, vi } from 'vitest';

import { click, fill, mountForm } from '@/test/form-interactions';

import { ReverseDialog } from './receipt-actions';
import { ReceiptForm, type FormLine } from './receipt-form';

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

const LINE: FormLine = {
  poLineId: '44444444-4444-4444-8444-444444444444',
  lineNo: 1,
  kind: 'goods',
  description: 'Cement bags',
  uom: 'kg',
  requiresSerials: false,
  ordered: '20,00,000',
  received: '0',
  pending: '0',
  cap: '20,00,000',
  hasRoom: true,
};

async function mountReceiptForm() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  return mountForm(
    <ReceiptForm
      purchaseOrderId="22222222-2222-4222-8222-222222222222"
      number="PO-1"
      idempotencyKey="33333333-3333-4333-8333-333333333333"
      today="2026-11-21"
      kinds={['goods']}
      lines={[LINE]}
      cancelHref="/procurement/orders/1"
      reloadHref="/procurement/receipts/new"
    />,
  );
}

it('groups the received quantity as it is typed, posts it plain and steps it with buttons', async () => {
  const mounted = await mountReceiptForm();
  try {
    const name = `qty:${LINE.poLineId}`;
    const posted = () =>
      mounted.container.querySelector<HTMLInputElement>(`input[type="hidden"][name="${name}"]`);
    const label = [...mounted.container.querySelectorAll('label')].find((l) =>
      l.textContent?.startsWith('Quantity received'),
    );
    const box = document.getElementById(label?.htmlFor ?? '');
    expect(box).toBeInstanceOf(HTMLInputElement);
    // The unit is said once, by the box, not again in the label.
    expect(label?.textContent).not.toContain('kg');
    expect(box?.parentElement?.textContent).toContain('kg');
    expect(box?.getAttribute('name')).toBeNull();

    await fill(box, '1250000');
    expect((box as HTMLInputElement).value).toBe('12,50,000');
    expect(posted()?.value).toBe('1250000');
    expect(new FormData(mounted.container.querySelector('form')!).get(name)).toBe('1250000');
    expect(mounted.container.querySelector('[aria-label="Decrease quantity"]')).toBeInstanceOf(
      HTMLButtonElement,
    );
    expect(mounted.container.querySelector('[aria-label="Increase quantity"]')).toBeInstanceOf(
      HTMLButtonElement,
    );
  } finally {
    await mounted.unmount();
    vi.unstubAllGlobals();
  }
});

it('picks the receipt date with the calendar, starting on today and posting it as an ISO date', async () => {
  const mounted = await mountReceiptForm();
  try {
    expect(mounted.container.querySelector('button[aria-label="Calendar"]')).toBeInstanceOf(
      HTMLButtonElement,
    );
    const posted = mounted.container.querySelector<HTMLInputElement>('input[name="receivedAt"]');
    expect(posted?.value).toBe('2026-11-21');
    expect(new FormData(mounted.container.querySelector('form')!).get('receivedAt')).toBe(
      '2026-11-21',
    );
  } finally {
    await mounted.unmount();
    vi.unstubAllGlobals();
  }
});
