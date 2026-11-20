import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

import { ID, KEY } from '../_lib/test-fixtures';

import {
  discardInvoiceAction,
  issueInvoiceAction,
  submitInvoiceAction,
  type InvoiceActionState,
} from './actions';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({ requireStaffSession: vi.fn(), apiFetch: vi.fn() }));
vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: mocks.apiFetch,
}));

const prev: InvoiceActionState = { key: KEY };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function form(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.append(k, v);
  return f;
}

const base = (over: Record<string, string> = {}) => ({
  invoiceId: ID,
  expectedVersion: '4',
  idempotencyKey: KEY,
  ...over,
});

function answer(status: number, body: unknown = {}) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

const call = () => mocks.apiFetch.mock.calls[0] as [unknown, string, RequestInit];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireStaffSession.mockResolvedValue({ accessToken: 't' });
  mocks.apiFetch.mockImplementation(() => answer(200));
});

describe('submitInvoiceAction', () => {
  it('posts the version row and the page key, and says it is done', async () => {
    const state = await submitInvoiceAction(prev, form(base()));
    expect(state).toEqual({ key: KEY, done: true, message: 'Submitted for approval.' });
    const [, path, init] = call();
    expect(path).toBe(`/v1/invoices/${ID}/submit`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['idempotency-key']).toBe(KEY);
    expect(JSON.parse(init.body as string)).toEqual({ expectedVersion: 4 });
  });

  it('explains a 422 as "nobody can approve" and rotates the key (a final answer)', async () => {
    mocks.apiFetch.mockImplementation(() => answer(422, { error: { code: 'no_approver' } }));
    const state = await submitInvoiceAction(prev, form(base()));
    expect(state.error).toMatch(/no one can approve/i);
    expect(state.key).not.toBe(KEY);
    expect(state.key).toMatch(UUID);
    expect(state.done).toBeUndefined();
  });

  it('asks for a reload when the row version moved (an unknown 409)', async () => {
    mocks.apiFetch.mockImplementation(() => answer(409, { error: { code: 'conflict' } }));
    const state = await submitInvoiceAction(prev, form(base()));
    expect(state.reload).toBe(true);
    expect(state.key).not.toBe(KEY);
  });

  it('shows the no-access words for a 403', async () => {
    mocks.apiFetch.mockImplementation(() => answer(403, { error: { code: 'forbidden' } }));
    const state = await submitInvoiceAction(prev, form(base()));
    expect(state.error).toBeTruthy();
    expect(state.done).toBeUndefined();
  });
});

describe('issueInvoiceAction', () => {
  it('reports a first issue with the number the server set', async () => {
    mocks.apiFetch.mockImplementation(() =>
      answer(200, { kind: 'issued', invoiceId: ID, number: 'INV-2083/84-00001' }),
    );
    const state = await issueInvoiceAction(prev, form(base()));
    expect(state).toEqual({ key: KEY, done: true, message: 'Issued as INV-2083/84-00001.' });
    const [, path, init] = call();
    expect(path).toBe(`/v1/invoices/${ID}/issue`);
    expect(JSON.parse(init.body as string)).toEqual({ expectedVersion: 4 });
  });

  it('treats already_issued as a success with its own words, not an error', async () => {
    mocks.apiFetch.mockImplementation(() =>
      answer(200, { kind: 'already_issued', invoiceId: ID, number: 'INV-2083/84-00001' }),
    );
    const state = await issueInvoiceAction(prev, form(base()));
    expect(state.done).toBe(true);
    expect(state.error).toBeUndefined();
    expect(state.message).toBe('Already issued as INV-2083/84-00001. Nothing changed.');
  });

  it('names the currency and the date of a stale exchange rate (409 fx_rate_stale)', async () => {
    mocks.apiFetch.mockImplementation(() =>
      answer(409, {
        error: {
          code: 'fx_rate_stale',
          details: { currency: 'USD', rateDate: '2026-11-01', maxAgeDays: 3 },
        },
      }),
    );
    const state = await issueInvoiceAction(prev, form(base()));
    expect(state.error).toContain('USD');
    expect(state.error).toContain('2026-11-01');
    expect(state.error).toContain('3 days');
    expect(state.error).toMatch(/Finance/);
    expect(state.done).toBeUndefined();
    expect(state.key).not.toBe(KEY);
  });

  it('says a stale rate even when the API sends no details, and echoes nothing odd', async () => {
    mocks.apiFetch.mockImplementation(() =>
      answer(409, {
        error: {
          code: 'fx_rate_stale',
          details: { currency: '<script>', rateDate: 'yesterday', maxAgeDays: 'many' },
        },
      }),
    );
    const state = await issueInvoiceAction(prev, form(base()));
    expect(state.error).toMatch(/exchange rate/i);
    expect(state.error).not.toContain('script');
    expect(state.error).not.toContain('yesterday');
  });

  it('offers a reload when the invoice is not approved yet (409 NOT_APPROVED)', async () => {
    mocks.apiFetch.mockImplementation(() => answer(409, { error: { code: 'NOT_APPROVED' } }));
    const state = await issueInvoiceAction(prev, form(base()));
    expect(state.error).toMatch(/not approved yet/i);
    expect(state.reload).toBe(true);
  });

  it('says the due date has passed (422 DUE_DATE_BEFORE_ISSUE), never that the invoice changed', async () => {
    mocks.apiFetch.mockImplementation(() =>
      answer(422, {
        error: {
          code: 'DUE_DATE_BEFORE_ISSUE',
          message: 'The due date is before the issue date',
          correlationId: 'c',
          details: { dueDate: '2026-11-09', issueDate: '2026-11-12' },
        },
      }),
    );
    const state = await issueInvoiceAction(prev, form(base()));
    expect(state.error).toBe(
      'The due date (09 Nov 2026) is before today, so this invoice cannot be issued. An invoice is issued with a due date of today or later.',
    );
    expect(state.error).not.toMatch(/changed|reload/i);
    expect(state.reload).toBeUndefined();
  });

  it('leaves out a due date that is not a plain date', async () => {
    mocks.apiFetch.mockImplementation(() =>
      answer(422, {
        error: {
          code: 'DUE_DATE_BEFORE_ISSUE',
          message: 'm',
          correlationId: 'c',
          details: { dueDate: '<b>soon</b>' },
        },
      }),
    );
    const state = await issueInvoiceAction(prev, form(base()));
    expect(state.error).toMatch(/^The due date is before today/);
  });

  it('explains a fiscal year mismatch (409 PERIOD_FY_MISMATCH)', async () => {
    mocks.apiFetch.mockImplementation(() => answer(409, { error: { code: 'PERIOD_FY_MISMATCH' } }));
    const state = await issueInvoiceAction(prev, form(base()));
    expect(state.error).toMatch(/fiscal year/i);
  });

  it('keeps the same key while the first request is still being processed (in-progress 409)', async () => {
    mocks.apiFetch.mockImplementation(() =>
      answer(409, {
        error: {
          code: 'conflict',
          message: 'A request with this Idempotency-Key is still being processed.',
        },
      }),
    );
    const state = await issueInvoiceAction(prev, form(base()));
    expect(state.key).toBe(KEY);
    expect(state.error).toMatch(/still being processed/i);
  });

  it('keeps the key after a 5xx, because the first call may have landed', async () => {
    mocks.apiFetch.mockImplementation(() => answer(500, { error: { code: 'internal' } }));
    const state = await issueInvoiceAction(prev, form(base()));
    expect(state.key).toBe(KEY);
    expect(state.error).toBeTruthy();
  });

  it('keeps the key after a network failure', async () => {
    mocks.apiFetch.mockRejectedValue(new TypeError('fetch failed'));
    const state = await issueInvoiceAction(prev, form(base()));
    expect(state.key).toBe(KEY);
    expect(state.error).toBeTruthy();
  });

  it('rotates the key after a final 4xx, so the next click is a new decision', async () => {
    mocks.apiFetch.mockImplementation(() =>
      answer(422, { error: { code: 'evidence_policy_unmet' } }),
    );
    const state = await issueInvoiceAction(prev, form(base()));
    expect(state.key).not.toBe(KEY);
    expect(state.key).toMatch(UUID);
  });

  it('sends the same key again on a retry after an unknown outcome', async () => {
    mocks.apiFetch.mockImplementationOnce(() => answer(500, {}));
    const first = await issueInvoiceAction(prev, form(base()));
    mocks.apiFetch.mockImplementationOnce(() =>
      answer(200, { kind: 'already_issued', invoiceId: ID, number: 'INV-2083/84-00001' }),
    );
    const second = await issueInvoiceAction(first, form(base({ idempotencyKey: first.key })));
    const keys = mocks.apiFetch.mock.calls.map(
      (c) => ((c[2] as RequestInit).headers as Record<string, string>)['idempotency-key'],
    );
    expect(keys).toEqual([KEY, KEY]);
    expect(second.done).toBe(true);
  });

  it('refuses an answer that breaks the contract instead of showing "undefined"', async () => {
    mocks.apiFetch.mockImplementation(() => answer(200, { kind: 'issued' }));
    const state = await issueInvoiceAction(prev, form(base()));
    expect(state.done).toBeUndefined();
    expect(state.error).toBeTruthy();
  });
});

describe('discardInvoiceAction', () => {
  it('posts the trimmed reason with the version', async () => {
    const state = await discardInvoiceAction(prev, form(base({ reason: '  Raised twice  ' })));
    expect(state).toEqual({ key: KEY, done: true, message: 'Discarded.' });
    const [, path, init] = call();
    expect(path).toBe(`/v1/invoices/${ID}/discard`);
    expect(JSON.parse(init.body as string)).toEqual({ expectedVersion: 4, reason: 'Raised twice' });
  });

  it.each(['', '   \n '])('never calls the API for an empty reason (%j)', async (reason) => {
    const state = await discardInvoiceAction(prev, form(base({ reason })));
    expect(state.errors?.reason).toMatch(/say why/i);
    expect(state.key).toBe(KEY);
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it('never calls the API for a reason over 1000 characters', async () => {
    const state = await discardInvoiceAction(prev, form(base({ reason: 'x'.repeat(1001) })));
    expect(state.errors?.reason).toMatch(/1000/);
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });
});

describe('every action', () => {
  const actions = [submitInvoiceAction, issueInvoiceAction, discardInvoiceAction];

  it.each([
    ['an id that is not a UUID', { invoiceId: '../admin' }],
    ['no version', { expectedVersion: '' }],
    ['a version of zero', { expectedVersion: '0' }],
    ['a version that is not a number', { expectedVersion: '4; drop' }],
  ])('refuses %s without reaching the API', async (_name, over) => {
    for (const action of actions) {
      const state = await action(prev, form(base({ reason: 'ok', ...over })));
      expect(state.reload).toBe(true);
      expect(state.error).toMatch(/incomplete/i);
    }
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it('replaces a key that is not ours with a fresh one', async () => {
    await issueInvoiceAction(prev, form(base({ idempotencyKey: 'x y; z' })));
    const [, , init] = call();
    const sent = (init.headers as Record<string, string>)['idempotency-key'];
    expect(sent).not.toBe('x y; z');
    expect(sent).toMatch(UUID);
  });

  it('never prints the access token', async () => {
    mocks.apiFetch.mockImplementation(() => Promise.reject(new ApiError(500, 'eyJ.secret.sig')));
    const state = await issueInvoiceAction(prev, form(base()));
    expect(JSON.stringify(state)).not.toContain('eyJ.secret.sig');
  });
});
