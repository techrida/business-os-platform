// @vitest-environment jsdom
// The VAT tick of a vendor change belongs to the vendor that raised the warning: through the real dialog and the
// real action, a tick given for vendor A is not sent when the person then picks vendor B.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import { click, mountForm } from '@/test/form-interactions';

import { ChangeVendorDialog } from './order-actions';

const api = vi.hoisted(() => ({ changePurchaseOrderVendor: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/bff', () => ({
  requireStaffSession: () => Promise.resolve({ roles: ['procurement'] }),
}));
vi.mock('@/lib/grants', () => ({
  getGrants: () => Promise.resolve(new Map([['procurement.po.issue', 'all']])),
  hasGrant: (g: Map<string, string>, p: string) => g.has(p),
}));
vi.mock('@/lib/api-purchase-orders', () => api);

const PO = '11111111-1111-4111-8111-111111111111';
const KEY = '33333333-3333-4333-8333-333333333333';
const VENDOR_A = '66666666-6666-4666-8666-666666666666';
const VENDOR_B = '77777777-7777-4777-8777-777777777777';

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

async function pickVendor(name: string) {
  await click(document.querySelector('[role="dialog"] input[role="combobox"]'));
  const option = [...document.querySelectorAll('[role="option"]')].find(
    (o) => o.textContent?.trim() === name,
  );
  if (!option) throw new Error(`No vendor option "${name}"`);
  await click(option);
}

const vatTick = () =>
  document.querySelector<HTMLInputElement>('input[type="checkbox"][name="acknowledgeVatWarning"]');

it('does not send a VAT tick given for vendor A when the vendor is changed to B', async () => {
  api.changePurchaseOrderVendor
    .mockRejectedValueOnce(
      new ApiError(409, 'x', {
        error: {
          code: 'VENDOR_NOT_VAT_REGISTERED',
          message: 'internal wording',
          correlationId: 'corr-12345678',
        },
      }),
    )
    .mockResolvedValueOnce({ pendingVendorChange: null });
  const mounted = await mountForm(
    <ChangeVendorDialog
      purchaseOrderId={PO}
      number="PO-2082-0001"
      idempotencyKey={KEY}
      reloadHref={`/procurement/orders/${PO}`}
      vendors={[
        { id: VENDOR_A, name: 'Alpha Traders' },
        { id: VENDOR_B, name: 'Bravo Supplies' },
      ]}
    />,
  );
  try {
    await click(mounted.container.querySelector('button'));
    await pickVendor('Alpha Traders');
    await click(document.querySelector<HTMLButtonElement>('footer button[type="submit"]'));
    expect(api.changePurchaseOrderVendor).toHaveBeenLastCalledWith(
      expect.anything(),
      PO,
      VENDOR_A,
      expect.any(String),
      false,
    );

    // The warning for A asks for the tick; the person ticks it, then picks B instead.
    expect(vatTick()).not.toBeNull();
    await click(vatTick());
    expect(vatTick()?.checked).toBe(true);
    await pickVendor('Bravo Supplies');
    expect(vatTick()).toBeNull();

    await click(document.querySelector<HTMLButtonElement>('footer button[type="submit"]'));
    expect(api.changePurchaseOrderVendor).toHaveBeenCalledTimes(2);
    expect(api.changePurchaseOrderVendor).toHaveBeenLastCalledWith(
      expect.anything(),
      PO,
      VENDOR_B,
      expect.any(String),
      false,
    );
  } finally {
    await mounted.unmount();
  }
});
