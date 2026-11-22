import { beforeEach, describe, expect, it, vi } from 'vitest';

import { allocationRow, INVOICE_ID, PAYMENT_ID } from '../_lib/fixtures';
import {
  MISMATCHED_ITEMS_MESSAGE,
  OVER_ALLOCATION_MESSAGE,
  UNAVAILABLE_MESSAGE,
} from '../_lib/failure';

import { allocateAction, deallocateAction, type AllocateState } from './allocate-actions';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireStaffSession: vi.fn(),
  apiFetch: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: mocks.apiFetch,
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

const KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INVOICE_2 = '99999999-9999-4999-8999-999999999999';
const ALLOCATION_ID = '77777777-7777-4777-8777-777777777777';
const prev: AllocateState = { key: KEY };

function form(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.append(k, v);
  return f;
}
const base = { paymentId: PAYMENT_ID, idempotencyKey: KEY };
const one = { ...base, [`amount:${INVOICE_ID}`]: '500000.00' };

function answer(status: number, body: unknown = {}) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}
const call = (n: number) => mocks.apiFetch.mock.calls[n] as [unknown, string, RequestInit];
const sentKey = (n: number) => (call(n)[2].headers as Record<string, string>)['idempotency-key'];
const sentBody = (n: number) => JSON.parse(call(n)[2].body as string) as unknown;

const conflict = (code: string, message = 'x') =>
  answer(409, { error: { code, message, correlationId: 'c' } });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireStaffSession.mockResolvedValue({ accessToken: 't' });
});

describe('allocateAction', () => {
  it('posts only the lines that have an amount, with the page key', async () => {
    mocks.apiFetch.mockImplementation(() => answer(200, [allocationRow()]));
    const state = await allocateAction(
      prev,
      form({ ...one, [`amount:${INVOICE_2}`]: '   ', ignored: 'x' }),
    );
    expect(state.done).toBe(true);
    const [, path, init] = call(0);
    expect(path).toBe(`/v1/payments/${PAYMENT_ID}/allocations`);
    expect(init.method).toBe('POST');
    expect(sentKey(0)).toBe(KEY);
    // The padded "500000.00" goes as a hydrated box posts it (R5 EF2).
    expect(sentBody(0)).toEqual({ lines: [{ invoiceId: INVOICE_ID, amount: '500000' }] });
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/payments/${PAYMENT_ID}`);
  });

  it.each([
    ['1,500.00', '1500'],
    ['10.50', '10.5'],
    ['12,50,000.00', '1250000'],
  ])(
    'sends grouped or padded %s exactly as the plain %s, so a retry before hydration is the same request (R5 EF2)',
    async (typed, plain) => {
      mocks.apiFetch.mockImplementation(() => answer(200, [allocationRow()]));
      await allocateAction(prev, form({ ...base, [`amount:${INVOICE_ID}`]: typed }));
      await allocateAction(prev, form({ ...base, [`amount:${INVOICE_ID}`]: plain }));
      expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
      expect(sentBody(0)).toEqual({ lines: [{ invoiceId: INVOICE_ID, amount: plain }] });
      expect(sentBody(0)).toEqual(sentBody(1));
    },
  );

  it('takes a new key once the allocation is accepted, so the next one is a new request', async () => {
    mocks.apiFetch.mockImplementation(() => answer(200, [allocationRow()]));
    const state = await allocateAction(prev, form(one));
    expect(state.done).toBe(true);
    expect(state.key).not.toBe(KEY);
  });

  it('does not add or compare amounts: several lines go as typed', async () => {
    mocks.apiFetch.mockImplementation(() => answer(200, [allocationRow()]));
    await allocateAction(prev, form({ ...one, [`amount:${INVOICE_2}`]: '9999999.5' }));
    expect(sentBody(0)).toEqual({
      lines: [
        { invoiceId: INVOICE_ID, amount: '500000' },
        { invoiceId: INVOICE_2, amount: '9999999.5' },
      ],
    });
  });

  it('refuses an empty form in place, without calling the API, keeping the unused key', async () => {
    const state = await allocateAction(prev, form({ ...base, [`amount:${INVOICE_ID}`]: '' }));
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(state.key).toBe(KEY);
    expect(state.errors?.form).toMatch(/at least one invoice/i);
  });

  // "1,500" is grouping and now goes as 1500 (R5 EF2); "1,5" and "10,50" are decimal commas and stay refused.
  it.each(['0', '0.00', '-5', '12.345', '1,5', '10,50', 'abc', '1e3', '.5'])(
    'refuses %s as an amount, names the invoice and keeps the key',
    async (bad) => {
      const state = await allocateAction(
        prev,
        form({ ...base, [`amount:${INVOICE_ID}`]: bad, [`amount:${INVOICE_2}`]: '10.00' }),
      );
      expect(mocks.apiFetch).not.toHaveBeenCalled();
      expect(state.key).toBe(KEY);
      expect(state.errors?.lines?.[INVOICE_ID]).toMatch(/positive number with up to 2 decimals/i);
      expect(state.errors?.lines?.[INVOICE_2]).toBeUndefined();
    },
  );

  it('names the space in "10 50" instead of the generic amount message', async () => {
    const state = await allocateAction(prev, form({ ...base, [`amount:${INVOICE_ID}`]: '10 50' }));
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    // Old code said "Enter a positive number with up to 2 decimals", which the digits seem to satisfy.
    expect(state.errors?.lines?.[INVOICE_ID]).toBe('Remove the space inside the number.');
  });

  it('asks for a reload on a broken form (bad payment id or an invoice id that is not one)', async () => {
    const badPayment = await allocateAction(prev, form({ ...one, paymentId: 'nope' }));
    expect(badPayment.reload).toBe(true);
    const badInvoice = await allocateAction(prev, form({ ...base, 'amount:../../x': '5.00' }));
    expect(badInvoice.reload).toBe(true);
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it('shows the over-allocation wording and takes a new key (a final answer)', async () => {
    mocks.apiFetch.mockImplementation(() => conflict('OVER_ALLOCATION'));
    const state = await allocateAction(prev, form(one));
    expect(state.error).toBe(OVER_ALLOCATION_MESSAGE);
    expect(state.done).toBeUndefined();
    expect(state.key).not.toBe(KEY);
    expect(state.reload).toBeUndefined();
  });

  it('shows the mismatched-items wording and takes a new key', async () => {
    mocks.apiFetch.mockImplementation(() =>
      answer(422, { error: { code: 'MISMATCHED_ITEMS', message: 'x', correlationId: 'c' } }),
    );
    const state = await allocateAction(prev, form(one));
    expect(state.error).toBe(MISMATCHED_ITEMS_MESSAGE);
    expect(state.key).not.toBe(KEY);
  });

  it('keeps the key after a 5xx and sends it again on the retry', async () => {
    mocks.apiFetch.mockImplementationOnce(() => answer(503));
    const first = await allocateAction(prev, form(one));
    expect(first.key).toBe(KEY);
    expect(first.error).toBe(UNAVAILABLE_MESSAGE);
    mocks.apiFetch.mockImplementationOnce(() => answer(200, [allocationRow()]));
    await allocateAction(first, form({ ...one, idempotencyKey: first.key }));
    expect(sentKey(1)).toBe(sentKey(0));
  });

  it('keeps the key on the 409 that says the first request is still being processed', async () => {
    mocks.apiFetch.mockImplementation(() =>
      conflict('conflict', 'A request with this Idempotency-Key is still in progress'),
    );
    const state = await allocateAction(prev, form(one));
    expect(state.key).toBe(KEY);
    expect(state.reload).toBeUndefined();
  });

  it('refuses the person without the allocate role, in words, with a new key', async () => {
    mocks.apiFetch.mockImplementation(() =>
      answer(403, {
        error: { code: 'forbidden', reason: 'no_permission', message: 'x', correlationId: 'c' },
      }),
    );
    const state = await allocateAction(prev, form(one));
    expect(state.error).toMatch(/roles don't allow this/i);
    expect(state.key).not.toBe(KEY);
  });

  it('replaces a tampered key', async () => {
    mocks.apiFetch.mockImplementation(() => answer(200, [allocationRow()]));
    await allocateAction(prev, form({ ...one, idempotencyKey: 'x' }));
    expect(sentKey(0)).not.toBe('x');
    expect(sentKey(0)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('deallocateAction', () => {
  const reversal = allocationRow({
    id: '88888888-8888-4888-8888-888888888880',
    amount: '-750000.00',
    reversesAllocationId: ALLOCATION_ID,
    reason: 'Wrong invoice',
  });
  const dealloc = { ...base, allocationId: ALLOCATION_ID, reason: '  Wrong invoice ' };

  it('posts the trimmed reason, and only the reason, to the reversal route', async () => {
    mocks.apiFetch.mockImplementation(() => answer(200, reversal));
    const state = await deallocateAction(prev, form(dealloc));
    expect(state).toEqual({ key: KEY, done: true });
    const [, path, init] = call(0);
    expect(path).toBe(`/v1/payments/${PAYMENT_ID}/allocations/${ALLOCATION_ID}/reverse`);
    expect(init.method).toBe('POST');
    expect(sentKey(0)).toBe(KEY);
    expect(sentBody(0)).toEqual({ reason: 'Wrong invoice' });
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/payments/${PAYMENT_ID}`);
  });

  it('requires a reason: nothing goes to the API and the unused key is kept', async () => {
    const state = await deallocateAction(prev, form({ ...dealloc, reason: '   ' }));
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(state.key).toBe(KEY);
    expect(state.errors?.reason).toMatch(/say why/i);
  });

  it('refuses a reason over 1000 characters', async () => {
    const state = await deallocateAction(prev, form({ ...dealloc, reason: 'x'.repeat(1001) }));
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(state.errors?.reason).toMatch(/1,?000/);
  });

  it('asks for a reload when an id is wrong, without calling the API', async () => {
    const state = await deallocateAction(prev, form({ ...dealloc, allocationId: '../x' }));
    expect(state.reload).toBe(true);
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it('keeps the key after a timeout and sends it again; a final refusal takes a new one', async () => {
    mocks.apiFetch.mockImplementationOnce(() => answer(503));
    const first = await deallocateAction(prev, form(dealloc));
    expect(first.key).toBe(KEY);
    mocks.apiFetch.mockImplementationOnce(() => answer(200, reversal));
    await deallocateAction(first, form({ ...dealloc, idempotencyKey: first.key }));
    expect(sentKey(1)).toBe(sentKey(0));

    mocks.apiFetch.mockImplementationOnce(() => conflict('conflict', 'stale'));
    const stale = await deallocateAction(prev, form(dealloc));
    expect(stale.reload).toBe(true);
    expect(stale.key).not.toBe(KEY);
  });
});
