import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));
const session = vi.hoisted(() => ({ roles: ['warehouse'] as string[] }));
vi.mock('@/lib/bff', () => ({
  requireStaffSession: () => Promise.resolve({ roles: session.roles }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));

const api = vi.hoisted(() => ({
  getPoProgress: vi.fn(),
  getReceipt: vi.fn(),
  createReceipt: vi.fn(),
  confirmReceipt: vi.fn(),
  reverseReceipt: vi.fn(),
  discardReceipt: vi.fn(),
}));
vi.mock('@/lib/api-purchase-orders', () => api);

const { confirmReceiptAction, createReceiptAction, reverseReceiptAction, discardReceiptAction } =
  await import('./actions');

const PO = '11111111-1111-4111-8111-111111111111';
const SERIAL = '22222222-2222-4222-8222-222222222221';
const PLAIN = '22222222-2222-4222-8222-222222222222';
const SERVICE = '22222222-2222-4222-8222-222222222223';
const RECEIPT = '33333333-3333-4333-8333-333333333333';
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

const progress = {
  purchaseOrderId: PO,
  number: 'PO-1',
  status: 'partially_received',
  lines: [
    ['1', SERIAL, 'goods', true, '6.0000', '1.0000'],
    ['2', PLAIN, 'goods', false, '10.0000', '0.0000'],
    ['3', SERVICE, 'service', false, '3.0000', '0.0000'],
  ].map(([n, id, kind, serials, open, pending]) => ({
    poLineId: id,
    lineNo: Number(n),
    kind,
    description: `Line ${n}`,
    uom: 'pcs',
    requiresSerials: serials,
    orderedQuantity: '10.0000',
    cancelledQuantity: '0.0000',
    receivedQuantity: '0.0000',
    pendingQuantity: pending,
    openQuantity: open,
    billedQuantity: '0.0000',
  })),
};

const createFields = {
  purchaseOrderId: PO,
  idempotencyKey: KEY,
  kind: 'goods',
  receivedAt: '2026-11-09',
  location: '',
  [`qty:${PLAIN}`]: '4',
};

const receipt = (over: Record<string, unknown> = {}) => ({
  id: RECEIPT,
  number: 'GRN-1',
  purchaseOrderId: PO,
  kind: 'goods',
  status: 'draft',
  reversesReceiptId: null,
  lines: [],
  ...over,
});

beforeEach(() => {
  session.roles = ['warehouse'];
  for (const fn of Object.values(api)) fn.mockReset();
  api.getPoProgress.mockResolvedValue(progress);
  api.getReceipt.mockResolvedValue(receipt());
});

describe('discard draft receipt', () => {
  it('uses the form key and explains that reserved quantities are released', async () => {
    api.discardReceipt.mockResolvedValue(receipt({ status: 'discarded' }));
    const out = await discardReceiptAction(prev, form({ receiptId: RECEIPT, idempotencyKey: KEY }));
    expect(api.discardReceipt).toHaveBeenCalledWith(expect.anything(), RECEIPT, KEY);
    expect(out.done).toMatch(/discarded/i);
    expect(out.done).toMatch(/quantities.*open/i);
  });
  it('denies an accountant for goods and retains the key after an uncertain result', async () => {
    session.roles = ['accountant'];
    expect(
      (await discardReceiptAction(prev, form({ receiptId: RECEIPT, idempotencyKey: KEY }))).error,
    ).toMatch(/warehouse/i);
    expect(api.discardReceipt).not.toHaveBeenCalled();
    session.roles = ['warehouse'];
    api.discardReceipt.mockRejectedValue(apiError(503, 'unavailable'));
    expect(
      (await discardReceiptAction(prev, form({ receiptId: RECEIPT, idempotencyKey: KEY }))).key,
    ).toBe(KEY);
  });
});

describe('createReceiptAction', () => {
  it('reads the order again, sends the body with the form key, then goes to the new receipt', async () => {
    api.createReceipt.mockResolvedValue(receipt());
    await expect(createReceiptAction(prev, form(createFields))).rejects.toThrow(
      `REDIRECT /procurement/receipts/${RECEIPT}?created=1`,
    );
    expect(api.getPoProgress).toHaveBeenCalledWith(expect.anything(), PO);
    expect(api.createReceipt).toHaveBeenCalledWith(
      expect.anything(),
      {
        purchaseOrderId: PO,
        kind: 'goods',
        receivedAt: '2026-11-09',
        lines: [{ poLineId: PLAIN, quantity: '4' }],
      },
      KEY,
    );
  });

  it('refuses a quantity over open minus pending without calling the API, and keeps the key', async () => {
    const out = await createReceiptAction(
      prev,
      form({ ...createFields, [`qty:${SERIAL}`]: '6', [`serials:${SERIAL}`]: 'a\nb\nc\nd\ne\nf' }),
    );
    expect(out.errors?.[`${SERIAL}.quantity`]).toMatch(/Only 5 pcs/);
    expect(out.key).toBe(KEY);
    expect(api.createReceipt).not.toHaveBeenCalled();
  });

  it('refuses a serial count that does not match, and a duplicate serial, before the API', async () => {
    const base = { ...createFields, [`qty:${SERIAL}`]: '2' };
    const short = await createReceiptAction(prev, form({ ...base, [`serials:${SERIAL}`]: 'a' }));
    expect(short.errors?.[`${SERIAL}.serials`]).toMatch(/Enter 2 serial numbers/);
    const twice = await createReceiptAction(prev, form({ ...base, [`serials:${SERIAL}`]: 'a\na' }));
    expect(twice.errors?.[`${SERIAL}.serials`]).toMatch(/different/);
    expect(api.createReceipt).not.toHaveBeenCalled();
  });

  it('ignores lines of the other kind', async () => {
    api.createReceipt.mockResolvedValue(receipt({ kind: 'service' }));
    await expect(
      createReceiptAction(
        prev,
        form({ ...createFields, kind: 'service', [`qty:${SERVICE}`]: '1', [`qty:${PLAIN}`]: '9' }),
      ),
    ).rejects.toThrow('REDIRECT');
    const sent = api.createReceipt.mock.calls[0]?.[1] as { lines: unknown } | undefined;
    expect(sent?.lines).toEqual([{ poLineId: SERVICE, quantity: '1' }]);
  });

  it('refuses goods without procurement.receipt.confirm before any API call, but lets a service through', async () => {
    session.roles = ['procurement'];
    const goods = await createReceiptAction(prev, form(createFields));
    expect(goods.error).toMatch(/for the warehouse/i);
    expect(api.getPoProgress).not.toHaveBeenCalled();
    expect(api.createReceipt).not.toHaveBeenCalled();

    api.createReceipt.mockResolvedValue(receipt({ kind: 'service' }));
    await expect(
      createReceiptAction(
        prev,
        form({ ...createFields, kind: 'service', [`qty:${SERVICE}`]: '1' }),
      ),
    ).rejects.toThrow('REDIRECT');
  });

  it('words the 403 of a service the person did not request', async () => {
    session.roles = ['sales'];
    api.createReceipt.mockRejectedValue(apiError(403, 'forbidden'));
    const out = await createReceiptAction(
      prev,
      form({ ...createFields, kind: 'service', [`qty:${SERVICE}`]: '1' }),
    );
    expect(out.error).toMatch(/raised the purchase request/i);
    expect(out.key).not.toBe(KEY);
  });

  it('rotates the key after a final answer and shows the 422 in plain words', async () => {
    api.createReceipt.mockRejectedValue(apiError(422, 'over_receipt'));
    const out = await createReceiptAction(prev, form(createFields));
    expect(out.error).toMatch(/more was entered than is still open/i);
    expect(out.reload).toBe(true);
    expect(out.key).not.toBe(KEY);
  });

  it('keeps the same key after a timeout, a 5xx, the in-progress 409 or a lost connection', async () => {
    for (const e of [
      apiError(503, 'x'),
      apiError(408, 'x'),
      apiError(409, 'conflict', { message: 'A request with this Idempotency-Key is in progress' }),
      new Error('socket hang up'),
    ]) {
      api.createReceipt.mockRejectedValue(e);
      expect((await createReceiptAction(prev, form(createFields))).key).toBe(KEY);
    }
  });

  it('replaces a key that is not ours, and refuses an id that is not a UUID', async () => {
    api.createReceipt.mockResolvedValue(receipt());
    await expect(
      createReceiptAction(prev, form({ ...createFields, idempotencyKey: 'x; drop table' })),
    ).rejects.toThrow('REDIRECT');
    expect(api.createReceipt.mock.calls[0]?.[2]).not.toBe('x; drop table');
    api.getPoProgress.mockClear();
    const out = await createReceiptAction(prev, form({ ...createFields, purchaseOrderId: '../x' }));
    expect(out.reload).toBe(true);
    expect(api.getPoProgress).not.toHaveBeenCalled();
  });

  it('words a progress read that fails', async () => {
    api.getPoProgress.mockRejectedValue(apiError(404, 'not_found'));
    const out = await createReceiptAction(prev, form(createFields));
    expect(out.error).toMatch(/could not find that purchase order or receipt/i);
    expect(api.createReceipt).not.toHaveBeenCalled();
  });
});

describe('confirmReceiptAction', () => {
  const fields = { receiptId: RECEIPT, idempotencyKey: KEY };

  it('sends the form key to the API and says it is done', async () => {
    api.confirmReceipt.mockResolvedValue(receipt({ status: 'confirmed' }));
    const out = await confirmReceiptAction(prev, form(fields));
    expect(api.confirmReceipt).toHaveBeenCalledWith(expect.anything(), RECEIPT, KEY);
    expect(out.done).toMatch(/confirmed/i);
    expect(out.key).not.toBe(KEY);
  });

  it('refuses a goods receipt without the grant before confirming, a service one goes through', async () => {
    session.roles = ['procurement'];
    const out = await confirmReceiptAction(prev, form(fields));
    expect(out.error).toMatch(/for the warehouse/i);
    expect(api.confirmReceipt).not.toHaveBeenCalled();

    api.getReceipt.mockResolvedValue(receipt({ kind: 'service' }));
    api.confirmReceipt.mockResolvedValue(receipt({ kind: 'service', status: 'confirmed' }));
    expect((await confirmReceiptAction(prev, form(fields))).done).toMatch(/confirmed/i);
  });

  it('does not look at the status itself, so a replay of a landed request reaches the API', async () => {
    api.getReceipt.mockResolvedValue(receipt({ status: 'confirmed' }));
    api.confirmReceipt.mockResolvedValue(receipt({ status: 'confirmed' }));
    expect((await confirmReceiptAction(prev, form(fields))).done).toBeDefined();
    expect(api.confirmReceipt).toHaveBeenCalledTimes(1);
  });

  it('words invalid_transition with a reload, and the 422 a late short-close causes', async () => {
    api.confirmReceipt.mockRejectedValue(apiError(409, 'invalid_transition'));
    const moved = await confirmReceiptAction(prev, form(fields));
    expect(moved.error).toMatch(/can no longer be confirmed/i);
    expect(moved.reload).toBe(true);
    expect(moved.key).not.toBe(KEY);

    api.confirmReceipt.mockRejectedValue(apiError(422, 'over_receipt'));
    expect((await confirmReceiptAction(prev, form(fields))).error).toMatch(/still open/i);
  });

  it('keeps the key after an unknown outcome, and refuses an id that is not a UUID', async () => {
    api.confirmReceipt.mockRejectedValue(apiError(503, 'x'));
    expect((await confirmReceiptAction(prev, form(fields))).key).toBe(KEY);
    api.getReceipt.mockClear();
    const out = await confirmReceiptAction(prev, form({ ...fields, receiptId: 'nope' }));
    expect(out.reload).toBe(true);
    expect(api.getReceipt).not.toHaveBeenCalled();
  });
});

describe('reverseReceiptAction', () => {
  const fields = { receiptId: RECEIPT, idempotencyKey: KEY, reason: 'Wrong delivery note' };

  it('needs a reason, then sends it with the key and names the reversal', async () => {
    const none = await reverseReceiptAction(prev, form({ ...fields, reason: '   ' }));
    expect(none.errors?.['reason']).toBeDefined();
    expect(none.key).toBe(KEY);
    expect(api.reverseReceipt).not.toHaveBeenCalled();

    api.getReceipt.mockResolvedValue(receipt({ status: 'confirmed' }));
    api.reverseReceipt.mockResolvedValue(receipt({ number: 'GRN-2' }));
    const out = await reverseReceiptAction(prev, form(fields));
    expect(api.reverseReceipt).toHaveBeenCalledWith(
      expect.anything(),
      RECEIPT,
      'Wrong delivery note',
      KEY,
    );
    expect(out.done).toMatch(/reversed.*GRN-2/i);
  });

  it('refuses goods without the grant before any write, and words a reversal of a reversal', async () => {
    session.roles = ['accountant'];
    expect((await reverseReceiptAction(prev, form(fields))).error).toMatch(/for the warehouse/i);
    expect(api.reverseReceipt).not.toHaveBeenCalled();

    session.roles = ['warehouse'];
    api.reverseReceipt.mockRejectedValue(apiError(409, 'invalid_transition'));
    const out = await reverseReceiptAction(prev, form(fields));
    expect(out.error).toMatch(/cannot be reversed/i);
    expect(out.reload).toBe(true);
  });
});
