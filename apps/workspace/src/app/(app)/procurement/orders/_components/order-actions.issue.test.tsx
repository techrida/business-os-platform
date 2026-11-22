// @vitest-environment jsdom
// The issue guard end to end in the browser half: the dialog submits the row version the page showed, the real
// action passes it on, and the real API helper puts it in the POST body.
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { click, mountForm, typeKeys } from '@/test/form-interactions';

import { AmendDialog, IssueDialog } from './order-actions';

const api = vi.hoisted(() => ({
  issuePurchaseOrder: vi.fn(),
  getPurchaseOrder: vi.fn(),
  amendPurchaseOrder: vi.fn(),
}));
const apiFetch = vi.hoisted(() => vi.fn());

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
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  apiFetch,
}));

const PO = '11111111-1111-4111-8111-111111111111';
const KEY = '33333333-3333-4333-8333-333333333333';
type Call = [unknown, string, RequestInit];

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

it('submits the version the page showed with the issue', async () => {
  api.issuePurchaseOrder.mockResolvedValue({ number: 'PO-1' });
  const mounted = await mountForm(
    <IssueDialog
      purchaseOrderId={PO}
      number="PO-2082-0001"
      version={3}
      idempotencyKey={KEY}
      reloadHref={`/procurement/orders/${PO}`}
    />,
  );
  try {
    await click(mounted.container.querySelector('button'));
    const seen = document.querySelector<HTMLInputElement>('input[name="expectedVersion"]');
    expect(seen?.value).toBe('3');
    await click(document.querySelector<HTMLButtonElement>('footer button[type="submit"]'));
    // Old code sent no version: the API issued whatever the order had become.
    expect(api.issuePurchaseOrder).toHaveBeenCalledExactlyOnceWith(expect.anything(), PO, KEY, 3);
  } finally {
    await mounted.unmount();
  }
});

it('puts expectedVersion in the issue body, and sends no body without one', async () => {
  const real = await vi.importActual<typeof import('@/lib/api-purchase-orders')>(
    '@/lib/api-purchase-orders',
  );
  apiFetch.mockImplementation(() => Promise.resolve(Response.json({})));
  const session = { accessToken: 't' } as Parameters<typeof real.issuePurchaseOrder>[0];
  // The empty answer fails the schema; only the request matters here.
  await real.issuePurchaseOrder(session, PO, KEY, 3).catch(() => undefined);
  await real.issuePurchaseOrder(session, PO, KEY).catch(() => undefined);
  const [withVersion, without] = apiFetch.mock.calls as [Call, Call];
  expect(withVersion[1]).toBe(`/v1/procurement/purchase-orders/${PO}/issue`);
  expect(withVersion[2].method).toBe('POST');
  expect(JSON.parse(withVersion[2].body as string)).toEqual({ expectedVersion: 3 });
  expect(withVersion[2].headers).toMatchObject({ 'idempotency-key': KEY });
  expect(without[2].body).toBeUndefined();
});

it('amends through formatted quantity, money and whole-day terms boxes that post plain values', async () => {
  const LINE = '44444444-4444-4444-8444-444444444444';
  api.getPurchaseOrder.mockResolvedValue({
    paymentTermsDays: 30,
    lines: [{ id: LINE, orderedQuantity: '10.0000', unitPrice: '1000.00' }],
  });
  api.amendPurchaseOrder.mockResolvedValue({
    outcome: 'pending_approval',
    purchaseOrder: { currentVersion: 1 },
  });
  const mounted = await mountForm(
    <AmendDialog
      purchaseOrderId={PO}
      number="PO-2082-0001"
      idempotencyKey={KEY}
      reloadHref={`/procurement/orders/${PO}`}
      currency="NPR"
      paymentTermsDays={30}
      lines={[
        {
          id: LINE,
          lineNo: 1,
          description: 'Chair',
          uom: 'pcs',
          orderedQuantity: '10.0000',
          unitPrice: '1000.00',
          received: '0.0000',
          cancelledQuantity: '0.0000',
        },
      ]}
    />,
  );
  try {
    await click(mounted.container.querySelector('button'));
    const boxOf = (name: string) =>
      document
        .querySelector(`input[type="hidden"][name="${name}"]`)!
        .parentElement!.querySelector<HTMLInputElement>('input[type="text"]')!;
    const qty = boxOf(`qty:${LINE}`);
    expect(qty.getAttribute('role')).toBe('spinbutton');
    expect(
      qty.parentElement!.querySelector('button[aria-label="Increase quantity"]'),
    ).not.toBeNull();
    expect(
      qty.parentElement!.querySelector('button[aria-label="Decrease quantity"]'),
    ).not.toBeNull();
    await typeKeys(qty, '{Backspace}{Backspace}1250000');
    expect(qty.value).toBe('12,50,000');

    const price = boxOf(`price:${LINE}`);
    expect(price.parentElement!.textContent).toContain('NPR');

    const terms = boxOf('paymentTerms');
    expect(terms.getAttribute('inputmode')).toBe('numeric');
    await typeKeys(terms, '{Backspace}{Backspace}400');
    // 400 is past the 365-day limit, so the last keystroke is refused.
    expect(terms.value).toBe('40');
    await typeKeys(terms, '{Backspace}5');
    expect(terms.value).toBe('45');

    const reason = document.querySelector<HTMLTextAreaElement>('textarea[name="reason"]')!;
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        reason,
        'Vendor revised the order',
      );
      reason.dispatchEvent(new Event('input', { bubbles: true }));
      return Promise.resolve();
    });
    await click(document.querySelector<HTMLButtonElement>('footer button[type="submit"]'));
    expect(api.amendPurchaseOrder).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      PO,
      {
        reason: 'Vendor revised the order',
        paymentTermsDays: 45,
        lines: [{ poLineId: LINE, quantity: '1250000' }],
      },
      KEY,
    );
  } finally {
    await mounted.unmount();
  }
});

it('starts the amend price from a stored 100000.000 without the extra zeros and leaves it unsent', async () => {
  const LINE = '55555555-5555-4555-8555-555555555555';
  api.getPurchaseOrder.mockResolvedValue({
    paymentTermsDays: 30,
    lines: [{ id: LINE, orderedQuantity: '4.0000', unitPrice: '100000.000' }],
  });
  api.amendPurchaseOrder.mockResolvedValue({
    outcome: 'pending_approval',
    purchaseOrder: { currentVersion: 1 },
  });
  const mounted = await mountForm(
    <AmendDialog
      purchaseOrderId={PO}
      number="PO-2082-0002"
      idempotencyKey={KEY}
      reloadHref={`/procurement/orders/${PO}`}
      currency="NPR"
      paymentTermsDays={30}
      lines={[
        {
          id: LINE,
          lineNo: 1,
          description: 'Server',
          uom: 'pcs',
          orderedQuantity: '4.0000',
          unitPrice: '100000.000',
          received: '0.0000',
          cancelledQuantity: '0.0000',
        },
      ]}
    />,
  );
  try {
    await click(mounted.container.querySelector('button'));
    const posted = document.querySelector<HTMLInputElement>(
      `input[type="hidden"][name="price:${LINE}"]`,
    )!;
    const price = posted.parentElement!.querySelector<HTMLInputElement>('input[type="text"]')!;
    expect(price.value).toBe('1,00,000.00');
    expect(posted.value).toBe('100000');
    // The currency is shown by the box, so the label does not repeat it.
    expect(document.querySelector(`label[for="${price.id}"]`)?.textContent).toBe('Unit price');

    const terms = document
      .querySelector('input[type="hidden"][name="paymentTerms"]')!
      .parentElement!.querySelector<HTMLInputElement>('input[type="text"]')!;
    await typeKeys(terms, '{Backspace}{Backspace}45');
    const reason = document.querySelector<HTMLTextAreaElement>('textarea[name="reason"]')!;
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        reason,
        'Longer terms',
      );
      reason.dispatchEvent(new Event('input', { bubbles: true }));
      return Promise.resolve();
    });
    await click(document.querySelector<HTMLButtonElement>('footer button[type="submit"]'));
    expect(api.amendPurchaseOrder).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      PO,
      { reason: 'Longer terms', paymentTermsDays: 45, lines: [] },
      KEY,
    );
  } finally {
    await mounted.unmount();
  }
});
