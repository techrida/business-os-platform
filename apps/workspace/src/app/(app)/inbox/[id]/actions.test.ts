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
const peekSession = vi.fn();
vi.mock('@/lib/session', () => ({
  getSession: vi.fn(),
  peekSession: (...args: unknown[]) => peekSession(...args) as unknown,
}));
const actOnApproval = vi.fn();
vi.mock('@/lib/api-kernel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-kernel')>()),
  actOnApproval: (...args: unknown[]) => actOnApproval(...args) as unknown,
}));
vi.mock('@/lib/bff', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bff')>()),
  requireStaffSession: () => Promise.resolve({ id: SESSION_ID, accessToken: 't' }),
}));

const SESSION_ID = 'S'.repeat(43);
/** The stored ID token (K7): it carries `auth_time`, and must reach the API and nothing else. */
const ID_TOKEN = 'eyJ.secret-id-token-auth-time.sig';

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
  peekSession.mockReset();
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

describe('decideAction ID token (K7)', () => {
  it('reads the ID token server-side by session id and hands it to the decision call', async () => {
    peekSession.mockResolvedValue({ idToken: ID_TOKEN });
    actOnApproval.mockResolvedValue({});
    await expect(decideAction({ key: IDEM }, approveForm())).rejects.toThrow(
      'REDIRECT:/inbox?decided=approve',
    );
    expect(peekSession).toHaveBeenCalledWith(SESSION_ID);
    expect(actOnApproval).toHaveBeenCalledWith(
      expect.objectContaining({ id: SESSION_ID }),
      ID,
      { action: 'approve', expectedVersion: 3 },
      IDEM,
      ID_TOKEN,
    );
  });

  it.each([
    ['a session record without one', {}],
    ['a session record that is gone', null],
  ])(
    'sends no ID token for %s, so the API decides whether to ask for step-up',
    async (_n, peeked) => {
      peekSession.mockResolvedValue(peeked);
      actOnApproval.mockResolvedValue({});
      await decideAction({ key: IDEM }, approveForm()).catch(() => undefined);
      expect(actOnApproval).toHaveBeenCalledTimes(1);
      expect(actOnApproval.mock.calls[0]?.[4]).toBeUndefined();
    },
  );

  it('carries on without an ID token when the session store fails, logging only the error name', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const boom = new Error(`GET ws:sess:x ${ID_TOKEN}`);
    boom.name = 'ReplyError';
    peekSession.mockRejectedValue(boom);
    actOnApproval.mockRejectedValue(new ApiError(401, 'x', errorBody('step_up_required')));
    await expect(decideAction({ key: IDEM }, approveForm())).rejects.toThrow(
      'REDIRECT:/auth/login?prompt=login',
    );
    expect(actOnApproval.mock.calls[0]?.[4]).toBeUndefined();
    const logged = JSON.stringify([...warn.mock.calls, ...error.mock.calls]);
    expect(logged).toContain('ReplyError');
    expect(logged).not.toContain(ID_TOKEN);
    warn.mockRestore();
    error.mockRestore();
  });
});
