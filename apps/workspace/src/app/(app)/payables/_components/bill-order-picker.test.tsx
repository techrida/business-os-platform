// @vitest-environment jsdom
// The purchase order picker of a standalone bill (U18 #12): the accountant holds no purchase order read, so the
// page hands the header the payables picker's orders. Only the chosen vendor's orders are offered, and picking one
// reloads the entry with that order as ?po=.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fill, mountForm } from '@/test/form-interactions';

import { listedOptions, pickBox, pickByTyping } from '../../procurement/pick-existing.test-helpers';

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('../actions', () => ({ convertSubmissionAction: vi.fn(), createBillAction: vi.fn() }));
import { BillEntryForm } from './bill-entry-form';

const HIMAL = '11111111-1111-4111-8111-111111111111';
const EVEREST = '22222222-2222-4222-8222-222222222222';
const PO_HIMAL = '33333333-3333-4333-8333-333333333333';
const PO_EVEREST = '44444444-4444-4444-8444-444444444444';

let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  router.push.mockReset();
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
});

beforeEach(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView = vi.fn();
});

describe('the purchase order picker of a new bill', () => {
  it("offers only the chosen vendor's orders and opens the entry for the one picked", async () => {
    mounted = await mountForm(
      <BillEntryForm
        idempotencyKey="key"
        orderLines={[]}
        taxCodes={[]}
        withholdingCodes={[]}
        cancelHref="/payables/bills"
        reloadHref="/payables/bills/new"
        entry={{
          vendors: [
            { id: HIMAL, name: 'Himal Traders', description: 'PAN 111111111' },
            { id: EVEREST, name: 'Everest Supplies', description: 'PAN 222222222' },
          ],
          orders: [
            { id: PO_HIMAL, vendorId: HIMAL, label: 'PO-2083-0007 · Issued' },
            { id: PO_EVEREST, vendorId: EVEREST, label: 'PO-2083-0009 · Fully received' },
          ],
        }}
      />,
    );
    const { container } = mounted;
    // No vendor yet: no order to pick, and nothing asks for a raw order id.
    expect(container.querySelector('input[name="orderPicker"]')).toBeNull();
    expect(container.textContent).not.toContain('Purchase order ID');

    // One search box, no Find button: typing narrows the vendors, with the PAN beside the name.
    expect(container.textContent).not.toContain('Find a vendor');
    await fill(pickBox(container, 'vendorPartyId'), 'everest');
    expect(listedOptions()).toEqual(['Everest SuppliesPAN 222222222']);
    await pickByTyping(container, 'vendorPartyId', 'himal', 'Himal Traders');
    expect(container.querySelector<HTMLInputElement>('input[name="vendorPartyId"]')?.value).toBe(
      HIMAL,
    );

    await fill(pickBox(container, 'orderPicker'), 'PO-2083');
    expect(listedOptions()).toEqual(['PO-2083-0007 · IssuedHimal Traders']);
    await pickByTyping(container, 'orderPicker', 'PO-2083-0007', 'PO-2083-0007');
    expect(router.push).toHaveBeenCalledWith(`/payables/bills/new?po=${PO_HIMAL}`);
  });
});
