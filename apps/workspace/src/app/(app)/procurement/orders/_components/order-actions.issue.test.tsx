// @vitest-environment jsdom
// The issue guard end to end in the browser half: the dialog submits the row version the page showed, the real
// action passes it on, and the real API helper puts it in the POST body.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { click, mountForm } from '@/test/form-interactions';

import { IssueDialog } from './order-actions';

const api = vi.hoisted(() => ({ issuePurchaseOrder: vi.fn() }));
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
