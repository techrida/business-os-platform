import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
}));
vi.mock('@/lib/bff', () => ({
  requireStaffSession: vi.fn(() => Promise.resolve({ accessToken: 't', roles: ['pmo'] })),
}));

const api = vi.hoisted(() => ({ decideVerification: vi.fn() }));
vi.mock('@/components/p2/customers/api', () => api);

import { reviewAction } from './actions';

const KEY = '55555555-5555-4555-8555-555555555555';
const CASE = '11111111-1111-4111-8111-111111111111';
const GUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function form(extra: Record<string, string> = {}): FormData {
  const f = new FormData();
  const fields = {
    caseId: CASE,
    intent: 'reject',
    comment: 'The certificate is expired.',
    expectedVersion: '3',
    idempotencyKey: KEY,
    ...extra,
  };
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

beforeEach(() => vi.clearAllMocks());

describe('reviewAction idempotency key', () => {
  it('sends the page key with the decision', async () => {
    api.decideVerification.mockResolvedValue({ id: CASE });
    await expect(reviewAction({ key: KEY }, form())).rejects.toThrow(
      'NEXT_REDIRECT /verification?decided=reject',
    );
    expect(api.decideVerification).toHaveBeenCalledWith(
      expect.anything(),
      CASE,
      { decision: 'reject', comment: 'The certificate is expired.', expectedVersion: 3 },
      KEY,
    );
  });

  it('keeps the key after a 5xx or a network error, so a retry cannot decide twice', async () => {
    api.decideVerification.mockRejectedValueOnce(new ApiError(503, 'down'));
    expect((await reviewAction({ key: KEY }, form())).key).toBe(KEY);
    api.decideVerification.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect((await reviewAction({ key: KEY }, form())).key).toBe(KEY);
  });

  it('rotates the key after a definite 4xx', async () => {
    api.decideVerification.mockRejectedValueOnce(new ApiError(422, 'refused'));
    const res = await reviewAction({ key: KEY }, form());
    expect(res.key).toMatch(GUID_SHAPE);
    expect(res.key).not.toBe(KEY);
  });

  it.each([
    'The first request with this Idempotency-Key did not finish',
    'This Idempotency-Key was released while it was being checked',
  ])('keeps the key after the in-progress 409 "%s"', async (message) => {
    api.decideVerification.mockRejectedValueOnce(
      new ApiError(409, message, { error: { code: 'conflict', message, correlationId: 'c' } }),
    );
    expect((await reviewAction({ key: KEY }, form())).key).toBe(KEY);
  });

  it('keeps the unused key when the comment is missing, without calling the API', async () => {
    const res = await reviewAction({ key: KEY }, form({ comment: ' ' }));
    expect(res.commentError).toBeTruthy();
    expect(res.key).toBe(KEY);
    expect(api.decideVerification).not.toHaveBeenCalled();
  });
});

it('forwards a clean provided-case approval with the reviewed version, preserving API refusals', async () => {
  api.decideVerification.mockResolvedValueOnce({ id: CASE });
  await expect(
    reviewAction({ key: KEY }, form({ intent: 'approve', comment: 'Documents checked.' })),
  ).rejects.toThrow('NEXT_REDIRECT /verification?decided=approve');
  expect(api.decideVerification).toHaveBeenCalledWith(
    expect.anything(),
    CASE,
    { decision: 'approve', comment: 'Documents checked.', expectedVersion: 3 },
    KEY,
  );
  for (const status of [403, 409]) {
    api.decideVerification.mockRejectedValueOnce(new ApiError(status, 'Decision refused'));
    const result = await reviewAction({ key: KEY }, form({ intent: 'approve' }));
    expect(result.error).toBeTruthy();
  }
});
