import { Logger, UnauthorizedException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestIssuer, type TestIssuer } from '../../../test/e2e/support/test-issuer';
import { JwtVerifier } from './jwt-verifier';

import {
  assertRecentIdToken,
  DEFAULT_STEP_UP_MAX_AGE_SECONDS,
  isAuthRecent,
  STEP_UP_REQUIRED,
  StepUpRequiredException,
  stepUpMaxAgeFromEnv,
} from './step-up';

const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;
const MAX = DEFAULT_STEP_UP_MAX_AGE_SECONDS;

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

// The real producer (the e2e test issuer, serving discovery and a JWKS on 127.0.0.1) through the
// real consumer (JwtVerifier): every case differs from the valid token in exactly one way.
describe('assertRecentIdToken', () => {
  const PROJECT = '300000000000000001';
  const CLIENT = '300000000000000002';
  const SUB = 'user-1';
  let issuer: TestIssuer;
  let verifier: JwtVerifier;
  const nowSec = (): number => Math.floor(Date.now() / 1000);

  beforeAll(async () => {
    Logger.overrideLogger(false);
    issuer = await startTestIssuer();
    verifier = new JwtVerifier({ issuer: issuer.url, audience: PROJECT, allowedAzp: [CLIENT] });
  });
  afterAll(async () => {
    verifier.onModuleDestroy();
    await issuer.close();
  });

  const idToken = (over: Partial<Parameters<TestIssuer['mintIdToken']>[0]> = {}) =>
    issuer.mintIdToken({ sub: SUB, authTime: nowSec() - 10, audience: [CLIENT], ...over });

  async function refusal(promise: Promise<unknown>): Promise<void> {
    const err: unknown = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(StepUpRequiredException);
    expect(err).toBeInstanceOf(UnauthorizedException);
    const ex = err as StepUpRequiredException;
    expect(ex.getStatus()).toBe(401);
    expect(ex.getResponse()).toMatchObject({ code: STEP_UP_REQUIRED, maxAge: MAX });
  }

  it('passes a fresh, valid ID token for the caller', async () => {
    await expect(
      assertRecentIdToken(verifier, await idToken(), SUB, nowSec(), MAX),
    ).resolves.toBeUndefined();
  });

  it('passes an ID token whose exp is an hour past when auth_time is fresh', async () => {
    const token = await idToken({ exp: nowSec() - 3600 });
    await expect(assertRecentIdToken(verifier, token, SUB, nowSec(), MAX)).resolves.toBeUndefined();
  });

  it.each<[string, () => Promise<string | undefined>]>([
    ['the header is missing', () => Promise.resolve(undefined)],
    ['the header is empty', () => Promise.resolve('')],
    ['the header is not a JWT', () => Promise.resolve('not-a-jwt')],
    ['two headers were joined', async () => `${await idToken()}, ${await idToken()}`],
    ['auth_time is stale', () => idToken({ authTime: nowSec() - MAX - 5 })],
    ['the token is forged (a key not in the JWKS)', () => idToken({ signWith: 'forged' })],
    ['the token belongs to another user', () => idToken({ sub: 'user-2' })],
    ['aud names no allowed client', () => idToken({ audience: ['other-client'] })],
    ['iss is another issuer', () => idToken({ issuer: 'https://evil.test' })],
    [
      'an access token is passed as the ID token',
      () =>
        issuer.mint(
          { sub: SUB, azp: CLIENT },
          { audience: [PROJECT, CLIENT], authTime: nowSec() - 10 },
        ),
    ],
    ['exp is more than 24 h past', () => idToken({ exp: nowSec() - 86_400 - 120 })],
  ])('throws 401 step_up_required when %s', async (_label, header) => {
    await refusal(assertRecentIdToken(verifier, await header(), SUB, nowSec(), MAX));
  });

  it('throws 401 step_up_required when the caller has no user id', async () => {
    await refusal(assertRecentIdToken(verifier, await idToken(), undefined, nowSec(), MAX));
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
