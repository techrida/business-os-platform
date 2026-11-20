import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

import {
  cancelAction,
  confirmEvidenceAction,
  outcomeAction,
  reviseAction,
  sendAction,
  type ActionState,
} from './actions';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireStaffSession: vi.fn(),
  apiFetch: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
}));

vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: mocks.apiFetch,
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));

const Q = '11111111-1111-4111-8111-111111111111';
const V = '22222222-2222-4222-8222-222222222222';
const CONTACT = '44444444-4444-4444-8444-444444444444';
const KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const prev: ActionState = { key: KEY };

function form(entries: Record<string, string | string[]>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries))
    for (const one of Array.isArray(v) ? v : [v]) f.append(k, one);
  return f;
}

const send = (over: Record<string, string> = {}) =>
  form({
    quotationId: Q,
    versionId: V,
    idempotencyKey: KEY,
    expectedVersion: '4',
    recipientContactId: CONTACT,
    ...over,
  });

function answer(status: number, body: unknown = {}) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireStaffSession.mockResolvedValue({ accessToken: 't' });
  mocks.apiFetch.mockImplementation(() => answer(200));
});

describe('sendAction', () => {
  it('posts to the version send endpoint with the page key and the version row', async () => {
    const state = await sendAction(prev, send({ message: 'Hello' }));
    expect(state).toEqual({ key: KEY, done: true });
    const [, path, init] = mocks.apiFetch.mock.calls[0] as [unknown, string, RequestInit];
    expect(path).toBe(`/v1/quotations/${Q}/versions/${V}/send`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['idempotency-key']).toBe(KEY);
    expect(JSON.parse(init.body as string)).toEqual({
      recipientContactId: CONTACT,
      message: 'Hello',
      expectedVersion: 4,
    });
  });

  it('refuses an invalid form without calling the API and keeps the unused key', async () => {
    const state = await sendAction(prev, send({ recipientContactId: '' }));
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(state.key).toBe(KEY);
    expect(state.errors?.recipient).toBe('Choose who should receive it.');
  });

  it('asks for a reload on 409 and rotates the key, because the answer was final', async () => {
    mocks.apiFetch.mockImplementation(() => answer(409, { error: { code: 'conflict' } }));
    const state = await sendAction(prev, send());
    expect(state.reload).toBe(true);
    expect(state.error).toMatch(/Reload/);
    expect(state.key).not.toBe(KEY);
    expect(state.done).toBeUndefined();
  });

  it('keeps the same key after a 5xx or a network failure, so a landed call is not repeated', async () => {
    mocks.apiFetch.mockImplementation(() => answer(503));
    expect((await sendAction(prev, send())).key).toBe(KEY);
    mocks.apiFetch.mockImplementation(() => Promise.reject(new TypeError('fetch failed')));
    expect((await sendAction(prev, send())).key).toBe(KEY);
  });

  it('shows the 403 reason in words', async () => {
    mocks.apiFetch.mockImplementation(() =>
      answer(403, {
        error: { code: 'forbidden', message: 'no', correlationId: 'c1', reason: 'no_permission' },
      }),
    );
    const state = await sendAction(prev, send());
    expect(state.error).toMatch(/roles don't allow/);
    expect(state.reload).toBeUndefined();
  });

  it('replaces a tampered key and refuses ids that are not UUIDs', async () => {
    await sendAction(prev, send({ idempotencyKey: 'x' }));
    const headers = (mocks.apiFetch.mock.calls[0] as [unknown, string, RequestInit])[2]
      .headers as Record<string, string>;
    expect(headers['idempotency-key']).not.toBe('x');
    mocks.apiFetch.mockClear();
    const state = await sendAction(prev, send({ quotationId: '../admin' }));
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(state.reload).toBe(true);
  });

  it('is a plain ApiError status to the person when the response is not JSON', async () => {
    mocks.apiFetch.mockImplementation(() =>
      Promise.resolve(new Response('<html>', { status: 400 })),
    );
    const state = await sendAction(prev, send());
    expect(state.error).toMatch(/did not accept/);
    expect(new ApiError(400, 'x').status).toBe(400);
  });
});

describe('outcomeAction', () => {
  it('posts the outcome to the version outcome endpoint', async () => {
    const state = await outcomeAction(
      prev,
      form({
        quotationId: Q,
        versionId: V,
        idempotencyKey: KEY,
        expectedVersion: '4',
        outcome: 'rejected',
        comment: 'Went with a competitor',
        decidedOn: '2020-01-01',
      }),
    );
    expect(state.done).toBe(true);
    const [, path, init] = mocks.apiFetch.mock.calls[0] as [unknown, string, RequestInit];
    expect(path).toBe(`/v1/quotations/${Q}/versions/${V}/outcome`);
    expect(JSON.parse(init.body as string)).toMatchObject({
      outcome: 'rejected',
      comment: 'Went with a competitor',
      decidedOn: '2020-01-01',
      expectedVersion: 4,
    });
  });

  it('refuses accepting without evidence before any call', async () => {
    const state = await outcomeAction(
      prev,
      form({
        quotationId: Q,
        versionId: V,
        idempotencyKey: KEY,
        expectedVersion: '4',
        outcome: 'accepted',
        decidedOn: '2020-01-01',
      }),
    );
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(state.errors?.evidence).toMatch(/evidence/);
  });
});

describe('reviseAction', () => {
  const revise = (over: Record<string, string> = {}) =>
    form({
      quotationId: Q,
      versionId: V,
      idempotencyKey: KEY,
      expectedVersion: '4',
      reason: 'Customer asked for a smaller scope',
      ...over,
    });

  it('posts to the revise endpoint and sends the person to the edit page', async () => {
    await expect(reviseAction(prev, revise())).rejects.toThrow(
      `NEXT_REDIRECT /quotations/${Q}/edit`,
    );
    const [, path] = mocks.apiFetch.mock.calls[0] as [unknown, string];
    expect(path).toBe(`/v1/quotations/${Q}/revise`);
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/quotations/${Q}`);
  });

  it('needs a reason and stays on the page without one', async () => {
    const state = await reviseAction(prev, revise({ reason: ' ' }));
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(state.errors?.reason).toMatch(/Say why/);
  });

  it('does not redirect when the API refuses', async () => {
    mocks.apiFetch.mockImplementation(() => answer(409));
    const state = await reviseAction(prev, revise());
    expect(state.reload).toBe(true);
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});

describe('cancelAction', () => {
  const cancel = (over: Record<string, string> = {}) =>
    form({
      quotationId: Q,
      versionId: V,
      idempotencyKey: KEY,
      expectedVersion: '4',
      reason: 'Customer chose another vendor',
      ...over,
    });

  it('posts the reason and the version row to the quotation cancel endpoint, then refreshes', async () => {
    const state = await cancelAction(prev, cancel());
    expect(state).toEqual({ key: KEY, done: true });
    const [, path, init] = mocks.apiFetch.mock.calls[0] as [unknown, string, RequestInit];
    expect(path).toBe(`/v1/quotations/${Q}/cancel`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['idempotency-key']).toBe(KEY);
    expect(JSON.parse(init.body as string)).toEqual({
      reason: 'Customer chose another vendor',
      expectedVersion: 4,
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/quotations/${Q}`);
  });

  it('asks why before calling the API, in words about cancelling', async () => {
    const state = await cancelAction(prev, cancel({ reason: '  ' }));
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(state.errors?.reason).toBe(
      'Say why you are cancelling it. The reason is kept with the quotation.',
    );
    expect(state.key).toBe(KEY);
  });

  it("shows the API's refusal and does not refresh", async () => {
    mocks.apiFetch.mockImplementation(() =>
      answer(409, {
        error: { code: 'invalid_transition', message: 'Only a draft can be cancelled' },
      }),
    );
    const state = await cancelAction(prev, cancel());
    expect(state.done).toBeUndefined();
    expect(state.error).toBeTruthy();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});

describe('confirmEvidenceAction (F1-Q28)', () => {
  const confirm = (over: Record<string, string | string[]> = {}) =>
    form({
      quotationId: Q,
      versionId: V,
      idempotencyKey: KEY,
      evidenceKinds: ['contract', 'purchase_order'],
      ...over,
    });

  it('posts the ticked kinds with the page key to the evidence confirmation of the version', async () => {
    const state = await confirmEvidenceAction(prev, confirm({ comment: '  PO 4471 on file  ' }));
    expect(state).toEqual({ key: KEY, done: true });
    const [, path, init] = mocks.apiFetch.mock.calls[0] as [unknown, string, RequestInit];
    expect(path).toBe(`/v1/quotations/${Q}/versions/${V}/evidence-confirmation`);
    expect((init.headers as Record<string, string>)['idempotency-key']).toBe(KEY);
    expect(JSON.parse(init.body as string)).toEqual({
      evidenceKinds: ['contract', 'purchase_order'],
      comment: 'PO 4471 on file',
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/quotations/${Q}`);
  });

  it('sends no comment when the note is blank', async () => {
    await confirmEvidenceAction(prev, confirm({ comment: '   ' }));
    const [, , init] = mocks.apiFetch.mock.calls[0] as [unknown, string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      evidenceKinds: ['contract', 'purchase_order'],
    });
  });

  it('asks for the evidence before calling the API when nothing is ticked', async () => {
    const state = await confirmEvidenceAction(prev, confirm({ evidenceKinds: [] }));
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(state.errors?.evidence).toBe('Tick the evidence you checked.');
  });

  it("says plainly when the evidence does not meet the company's policy", async () => {
    mocks.apiFetch.mockImplementation(() =>
      answer(422, { error: { code: 'evidence_policy_unmet', message: 'needs both' } }),
    );
    const state = await confirmEvidenceAction(prev, confirm({ evidenceKinds: 'contract' }));
    expect(state.error).toMatch(/does not meet your company's evidence policy/);
    expect(state.error).not.toMatch(/did not respond/);
    expect(state.done).toBeUndefined();
  });

  it('asks for a reload when someone else confirmed it first', async () => {
    mocks.apiFetch.mockImplementation(() =>
      answer(409, { error: { code: 'evidence_already_confirmed', message: 'done' } }),
    );
    const state = await confirmEvidenceAction(prev, confirm());
    expect(state.error).toBe(
      'Someone has already confirmed this evidence. Reload the page to see who.',
    );
    expect(state.reload).toBe(true);
  });
});
