// @vitest-environment jsdom
// The purchase order picker of a payment request (U18 #13): Finance picks one of the vendor's orders from the
// payables picker instead of pasting a raw purchase order id, and the form submits the picked order's id.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fill, mountForm } from '@/test/form-interactions';

import { listedOptions, pickBox, pickByTyping } from '../../procurement/pick-existing.test-helpers';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('./actions', () => ({
  createPaymentRequestAction: vi.fn(),
  submitPaymentRequestAction: vi.fn(),
  cancelPaymentRequestAction: vi.fn(),
}));
import { PaymentRequestEntry } from './forms';

const HIMAL = '11111111-1111-4111-8111-111111111111';
const EVEREST = '22222222-2222-4222-8222-222222222222';
const PO_HIMAL = '33333333-3333-4333-8333-333333333333';
const PO_EVEREST = '44444444-4444-4444-8444-444444444444';
const item = (vendorPartyId: string, vendorName: string, n: number) => ({
  openItemId: `5555555${n}-5555-4555-8555-555555555555`,
  vendorPartyId,
  vendorName,
  vendorBillId: `6666666${n}-6666-4666-8666-666666666666`,
  billNumber: `BILL-${n}`,
  vendorInvoiceNo: `INV-${n}`,
  currency: 'NPR' as const,
  openAmount: '1000.00',
  claimedAmount: '0.00',
  availableAmount: '1000.00',
});
let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
});

describe('the purchase order picker of a payment request', () => {
  it("offers only the chosen vendor's orders and submits the picked order's id", async () => {
    mounted = await mountForm(
      <PaymentRequestEntry
        idempotencyKey="key"
        items={[item(HIMAL, 'Himal Traders', 1), item(EVEREST, 'Everest Supplies', 2)]}
        orders={[
          { id: PO_HIMAL, vendorId: HIMAL, label: 'PO-2083-0007 · Issued' },
          { id: PO_EVEREST, vendorId: EVEREST, label: 'PO-2083-0009 · Closed' },
        ]}
      />,
    );
    const { container } = mounted;
    const field = () => container.querySelector<HTMLInputElement>('input[name="purchaseOrderId"]');
    expect(container.textContent).not.toContain('Purchase order ID');
    expect(field()?.type).toBe('hidden');

    await pickByTyping(container, 'vendorPartyId', 'himal', 'Himal Traders');
    expect(container.querySelector<HTMLInputElement>('input[name="vendorPartyId"]')?.value).toBe(
      HIMAL,
    );
    // Only this vendor's order is listed, with the vendor named beside its number.
    await fill(pickBox(container, 'purchaseOrderId'), 'PO-2083');
    expect(listedOptions()).toEqual(['PO-2083-0007 · IssuedHimal Traders']);
    await pickByTyping(container, 'purchaseOrderId', 'PO-2083', 'PO-2083-0007 · Issued');
    expect(field()?.value).toBe(PO_HIMAL);
    const form = container.querySelector('form');
    expect(form && new FormData(form).get('purchaseOrderId')).toBe(PO_HIMAL);

    // A new vendor clears the order: an order of the previous vendor is never sent.
    await pickByTyping(container, 'vendorPartyId', 'everest', 'Everest Supplies');
    expect(field()?.value).toBe('');
  });

  it('says so when the chosen vendor has no purchase orders', async () => {
    mounted = await mountForm(
      <PaymentRequestEntry
        idempotencyKey="key"
        items={[item(HIMAL, 'Himal Traders', 1)]}
        orders={[]}
      />,
    );
    const { container } = mounted;
    await pickByTyping(container, 'vendorPartyId', 'himal', 'Himal Traders');
    expect(pickBox(container, 'purchaseOrderId').placeholder).toBe(
      'This vendor has no purchase orders',
    );
    expect(container.querySelector<HTMLInputElement>('input[name="purchaseOrderId"]')?.value).toBe(
      '',
    );
  });
});
