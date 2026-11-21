// @vitest-environment jsdom
import { ErrorBodySchema, SalesOrderDetailSchema, type SalesOrderDetail } from '@bos/contracts';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { click, mountForm } from '@/test/form-interactions';

import { releasedText } from './release-delivery-text';

// The real release action runs behind the dialog: only the API, the session and Next are faked.
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireStaffSession: vi.fn(),
  apiFetch: vi.fn(),
  revalidatePath: vi.fn(),
  refresh: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: mocks.apiFetch,
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: mocks.refresh }),
}));
vi.mock('@/components/ui/toast', () => ({ toast: { success: mocks.success, error: mocks.error } }));

const { ReleaseDelivery } = await import('./release-delivery');

const KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORDER = '44444444-4444-4444-8444-444444444444';

type Can = NonNullable<SalesOrderDetail['can']>;
/** A `can` block as the API sends it, through the contract the page parses it with. */
const canOf = (over: Partial<Can>): Can =>
  SalesOrderDetailSchema.shape.can.unwrap().parse({
    markBillable: false,
    draftInvoice: false,
    releaseDelivery: false,
    releaseDeliveryBlockedBy: null,
    releaseDeliveryAllowedRoles: [],
    ...over,
  });

/** An error body exactly as the API's error filter emits it: no `reason` or `allowedRoles` survive it. */
const refusal = (status: number, code: string, message: string) => () =>
  Promise.resolve(
    new Response(
      JSON.stringify(ErrorBodySchema.parse({ error: { code, message, correlationId: 'corr-1' } })),
      { status },
    ),
  );

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['finance'] });
  mocks.apiFetch.mockResolvedValue(new Response('{}', { status: 201 }));
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

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(() => Promise.resolve());
};
const buttonNamed = (label: string, root: ParentNode = document) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent === label) ?? null;
const dialog = () => document.querySelector('[role="dialog"]');

async function typeReason(value: string) {
  const area = dialog()!.querySelector('textarea')!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, value);
  await act(() => Promise.resolve(area.dispatchEvent(new Event('input', { bubbles: true }))));
}
async function send() {
  const form = dialog()!.querySelector('form') as HTMLFormElement;
  await act(() => Promise.resolve(form.requestSubmit()));
  await settle();
}
const mountAllowed = async (roles: Can['releaseDeliveryAllowedRoles'] = ['finance', 'founder']) => {
  const mounted = await mountForm(
    <ReleaseDelivery
      salesOrderId={ORDER}
      can={canOf({ releaseDelivery: true, releaseDeliveryAllowedRoles: roles })}
      idempotencyKey={KEY}
      reloadHref={`/sales-orders/${ORDER}`}
    />,
  );
  await click(buttonNamed('Release delivery', mounted.container));
  return mounted;
};
const sentKeys = () =>
  mocks.apiFetch.mock.calls.map(
    (c) =>
      ((c as [unknown, string, RequestInit])[2].headers as Record<string, string>)[
        'idempotency-key'
      ],
  );

describe('the Release delivery button when the caller may not release', () => {
  it.each([
    [
      'requester',
      ['finance', 'founder'],
      'You created this order, so someone else must release it.',
    ],
    [
      'amount',
      ['management', 'founder'],
      "At this order's amount, only Management or the Founder can release it.",
    ],
    ['permission', [], 'Only Finance, Management or the Founder can release a delivery.'],
  ] as const)('is off with a plain reason when blocked by %s', async (blockedBy, roles, words) => {
    const mounted = await mountForm(
      <ReleaseDelivery
        salesOrderId={ORDER}
        can={canOf({
          releaseDeliveryBlockedBy: blockedBy,
          releaseDeliveryAllowedRoles: [...roles],
        })}
        idempotencyKey={KEY}
        reloadHref="/sales-orders/x"
      />,
    );
    const button = buttonNamed('Release delivery', mounted.container);
    expect(button?.disabled).toBe(true);
    expect(mounted.container.textContent).toContain(words);
    await click(button);
    expect(dialog()).toBeNull();
    expect(mounted.container.innerHTML).not.toContain(ORDER);
    await mounted.unmount();
  });
});

describe('releasing a delivery', () => {
  it('says who can release at this amount, sends the trimmed reason once with the page key, and refreshes', async () => {
    const mounted = await mountAllowed();
    expect(dialog()?.textContent).toContain(
      "At this order's amount, Finance or the Founder can release its delivery.",
    );
    expect(dialog()?.textContent).toContain('The person who created the order cannot release it.');
    await typeReason('  Customer collects on site today  ');
    await send();

    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
    const [, path, init] = mocks.apiFetch.mock.calls[0] as [unknown, string, RequestInit];
    expect(path).toBe(`/v1/sales-orders/${ORDER}/delivery-release`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ reason: 'Customer collects on site today' });
    expect(sentKeys()).toEqual([KEY]);
    expect(mocks.success).toHaveBeenCalledWith('Delivery released');
    expect(mocks.refresh).toHaveBeenCalled();
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/sales-orders/${ORDER}`);
    await mounted.unmount();
  });

  it('uses the general rule when the API names no roles', async () => {
    const mounted = await mountAllowed([]);
    expect(dialog()?.textContent).toContain(
      'Finance can release orders up to the amount set in Sales settings; above it, Management. The Founder can release any order.',
    );
    await mounted.unmount();
  });

  it('asks for a reason before calling the API', async () => {
    const mounted = await mountAllowed();
    await typeReason('   ');
    await send();
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(dialog()?.textContent).toContain('Say why the delivery is released now.');
    await mounted.unmount();
  });

  it('explains a 403 with a reload link and sends a new key on the next try', async () => {
    mocks.apiFetch.mockImplementation(
      refusal(403, 'forbidden', 'The person who created this order cannot release its delivery'),
    );
    const mounted = await mountAllowed();
    await typeReason('Customer collects on site today');
    await send();
    const alert = dialog()?.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(
      'You cannot release this delivery: you created this order, or your role cannot release an order of this amount.',
    );
    expect(alert?.querySelector('a')?.getAttribute('href')).toBe(`/sales-orders/${ORDER}`);
    expect(mocks.success).not.toHaveBeenCalled();

    await send();
    const [first, second] = sentKeys();
    expect(first).toBe(KEY);
    expect(second).not.toBe(KEY);
    await mounted.unmount();
  });

  it('says the delivery was already released on delivery_already_released, and that the order is not open on sales_order_not_open', async () => {
    mocks.apiFetch.mockImplementation(
      refusal(409, 'delivery_already_released', 'This delivery was already released'),
    );
    const mounted = await mountAllowed();
    await typeReason('Customer collects on site today');
    await send();
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain(
      'This delivery was already released. Reload this page to see who released it.',
    );

    mocks.apiFetch.mockImplementation(
      refusal(409, 'sales_order_not_open', 'A cancelled sales order has no delivery to release'),
    );
    await send();
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain(
      'This order is no longer confirmed, so its delivery cannot be released.',
    );

    // Any other conflict is not taken for an already released delivery.
    mocks.apiFetch.mockImplementation(refusal(409, 'conflict', 'Conflict'));
    await send();
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).not.toContain(
      'already released',
    );
    await mounted.unmount();
  });
});

describe('refusals that are not about the release rule', () => {
  it('uses the kernel words for a 403 with an allow-listed reason and for another 409 code', async () => {
    mocks.apiFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            ErrorBodySchema.parse({
              error: {
                code: 'forbidden',
                message: 'Forbidden',
                correlationId: 'corr-1',
                reason: 'no_permission',
              },
            }),
          ),
          { status: 403 },
        ),
      ),
    );
    const mounted = await mountAllowed();
    await typeReason('Customer collects on site today');
    await send();
    const first = dialog()?.querySelector('[role="alert"]')?.textContent ?? '';
    expect(first).not.toBe('');
    expect(first).not.toContain('you created this order');

    mocks.apiFetch.mockImplementation(refusal(409, 'stale_access', 'Your access changed'));
    await send();
    const second = dialog()?.querySelector('[role="alert"]')?.textContent ?? '';
    expect(second).not.toBe('');
    expect(second).not.toContain('already released');
    await mounted.unmount();
  });
});

describe('releasedText', () => {
  it('names who released it, when and why, or says the advance was paid', () => {
    expect(
      releasedText({
        kind: 'override',
        releasedAt: '2026-11-20T06:15:00.000Z',
        releasedByName: 'Sita Sharma',
        reason: 'Customer collects on site today',
      }),
    ).toMatch(/^Released by Sita Sharma on .*2026.*: Customer collects on site today$/);
    expect(
      releasedText({ kind: 'advance_paid', releasedAt: null, releasedByName: null, reason: null }),
    ).toBe('Released: advance paid');
    expect(
      releasedText({ kind: 'no_advance', releasedAt: null, releasedByName: null, reason: null }),
    ).toBe('Released: no advance on this order');
    expect(
      releasedText({
        kind: 'override',
        releasedAt: '2026-11-20T06:15:00.000Z',
        releasedByName: null,
        reason: 'Board approved',
      }),
    ).toMatch(/^Released on .*: Board approved$/);
    expect(releasedText(null)).toBeNull();
    expect(releasedText(undefined)).toBeNull();
  });
});
