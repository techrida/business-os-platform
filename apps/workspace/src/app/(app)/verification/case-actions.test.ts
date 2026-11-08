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
  requireStaffSession: vi.fn(() => Promise.resolve({ accessToken: 't', roles: ['sales'] })),
}));

const api = vi.hoisted(() => ({ openVerificationCase: vi.fn() }));
vi.mock('@/components/p2/crm/verification-api', () => api);

import { openCaseAction } from './case-actions';

const KEY = '44444444-4444-4444-8444-444444444444';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';
const CASE = '11111111-1111-4111-8111-111111111111';
const GUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const apiError = (status: number, code: string, message: string) =>
  new ApiError(status, 'x', { error: { code, message, correlationId: 'corr-12345678' } });

function openForm(extra: Record<string, string> = {}): FormData {
  const f = new FormData();
  const fields = { partyId: CUSTOMER, idempotencyKey: KEY, ...extra };
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

beforeEach(() => vi.clearAllMocks());

describe('openCaseAction', () => {
  it('sends the page key and goes to the case the API answered with', async () => {
    api.openVerificationCase.mockResolvedValue({ id: CASE });
    await expect(openCaseAction({ key: KEY }, openForm())).rejects.toThrow(
      `NEXT_REDIRECT /verification/${CASE}`,
    );
    expect(api.openVerificationCase).toHaveBeenCalledWith(expect.anything(), CUSTOMER, KEY);
  });

  it('refuses a form without a customer id before any call', async () => {
    const res = await openCaseAction({ key: KEY }, openForm({ partyId: 'nope' }));
    expect(res.error).toBeTruthy();
    expect(res.reload).toBe(true);
    expect(res.key).toBe(KEY);
    expect(api.openVerificationCase).not.toHaveBeenCalled();
  });

  it('keeps the key after a 5xx or a network error, so a retry names the same request', async () => {
    api.openVerificationCase.mockRejectedValueOnce(new ApiError(503, 'down'));
    const first = await openCaseAction({ key: KEY }, openForm());
    expect(first.error).toBeTruthy();
    expect(first.key).toBe(KEY);

    api.openVerificationCase.mockRejectedValueOnce(new TypeError('fetch failed'));
    const second = await openCaseAction({ key: KEY }, openForm());
    expect(second.error).toBeTruthy();
    expect(second.key).toBe(KEY);
  });

  it('rotates the key after a definite 4xx', async () => {
    api.openVerificationCase.mockRejectedValueOnce(
      apiError(404, 'not_found', 'Customer not found'),
    );
    const res = await openCaseAction({ key: KEY }, openForm());
    expect(res.key).toMatch(GUID_SHAPE);
    expect(res.key).not.toBe(KEY);
  });

  it.each([
    'The first request with this Idempotency-Key did not finish',
    'This Idempotency-Key was released while it was being checked',
  ])('keeps the key after the in-progress 409 "%s"', async (message) => {
    api.openVerificationCase.mockRejectedValueOnce(apiError(409, 'conflict', message));
    const res = await openCaseAction({ key: KEY }, openForm());
    expect(res.key).toBe(KEY);
    expect(res.error).toMatch(/still saving/i);
  });

  it('replaces a tampered key with a fresh one', async () => {
    api.openVerificationCase.mockResolvedValue({ id: CASE });
    await expect(
      openCaseAction({ key: KEY }, openForm({ idempotencyKey: 'x y' })),
    ).rejects.toThrow();
    const sent = api.openVerificationCase.mock.calls[0]?.[2] as string;
    expect(sent).toMatch(GUID_SHAPE);
    expect(sent).not.toBe('x y');
  });

  it.each([
    [
      404,
      'not_found',
      'Customer not found',
      'We could not find that customer. It may have been merged or removed.',
    ],
    [403, 'forbidden', 'Forbidden', "You don't have permission to do this."],
  ])('words a %s as a plain sentence', async (status, code, message, text) => {
    api.openVerificationCase.mockRejectedValueOnce(apiError(status, code, message));
    expect((await openCaseAction({ key: KEY }, openForm())).error).toBe(text);
  });
});
