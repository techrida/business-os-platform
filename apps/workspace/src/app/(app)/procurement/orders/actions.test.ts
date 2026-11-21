import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));
const session = vi.hoisted(() => ({ roles: ['procurement'] as string[] }));
vi.mock('@/lib/bff', () => ({
  requireStaffSession: () => Promise.resolve({ roles: session.roles }),
}));
// GET /v1/me for an unedited role answers the role's default grants; a test sets `live` for an edited one.
const grants = vi.hoisted(() => ({ live: undefined as Map<string, string> | undefined }));
vi.mock('@/lib/grants', async () => {
  const { DEFAULT_ROLE_PERMISSIONS } = await import('@bos/contracts');
  return {
    getGrants: () =>
      Promise.resolve(
        grants.live ??
          new Map(
            session.roles.flatMap((r) =>
              Object.entries(DEFAULT_ROLE_PERMISSIONS[r as keyof typeof DEFAULT_ROLE_PERMISSIONS]),
            ),
          ),
      ),
    hasGrant: (g: Map<string, string>, p: string) => g.has(p),
  };
});
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
}));

const api = vi.hoisted(() => ({
  getPurchaseOrder: vi.fn(),
  issuePurchaseOrder: vi.fn(),
  amendPurchaseOrder: vi.fn(),
  shortClosePurchaseOrder: vi.fn(),
  cancelPurchaseOrder: vi.fn(),
  changePurchaseOrderVendor: vi.fn(),
  cancelAndRecreatePurchaseOrder: vi.fn(),
}));
vi.mock('@/lib/api-purchase-orders', () => api);

const {
  amendAction,
  cancelAction,
  cancelAndRecreateAction,
  changeVendorAction,
  issueAction,
  shortCloseAction,
} = await import('./actions');

const PO = '11111111-1111-4111-8111-111111111111';
const LINE = '22222222-2222-4222-8222-222222222222';
const KEY = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const prev = { key: KEY };

const apiError = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  new ApiError(status, 'x', {
    error: { code, message: 'internal wording', correlationId: 'corr-12345678', ...extra },
  });

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}
const base = { purchaseOrderId: PO, idempotencyKey: KEY };

const currentOrder = {
  id: PO,
  paymentTermsDays: 30,
  currentVersion: 1,
  lines: [{ id: LINE, orderedQuantity: '10.0000', unitPrice: '1000.00' }],
};

beforeEach(() => {
  session.roles = ['procurement'];
  grants.live = undefined;
  for (const fn of Object.values(api)) fn.mockReset();
  api.getPurchaseOrder.mockResolvedValue(currentOrder);
});

describe('issueAction', () => {
  it('sends the form key to the API and says it is done', async () => {
    api.issuePurchaseOrder.mockResolvedValue({ ...currentOrder, number: 'PO-1' });
    const out = await issueAction(prev, form(base));
    expect(api.issuePurchaseOrder).toHaveBeenCalledWith(expect.anything(), PO, KEY);
    expect(out.done).toMatch(/issued/i);
    expect(out.error).toBeUndefined();
  });

  it('sends the version the page showed, so an order edited since is not issued', async () => {
    api.issuePurchaseOrder.mockResolvedValue({ ...currentOrder, number: 'PO-1' });
    const out = await issueAction(prev, form({ ...base, expectedVersion: '3' }));
    // Old code dropped the field: the API could not tell an edited order from the one reviewed.
    expect(api.issuePurchaseOrder).toHaveBeenCalledWith(expect.anything(), PO, KEY, 3);
    expect(out.done).toMatch(/issued/i);
  });

  it('refuses a malformed version before any API call', async () => {
    for (const bad of ['0', '-1', '2.5', 'abc', '1e3', '9999999999']) {
      api.issuePurchaseOrder.mockClear();
      const out = await issueAction(prev, form({ ...base, expectedVersion: bad }));
      expect(out.error).toMatch(/form is incomplete/i);
      expect(out.reload).toBe(true);
      expect(api.issuePurchaseOrder).not.toHaveBeenCalled();
    }
  });

  it('words PO_CHANGED as a changed order to reload, and rotates the key', async () => {
    api.issuePurchaseOrder.mockRejectedValue(apiError(409, 'PO_CHANGED'));
    const out = await issueAction(prev, form({ ...base, expectedVersion: '3' }));
    expect(out.error).toBe(
      'This purchase order changed since you opened it. Reload and try again.',
    );
    expect(out.reload).toBe(true);
    expect(out.key).not.toBe(KEY);
  });

  it('shows VENDOR_NOT_APPROVED plainly and rotates the key (a definite answer)', async () => {
    api.issuePurchaseOrder.mockRejectedValue(apiError(409, 'VENDOR_NOT_APPROVED'));
    const out = await issueAction(prev, form(base));
    expect(out.error).toMatch(/vendor is not approved/i);
    expect(out.key).not.toBe(KEY);
    expect(out.done).toBeUndefined();
  });

  it('shows PO_HAS_NO_LINES and VENDOR_NOT_IN_ENTITY plainly', async () => {
    api.issuePurchaseOrder.mockRejectedValue(apiError(409, 'PO_HAS_NO_LINES'));
    expect((await issueAction(prev, form(base))).error).toMatch(/no lines/i);
    api.issuePurchaseOrder.mockRejectedValue(apiError(409, 'VENDOR_NOT_IN_ENTITY'));
    expect((await issueAction(prev, form(base))).error).toMatch(/legal entity/i);
  });

  it('keeps the same key after a timeout, a 5xx or the in-progress 409', async () => {
    for (const e of [
      apiError(503, 'x'),
      apiError(408, 'x'),
      apiError(409, 'conflict', { message: 'A request with this Idempotency-Key is in progress' }),
      new Error('socket hang up'),
    ]) {
      api.issuePurchaseOrder.mockRejectedValue(e);
      expect((await issueAction(prev, form(base))).key).toBe(KEY);
    }
  });

  it('refuses a person without procurement.po.issue before any API call', async () => {
    session.roles = ['warehouse'];
    const out = await issueAction(prev, form(base));
    expect(out.error).toMatch(/roles do not include/i);
    expect(api.issuePurchaseOrder).not.toHaveBeenCalled();
  });

  // The live grants decide, not the role defaults: both cases fail on the old role-default gate.
  it('issues for a role an admin granted procurement.po.issue, whatever its defaults', async () => {
    session.roles = ['warehouse'];
    grants.live = new Map([['procurement.po.issue', 'own']]);
    api.issuePurchaseOrder.mockResolvedValue({ ...currentOrder, number: 'PO-1' });
    expect((await issueAction(prev, form(base))).done).toMatch(/issued/i);
    expect(api.issuePurchaseOrder).toHaveBeenCalledOnce();
  });

  it('refuses Procurement whose procurement.po.issue an admin removed, before any API call', async () => {
    grants.live = new Map([['procurement.pr.read', 'all']]);
    expect((await issueAction(prev, form(base))).error).toMatch(/roles do not include/i);
    expect(api.issuePurchaseOrder).not.toHaveBeenCalled();
  });

  it('replaces a key that is not ours, and refuses an id that is not a UUID', async () => {
    api.issuePurchaseOrder.mockResolvedValue({});
    await issueAction(prev, form({ ...base, idempotencyKey: 'x; drop table' }));
    expect(api.issuePurchaseOrder.mock.calls[0]?.[2]).not.toBe('x; drop table');
    api.issuePurchaseOrder.mockClear();
    const out = await issueAction(prev, form({ ...base, purchaseOrderId: '../admin' }));
    expect(out.reload).toBe(true);
    expect(api.issuePurchaseOrder).not.toHaveBeenCalled();
  });
});

describe('amendAction', () => {
  const fields = {
    ...base,
    reason: 'Vendor raised the price',
    paymentTerms: '30',
    [`qty:${LINE}`]: '10',
    [`price:${LINE}`]: '1100',
  };

  it('sends only what changed and tells the person the order is waiting for approval', async () => {
    api.amendPurchaseOrder.mockResolvedValue({
      outcome: 'pending_approval',
      approvalRequestId: LINE,
      purchaseOrder: { ...currentOrder, status: 'amendment_pending' },
    });
    const out = await amendAction(prev, form(fields));
    expect(api.amendPurchaseOrder).toHaveBeenCalledWith(
      expect.anything(),
      PO,
      { reason: 'Vendor raised the price', lines: [{ poLineId: LINE, unitPrice: '1100' }] },
      KEY,
    );
    expect(out.done).toMatch(/approval/i);
  });

  it('says a new version was issued when the change was applied', async () => {
    api.amendPurchaseOrder.mockResolvedValue({
      outcome: 'applied',
      approvalRequestId: null,
      purchaseOrder: { ...currentOrder, currentVersion: 2 },
    });
    expect((await amendAction(prev, form(fields))).done).toMatch(/version 2/i);
  });

  it('refuses a form that changes nothing without calling the API', async () => {
    const out = await amendAction(prev, form({ ...fields, [`price:${LINE}`]: '1000' }));
    expect(out.errors?.['lines']).toBeDefined();
    expect(api.amendPurchaseOrder).not.toHaveBeenCalled();
    expect(out.key).toBe(KEY);
  });

  it('words a 422 amendment refusal', async () => {
    api.amendPurchaseOrder.mockRejectedValue(apiError(422, 'PO_AMENDMENT_INVALID'));
    expect((await amendAction(prev, form(fields))).error).toMatch(/received plus cancelled/i);
  });

  it('refuses without the grant before reading the order', async () => {
    session.roles = ['sales'];
    const out = await amendAction(prev, form(fields));
    expect(out.error).toMatch(/roles do not include/i);
    expect(api.getPurchaseOrder).not.toHaveBeenCalled();
  });
});

describe('shortCloseAction and cancelAction', () => {
  it('need a reason, then send it with the key', async () => {
    const none = await cancelAction(prev, form({ ...base, reason: '  ' }));
    expect(none.errors?.['reason']).toBeDefined();
    expect(api.cancelPurchaseOrder).not.toHaveBeenCalled();

    api.cancelPurchaseOrder.mockResolvedValue({});
    const out = await cancelAction(prev, form({ ...base, reason: 'Ordered twice' }));
    expect(api.cancelPurchaseOrder).toHaveBeenCalledWith(
      expect.anything(),
      PO,
      'Ordered twice',
      KEY,
    );
    expect(out.done).toMatch(/cancelled/i);

    api.shortClosePurchaseOrder.mockResolvedValue({});
    expect(
      (await shortCloseAction(prev, form({ ...base, reason: 'Rest not needed' }))).done,
    ).toMatch(/short-closed/i);
  });

  it('shows PO_HAS_RECEIPTS in plain words on cancel', async () => {
    api.cancelPurchaseOrder.mockRejectedValue(apiError(409, 'PO_HAS_RECEIPTS'));
    const out = await cancelAction(prev, form({ ...base, reason: 'x' }));
    expect(out.error).toMatch(/already been received/i);
    expect(out.key).not.toBe(KEY);
  });
});

describe('changeVendorAction', () => {
  const NEW_VENDOR = '33333333-3333-4333-8333-333333333333';

  it('sends the chosen vendor with the form key and says what stays', async () => {
    api.changePurchaseOrderVendor.mockResolvedValue({ ...currentOrder, vendorId: NEW_VENDOR });
    const out = await changeVendorAction(prev, form({ ...base, vendorId: NEW_VENDOR }));
    expect(api.changePurchaseOrderVendor).toHaveBeenCalledWith(
      expect.anything(),
      PO,
      NEW_VENDOR,
      KEY,
    );
    expect(out.done).toMatch(/vendor was changed/i);
    expect(out.done).toMatch(/payment terms/i);
    expect(out.error).toBeUndefined();
  });

  it('asks for a vendor before any API call', async () => {
    const out = await changeVendorAction(prev, form({ ...base, vendorId: '' }));
    expect(out.errors?.['vendorId']).toMatch(/choose a vendor/i);
    expect(out.key).toBe(KEY);
    expect(api.changePurchaseOrderVendor).not.toHaveBeenCalled();
  });

  it('shows the API message for an order that is no longer a draft, and rotates the key', async () => {
    api.changePurchaseOrderVendor.mockRejectedValue(apiError(409, 'PO_VENDOR_CHANGE_NOT_DRAFT'));
    const out = await changeVendorAction(prev, form({ ...base, vendorId: NEW_VENDOR }));
    expect(out.error).toBe('Cancel this order and create a new one');
    expect(out.key).not.toBe(KEY);
    expect(out.done).toBeUndefined();
  });

  it('words each vendor refusal for a vendor change, not for an issue', async () => {
    const cases: [string, RegExp][] = [
      ['PO_VENDOR_UNCHANGED', /already has this vendor/i],
      ['VENDOR_NOT_APPROVED', /cannot move to it/i],
      ['VENDOR_NOT_IN_ENTITY', /choose another vendor/i],
      ['VENDOR_NO_VERIFIED_BANK_ACCOUNT', /no verified bank account/i],
      ['PO_REFERENCED', /refer to this order, so its vendor cannot be changed/i],
    ];
    for (const [code, words] of cases) {
      api.changePurchaseOrderVendor.mockRejectedValue(apiError(409, code));
      const out = await changeVendorAction(prev, form({ ...base, vendorId: NEW_VENDOR }));
      expect(out.error).toMatch(words);
      expect(out.error).not.toMatch(/issued to it/i);
      // A draft cannot be cancelled: no refusal tells the person to cancel it.
      if (code === 'PO_REFERENCED') expect(out.error).not.toMatch(/cancel/i);
    }
  });

  it('refuses a person without procurement.po.issue before any API call', async () => {
    session.roles = ['warehouse'];
    const out = await changeVendorAction(prev, form({ ...base, vendorId: NEW_VENDOR }));
    expect(out.error).toMatch(/roles do not include/i);
    expect(api.changePurchaseOrderVendor).not.toHaveBeenCalled();
  });
});

describe('cancelAndRecreateAction', () => {
  const DRAFT = '44444444-4444-4444-8444-444444444444';

  it('needs a reason, then sends it with the key and opens the new draft', async () => {
    const none = await cancelAndRecreateAction(prev, form({ ...base, reason: ' ' }));
    expect(none.errors?.['reason']).toBeDefined();
    expect(api.cancelAndRecreatePurchaseOrder).not.toHaveBeenCalled();

    api.cancelAndRecreatePurchaseOrder.mockResolvedValue({ ...currentOrder, id: DRAFT });
    await expect(
      cancelAndRecreateAction(prev, form({ ...base, reason: 'Vendor failed' })),
    ).rejects.toThrow(`redirect /procurement/orders/${DRAFT}`);
    expect(api.cancelAndRecreatePurchaseOrder).toHaveBeenCalledWith(
      expect.anything(),
      PO,
      'Vendor failed',
      KEY,
    );
  });

  it('shows PO_HAS_RECEIPTS in words for recreate, stays on the page and rotates the key', async () => {
    api.cancelAndRecreatePurchaseOrder.mockRejectedValue(apiError(409, 'PO_HAS_RECEIPTS'));
    const out = await cancelAndRecreateAction(prev, form({ ...base, reason: 'x' }));
    expect(out.error).toMatch(/cannot be cancelled and raised again/i);
    expect(out.key).not.toBe(KEY);
  });

  it('keeps the key after a timeout, so a retry replays the first request', async () => {
    api.cancelAndRecreatePurchaseOrder.mockRejectedValue(new Error('socket hang up'));
    const out = await cancelAndRecreateAction(prev, form({ ...base, reason: 'x' }));
    expect(out.key).toBe(KEY);
    expect(out.error).toMatch(/did not respond/i);
  });
});
