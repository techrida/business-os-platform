import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import type { AuthIdentity } from './claims';
import {
  assertRecentAuth,
  DEFAULT_STEP_UP_MAX_AGE_SECONDS,
  isAuthRecent,
  STEP_UP_REQUIRED,
  StepUpRequiredException,
  stepUpMaxAgeFromEnv,
} from './step-up';

const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;
const MAX = DEFAULT_STEP_UP_MAX_AGE_SECONDS;

const identity = (authTime?: number | null): AuthIdentity => ({
  userId: 'u',
  zitadelOrgId: 'o',
  roles: ['founder'],
  tokenExp: NOW_S + 600,
  ...(authTime === undefined ? {} : { authTime }),
});

describe('isAuthRecent', () => {
  it('defaults to a 5 minute window', () => {
    expect(DEFAULT_STEP_UP_MAX_AGE_SECONDS).toBe(300);
  });

  it('accepts a sign-in inside the window, up to its edge', () => {
    expect(isAuthRecent(NOW_S - 10, NOW_MS, MAX)).toBe(true);
    expect(isAuthRecent(NOW_S - MAX, NOW_MS, MAX)).toBe(true);
  });

  it('refuses a sign-in older than the window', () => {
    expect(isAuthRecent(NOW_S - MAX - 1, NOW_MS, MAX)).toBe(false);
  });

  it('fails closed on a missing or null auth_time', () => {
    expect(isAuthRecent(undefined, NOW_MS, MAX)).toBe(false);
    expect(isAuthRecent(null, NOW_MS, MAX)).toBe(false);
  });

  it('allows small clock skew but refuses an auth_time far in the future', () => {
    expect(isAuthRecent(NOW_S + 30, NOW_MS, MAX)).toBe(true);
    expect(isAuthRecent(NOW_S + 3600, NOW_MS, MAX)).toBe(false);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'fails closed on a max age of %s',
    (maxAge) => {
      expect(isAuthRecent(NOW_S, NOW_MS, maxAge)).toBe(false);
    },
  );
});

describe('assertRecentAuth', () => {
  it('passes a fresh sign-in', () => {
    expect(() => assertRecentAuth(identity(NOW_S - 60), NOW_MS, MAX)).not.toThrow();
  });

  it.each([
    ['stale', identity(NOW_S - MAX - 1)],
    ['missing', identity()],
    ['null', identity(null)],
    ['unauthenticated', undefined],
  ])('throws 401 step_up_required when auth_time is %s', (_label, auth) => {
    let thrown: unknown;
    try {
      assertRecentAuth(auth, NOW_MS, MAX);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(StepUpRequiredException);
    expect(thrown).toBeInstanceOf(UnauthorizedException);
    const ex = thrown as StepUpRequiredException;
    expect(ex.getStatus()).toBe(401);
    expect(ex.getResponse()).toMatchObject({ code: STEP_UP_REQUIRED, maxAge: MAX });
  });
});

describe('stepUpMaxAgeFromEnv', () => {
  it('defaults to 300 when unset or empty', () => {
    expect(stepUpMaxAgeFromEnv(undefined)).toBe(300);
    expect(stepUpMaxAgeFromEnv('')).toBe(300);
  });

  it('reads a positive whole number of seconds', () => {
    expect(stepUpMaxAgeFromEnv('120')).toBe(120);
  });

  it.each(['0', '-5', '1.5', 'abc', '1e3', ' 60', '86401'])(
    'refuses %s at startup instead of guessing',
    (raw) => {
      expect(() => stepUpMaxAgeFromEnv(raw)).toThrow(/STEP_UP_MAX_AGE_SECONDS/);
    },
  );
});
