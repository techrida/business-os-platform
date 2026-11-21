import { PaymentPromiseDtoSchema } from '@bos/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ID, KEY } from '../_lib/test-fixtures';

import { recordPromiseAction, type PromiseActionState } from './promise-actions';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({ requireStaffSession: vi.fn(), apiFetch: vi.fn() }));
vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: mocks.apiFetch,
}));

const prev: PromiseActionState = { key: KEY };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TODAY = '2026-11-21';

function form(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.append(k, v);
  return f;
}

const base = (over: Record<string, string> = {}) => ({
  invoiceId: ID,
  idempotencyKey: KEY,
  promisedDate: '2026-12-01',
  note: '',
  ...over,
});

function answer(status: number, body: unknown = {}) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

/** The 201 body the API answers, checked against the contract. */
const recorded = PaymentPromiseDtoSchema.parse({
  id: '99999999-9999-4999-8999-999999999999',
  invoiceId: ID,
  promisedDate: '2026-12-01',
  note: null,
  status: 'open',
  recordedByUserId: '55555555-5555-4555-8555-555555555555',
  missedAt: null,
  collectionActivityId: null,
  createdAt: '2026-11-21T06:00:00.000Z',
});

const call = () => mocks.apiFetch.mock.calls[0] as [unknown, string, RequestInit];

beforeEach(() => {
  vi.clearAllMocks();
  // 11:45 in Kathmandu on 21 November.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-21T06:00:00.000Z'));
  mocks.requireStaffSession.mockResolvedValue({ accessToken: 't' });
  mocks.apiFetch.mockImplementation(() => answer(201, recorded));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('recordPromiseAction', () => {
  it('posts the day with the page key, leaves a blank note out, and says it is done', async () => {
    const state = await recordPromiseAction(prev, form(base()));
    expect(state).toEqual({ key: KEY, done: true, message: 'Promise to pay recorded.' });
    const [, path, init] = call();
    expect(path).toBe(`/v1/receivables/invoices/${ID}/promises`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['idempotency-key']).toBe(KEY);
    expect(JSON.parse(init.body as string)).toEqual({ promisedDate: '2026-12-01' });
  });

  it('sends the trimmed note, and accepts today as the promised day', async () => {
    await recordPromiseAction(
      prev,
      form(base({ promisedDate: TODAY, note: '  After the sale  ' })),
    );
    expect(JSON.parse(call()[2].body as string)).toEqual({
      promisedDate: TODAY,
      note: 'After the sale',
    });
  });

  it('refuses a day before today in Kathmandu without calling the API, keeping the key', async () => {
    const state = await recordPromiseAction(prev, form(base({ promisedDate: '2026-11-20' })));
    expect(state).toEqual({ key: KEY, errors: { promisedDate: 'Choose today or a later date.' } });
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it('refuses a missing or impossible day and an overlong note without calling the API', async () => {
    const state = await recordPromiseAction(
      prev,
      form(base({ promisedDate: '2026-02-30', note: 'x'.repeat(1001) })),
    );
    expect(state.errors?.promisedDate).toMatch(/choose the date/i);
    expect(state.errors?.note).toMatch(/under 1000/);
    expect(
      (await recordPromiseAction(prev, form(base({ promisedDate: '' })))).errors,
    ).toBeDefined();
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it('asks for a reload when the form lost its invoice id', async () => {
    const state = await recordPromiseAction(prev, form(base({ invoiceId: 'nope' })));
    expect(state).toMatchObject({ key: KEY, reload: true });
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it('words a 409 invoice_not_open and offers a reload, rotating the key (a final answer)', async () => {
    mocks.apiFetch.mockImplementation(() => answer(409, { error: { code: 'invoice_not_open' } }));
    const state = await recordPromiseAction(prev, form(base()));
    expect(state.error).toMatch(/nothing is owed/i);
    expect(state.reload).toBe(true);
    expect(state.key).not.toBe(KEY);
    expect(state.key).toMatch(UUID);
  });

  it('words a 409 promise_open as someone recording at the same time', async () => {
    mocks.apiFetch.mockImplementation(() => answer(409, { error: { code: 'promise_open' } }));
    const state = await recordPromiseAction(prev, form(base()));
    expect(state.error).toMatch(/at the same time/i);
    expect(state.reload).toBe(true);
  });

  it('puts a 400 (the day passed since the dialog opened) on the date field', async () => {
    mocks.apiFetch.mockImplementation(() => answer(400, { error: { code: 'bad_request' } }));
    const state = await recordPromiseAction(prev, form(base()));
    expect(state.errors).toEqual({ promisedDate: 'Choose today or a later date.' });
  });

  it('says a 403 plainly', async () => {
    mocks.apiFetch.mockImplementation(() =>
      answer(403, { error: { code: 'forbidden', reason: 'no_permission' } }),
    );
    expect((await recordPromiseAction(prev, form(base()))).error).toMatch(/your roles/i);
  });

  it('keeps the key after an unknown outcome, so a retry records one promise', async () => {
    mocks.apiFetch.mockImplementation(() => answer(503));
    const state = await recordPromiseAction(prev, form(base()));
    expect(state.key).toBe(KEY);
    expect(state.error).toBeTruthy();
    expect(state.done).toBeUndefined();
  });
});
