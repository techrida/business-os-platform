// The decision server action's answer to the API's step-up 401 (K7): send the approver through a
// fresh sign-in that comes back to this request, instead of "Your session ended".
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  // The real `redirect` throws; so does this, so the code after it never runs.
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock('@/lib/session', () => ({ getSession: vi.fn() }));
const actOnApproval = vi.fn();
vi.mock('@/lib/api-kernel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-kernel')>()),
  actOnApproval: (...args: unknown[]) => actOnApproval(...args) as unknown,
}));
vi.mock('@/lib/bff', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bff')>()),
  requireStaffSession: () => Promise.resolve({ accessToken: 't' }),
}));

const { decideAction } = await import('./actions');

const ID = '3f1c2a52-9a7e-4c41-8f6e-2b1a1d0c9e11';
const IDEM = '0b0e8c1e-4d7a-4f43-9d3c-1f8c8a6f2e10';

function approveForm(): FormData {
  const form = new FormData();
  form.set('requestId', ID);
  form.set('idempotencyKey', IDEM);
  form.set('intent', 'approve');
  form.set('expectedVersion', '3');
  return form;
}

const errorBody = (code: string) => ({ error: { code, message: 'm', correlationId: 'c' } });

afterEach(() => {
  actOnApproval.mockReset();
});

describe('decideAction step-up', () => {
  it('redirects to a forced sign-in that returns to the request', async () => {
    actOnApproval.mockRejectedValue(new ApiError(401, 'x', errorBody('step_up_required')));
    await expect(decideAction({ key: IDEM }, approveForm())).rejects.toThrow(
      `REDIRECT:/auth/login?prompt=login&max_age=0&returnTo=${encodeURIComponent(`/inbox/${ID}`)}`,
    );
  });

  it('still shows a plain 401 as an ended session, without redirecting', async () => {
    actOnApproval.mockRejectedValue(new ApiError(401, 'x', errorBody('unauthenticated')));
    const state = await decideAction({ key: IDEM }, approveForm());
    expect(state.error).toBe('Your session ended. Sign in again to continue.');
  });
});
