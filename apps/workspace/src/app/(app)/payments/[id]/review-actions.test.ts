import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PAYMENT_ID } from '../_lib/fixtures';

import { rejectAction, reverseAction, verifyAction, type ReviewState } from './review-actions';

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
const prev: ReviewState = { key: KEY };

function form(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.append(k, v);
  return f;
}
const base = { paymentId: PAYMENT_ID, idempotencyKey: KEY, expectedVersion: '3' };

function answer(status: number, body: unknown = {}) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}
const sentHeaders = (n: number) =>
  (mocks.apiFetch.mock.calls[n] as [unknown, string, RequestInit])[2].headers as Record<
    string,
    string
  >;

/** A valid payment body, so the real client parses a 2xx. */
async function okBody() {
  const { verifiedPayment } = await import('../_lib/fixtures');
  return verifiedPayment();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireStaffSession.mockResolvedValue({ accessToken: 't' });
});

describe('verifyAction', () => {
  it('posts the verify with the page key and the version the person saw', async () => {
    mocks.apiFetch.mockImplementation(async () => answer(200, await okBody()));
    const state = await verifyAction(prev, form(base));
    expect(state).toEqual({ key: KEY, done: true });
    const [, path, init] = mocks.apiFetch.mock.calls[0] as [unknown, string, RequestInit];
    expect(path).toBe(`/v1/payments/${PAYMENT_ID}/verify`);
    expect(init.method).toBe('POST');
    expect(sentHeaders(0)['idempotency-key']).toBe(KEY);
    expect(JSON.parse(init.body as string)).toEqual({ expectedVersion: 3 });
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/payments/${PAYMENT_ID}`);
  });

  it('shows the self-verification refusal plainly and takes a new key', async () => {
    mocks.apiFetch.mockImplementation(() =>
      answer(403, {
        error: {
          code: 'forbidden',
          reason: 'separation_of_duties',
          message: 'x',
          correlationId: 'c',
        },
      }),
    );
    const state = await verifyAction(prev, form(base));
    expect(state.error).toMatch(/you recorded this payment/i);
    expect(state.done).toBeUndefined();
    expect(state.key).not.toBe(KEY);
  });

  it('keeps the key after a timeout or 5xx, and sends it again on the retry', async () => {
    mocks.apiFetch.mockImplementationOnce(() => answer(503));
    const first = await verifyAction(prev, form(base));
    expect(first.key).toBe(KEY);
    expect(first.error).toMatch(/did not respond/i);
    mocks.apiFetch.mockImplementationOnce(async () => answer(200, await okBody()));
    await verifyAction(first, form({ ...base, idempotencyKey: first.key }));
    expect(sentHeaders(1)['idempotency-key']).toBe(sentHeaders(0)['idempotency-key']);
  });

  it('keeps the key on the 409 that says the first request is still being processed', async () => {
    mocks.apiFetch.mockImplementation(() =>
      answer(409, {
        error: {
          code: 'conflict',
          message: 'A request with this Idempotency-Key is still in progress',
          correlationId: 'c',
        },
      }),
    );
    const state = await verifyAction(prev, form(base));
    expect(state.key).toBe(KEY);
    expect(state.reload).toBeUndefined();
  });

  it('asks for a reload on a stale version and takes a new key', async () => {
    mocks.apiFetch.mockImplementation(() =>
      answer(409, { error: { code: 'conflict', message: 'x', correlationId: 'c' } }),
    );
    const state = await verifyAction(prev, form(base));
    expect(state.reload).toBe(true);
    expect(state.key).not.toBe(KEY);
  });

  it('replaces a tampered key and refuses a bad id without calling the API', async () => {
    mocks.apiFetch.mockImplementation(async () => answer(200, await okBody()));
    const state = await verifyAction(prev, form({ ...base, idempotencyKey: 'x' }));
    expect(state.key).not.toBe('x');
    expect(sentHeaders(0)['idempotency-key']).toBe(state.key);

    mocks.apiFetch.mockClear();
    const bad = await verifyAction(prev, form({ ...base, paymentId: 'nope' }));
    expect(bad.reload).toBe(true);
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it('refuses a missing version without calling the API', async () => {
    const state = await verifyAction(prev, form({ paymentId: PAYMENT_ID, idempotencyKey: KEY }));
    expect(state.reload).toBe(true);
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });
});

describe('rejectAction and reverseAction', () => {
  it('refuses an empty reason in place, without calling the API, keeping the unused key', async () => {
    const state = await rejectAction(prev, form({ ...base, reason: '   ' }));
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(state.key).toBe(KEY);
    expect(state.errors?.reason).toMatch(/reason/i);
  });

  it('refuses a reason over 1000 characters', async () => {
    const state = await reverseAction(prev, form({ ...base, reason: 'x'.repeat(1001) }));
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(state.errors?.reason).toMatch(/1,?000/);
  });

  it('posts the trimmed reason', async () => {
    mocks.apiFetch.mockImplementation(async () => answer(200, await okBody()));
    expect(await rejectAction(prev, form({ ...base, reason: '  Slip unreadable ' }))).toEqual({
      key: KEY,
      done: true,
    });
    const [, path, init] = mocks.apiFetch.mock.calls[0] as [unknown, string, RequestInit];
    expect(path).toBe(`/v1/payments/${PAYMENT_ID}/reject`);
    expect(JSON.parse(init.body as string)).toEqual({
      expectedVersion: 3,
      reason: 'Slip unreadable',
    });

    await reverseAction(prev, form({ ...base, reason: 'Cheque bounced' }));
    expect((mocks.apiFetch.mock.calls[1] as [unknown, string])[1]).toBe(
      `/v1/payments/${PAYMENT_ID}/reverse`,
    );
  });
});
