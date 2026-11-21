import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from './api';
import { __resetEnvForTests } from './env';
import type { Session } from './session';
import { SessionUnavailableError } from './session-unavailable';

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  // The real `redirect` throws; the test does the same so the code after it never runs.
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
const getSession = vi.fn<() => Promise<Session | null>>();
vi.mock('./session', () => ({ getSession: () => getSession() }));

const {
  errorResponse,
  isSameOrigin,
  isStepUpRequired,
  redirectToStepUp,
  requireStaffSession,
  routeSession,
  stepUpLoginUrl,
} = await import('./bff');

const staff: Session = {
  id: 'A'.repeat(43),
  sub: 'u1',
  orgId: 'o1',
  orgKind: 'staff',
  roles: ['finance'],
  accessToken: 't',
  accessExp: 2_000_000_000,
  createdAt: 1,
  lastSeenAt: 1,
};

beforeEach(() => {
  for (const [k, v] of Object.entries({
    API_INTERNAL_URL: 'http://api:3001',
    OIDC_ISSUER: 'https://auth.test',
    OIDC_CLIENT_ID: 'c',
    OIDC_REDIRECT_URI: 'https://app.test/auth/callback',
    OIDC_AUDIENCE: 'p',
    WORKSPACE_PUBLIC_URL: 'https://app.test',
    VALKEY_URL: 'redis://v:6379',
    SESSION_ENC_KEY: Buffer.alloc(32, 5).toString('base64'),
  })) {
    vi.stubEnv(k, v);
  }
  __resetEnvForTests();
  getSession.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('requireStaffSession', () => {
  it('propagates a store outage to the page error boundary', async () => {
    const outage = new SessionUnavailableError();
    getSession.mockRejectedValue(outage);
    await expect(requireStaffSession('/inbox')).rejects.toBe(outage);
  });

  it('sends an unauthenticated user to login with the page path encoded', async () => {
    getSession.mockResolvedValue(null);
    await expect(requireStaffSession('/inbox/abc?x=1')).rejects.toThrow(
      'REDIRECT:/auth/login?returnTo=%2Finbox%2Fabc%3Fx%3D1',
    );
  });

  it('sends customer and vendor users to the staff-only page', async () => {
    getSession.mockResolvedValue({ ...staff, orgKind: 'customer' });
    await expect(requireStaffSession('/inbox')).rejects.toThrow('REDIRECT:/staff-only');
  });

  it('returns the session for staff', async () => {
    getSession.mockResolvedValue(staff);
    await expect(requireStaffSession('/inbox')).resolves.toBe(staff);
  });
});

describe('routeSession', () => {
  it('returns a retryable 503 only for a session store outage', async () => {
    getSession.mockRejectedValueOnce(new SessionUnavailableError());
    const response = (await routeSession()) as Response;
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('1');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.has('set-cookie')).toBe(false);
    expect(await response.json()).toMatchObject({ error: { reload: false } });

    const unexpected = new Error('unexpected failure');
    getSession.mockRejectedValueOnce(unexpected);
    await expect(routeSession()).rejects.toBe(unexpected);
  });

  it('answers 401 JSON instead of redirecting', async () => {
    getSession.mockResolvedValue(null);
    const res = await routeSession();
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(401);
  });

  it('answers 403 for non-staff and the session for staff', async () => {
    getSession.mockResolvedValue({ ...staff, orgKind: 'vendor' });
    expect(((await routeSession()) as Response).status).toBe(403);
    getSession.mockResolvedValue(staff);
    expect(await routeSession()).toBe(staff);
  });
});

describe('isSameOrigin', () => {
  const req = (origin?: string) =>
    new Request('https://app.test/api/x', {
      method: 'POST',
      ...(origin !== undefined ? { headers: { origin } } : {}),
    });

  it('accepts only the workspace origin', () => {
    expect(isSameOrigin(req('https://app.test'))).toBe(true);
    expect(isSameOrigin(req('https://evil.test'))).toBe(false);
    expect(isSameOrigin(req('http://app.test'))).toBe(false);
    expect(isSameOrigin(req())).toBe(false);
  });
});

describe('errorResponse', () => {
  it('passes a 4xx status through with the plain message and the reload flag', async () => {
    const res = errorResponse(new ApiError(409, 'x'), 'approval');
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string; reload: boolean } };
    expect(body.error.message).toBe('This request changed since you opened it.');
    expect(body.error.reload).toBe(true);
  });

  it('turns a 5xx or a network failure into 502', () => {
    expect(errorResponse(new ApiError(500, 'x')).status).toBe(502);
    expect(errorResponse(new TypeError('fetch failed')).status).toBe(502);
  });

  const busy = (retryAfterSeconds?: number) =>
    new ApiError(503, 'x', {
      error: {
        code: 'db_busy',
        message: 'Busy, please try again',
        correlationId: 'c',
        ...(retryAfterSeconds === undefined ? {} : { details: { retryAfterSeconds } }),
      },
    });

  it('passes an API 503 db_busy through as a 503 with its Retry-After, not a 502', async () => {
    const res = errorResponse(busy(2));
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('2');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { error: { message: string; reload: boolean } };
    expect(body.error).toEqual({ message: 'Busy, please try again.', reload: false });
  });

  it('waits one second when the busy refusal names no wait, and keeps other 503s a 502', () => {
    expect(errorResponse(busy()).headers.get('retry-after')).toBe('1');
    const plain503 = new ApiError(503, 'x', {
      error: { code: 'unavailable', message: 'x', correlationId: 'c' },
    });
    expect(errorResponse(plain503).status).toBe(502);
    expect(errorResponse(new ApiError(503, 'x')).status).toBe(502);
  });
});

// K7: the API answers a Founder decision on a stale sign-in with 401 step_up_required.
describe('step-up', () => {
  const body = (code: string) => ({ error: { code, message: 'm', correlationId: 'c' } });

  it('recognises only a 401 whose body code is step_up_required', () => {
    expect(isStepUpRequired(new ApiError(401, 'x', body('step_up_required')))).toBe(true);
    expect(isStepUpRequired(new ApiError(401, 'x', body('unauthenticated')))).toBe(false);
    expect(isStepUpRequired(new ApiError(401, 'x'))).toBe(false);
    expect(isStepUpRequired(new ApiError(403, 'x', body('step_up_required')))).toBe(false);
    expect(isStepUpRequired(new Error('step_up_required'))).toBe(false);
  });

  it('sends the user through a forced sign-in that returns to the approval', () => {
    const url = new URL(stepUpLoginUrl('/inbox/abc?x=1'), 'https://app.test');
    expect(url.pathname).toBe('/auth/login');
    expect(url.searchParams.get('prompt')).toBe('login');
    expect(url.searchParams.get('max_age')).toBe('0');
    expect(url.searchParams.get('returnTo')).toBe('/inbox/abc?x=1');
  });

  it('redirects with prompt=login, max_age=0 and the encoded return path', () => {
    expect(() => redirectToStepUp('/inbox/abc')).toThrow(
      'REDIRECT:/auth/login?prompt=login&max_age=0&returnTo=%2Finbox%2Fabc',
    );
  });
});
