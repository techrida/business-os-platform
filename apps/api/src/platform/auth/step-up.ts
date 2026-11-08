// Step-up authentication (K7, kernel gap M24): some decisions, such as approving a Founder step,
// need the user to have signed in recently, not just to hold a valid token. ZITADEL puts the
// sign-in time (`auth_time`) only in the ID token, never in access tokens, introspection or
// userinfo, so the BFF forwards the user's ID token in `x-bos-id-token` on a decision call and we
// verify it here. Anything we cannot read as a recent sign-in is stale: "sign in again".
import { UnauthorizedException } from '@nestjs/common';

import type { AuthIdentity } from './claims';
import type { JwtVerifier } from './jwt-verifier';

/** The request header the BFF puts the user's raw ID token in, on a decision call only. */
export const ID_TOKEN_HEADER = 'x-bos-id-token';

/** The error code a client switches on to send the user through a fresh sign-in. */
export const STEP_UP_REQUIRED = 'step_up_required';

/** How recent the sign-in must be, in seconds, unless STEP_UP_MAX_AGE_SECONDS overrides it. */
export const DEFAULT_STEP_UP_MAX_AGE_SECONDS = 300;

/** DI token for the window in seconds. Provide a positive integer to change the default. */
export const STEP_UP_MAX_AGE_SECONDS = Symbol('STEP_UP_MAX_AGE_SECONDS');

/** The longest window the env may set: one day. Longer would make step-up meaningless. */
const MAX_STEP_UP_MAX_AGE_SECONDS = 86_400;

/**
 * Reads the STEP_UP_MAX_AGE_SECONDS env value: unset or empty means the 300 s default, a whole
 * number from 1 to 86400 is used as is, and anything else throws so the API refuses to start.
 */
export function stepUpMaxAgeFromEnv(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_STEP_UP_MAX_AGE_SECONDS;
  const value = /^[1-9]\d{0,4}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!(value <= MAX_STEP_UP_MAX_AGE_SECONDS)) {
    throw new Error(
      `STEP_UP_MAX_AGE_SECONDS must be a whole number of seconds from 1 to ${MAX_STEP_UP_MAX_AGE_SECONDS}`,
    );
  }
  return value;
}

/** An `auth_time` this far ahead of our clock still counts (clock drift with ZITADEL). */
const CLOCK_SKEW_SECONDS = 60;

/** 401 with `code: 'step_up_required'` and the window, so the client knows to re-authenticate. */
export class StepUpRequiredException extends UnauthorizedException {
  constructor(maxAgeSeconds: number) {
    super({
      code: STEP_UP_REQUIRED,
      message: 'Sign in again to approve this step',
      maxAge: maxAgeSeconds,
    });
  }
}

/**
 * True when `authTime` (seconds) is within `maxAgeSeconds` of `nowMs`. Missing, null, far-future
 * values and a window that is not a positive finite number are all false: fail closed.
 */
export function isAuthRecent(
  authTime: number | null | undefined,
  nowMs: number,
  maxAgeSeconds: number,
): boolean {
  if (typeof authTime !== 'number' || !Number.isFinite(authTime)) return false;
  if (!Number.isFinite(maxAgeSeconds) || maxAgeSeconds <= 0) return false;
  const nowSeconds = nowMs / 1000;
  if (authTime > nowSeconds + CLOCK_SKEW_SECONDS) return false;
  return nowSeconds - authTime <= maxAgeSeconds;
}

/** Throws StepUpRequiredException unless the caller signed in within the window. */
export function assertRecentAuth(
  auth: AuthIdentity | undefined,
  nowMs: number,
  maxAgeSeconds: number,
): void {
  if (!isAuthRecent(auth?.authTime, nowMs, maxAgeSeconds)) {
    throw new StepUpRequiredException(maxAgeSeconds);
  }
}

/** Three base64url parts. Anything else (empty, a list of joined headers, junk) is no ID token. */
const COMPACT_JWT = /^[\w-]+\.[\w-]+\.[\w-]+$/;

/** Far above a real ZITADEL ID token; stops us parsing an oversized header. */
const MAX_ID_TOKEN_LENGTH = 16_384;

/**
 * Throws StepUpRequiredException unless `rawHeader` is a valid ID token (see
 * {@link JwtVerifier.verifyIdToken}) for `accessSub`, the access token's `sub`, whose `auth_time`
 * is within `maxAgeSeconds` of `nowSec`. Every failure, including an unreachable identity
 * provider, is a step-up: the decision never proceeds without proof.
 */
export async function assertRecentIdToken(
  verifier: Pick<JwtVerifier, 'verifyIdToken'>,
  rawHeader: string | undefined,
  accessSub: string | undefined,
  nowSec: number,
  maxAgeSeconds: number,
): Promise<void> {
  if (
    typeof rawHeader !== 'string' ||
    rawHeader.length > MAX_ID_TOKEN_LENGTH ||
    !COMPACT_JWT.test(rawHeader) ||
    typeof accessSub !== 'string' ||
    accessSub.length === 0
  ) {
    throw new StepUpRequiredException(maxAgeSeconds);
  }
  let authTime: unknown;
  try {
    authTime = (await verifier.verifyIdToken(rawHeader, accessSub))['auth_time'];
  } catch {
    throw new StepUpRequiredException(maxAgeSeconds);
  }
  if (!isAuthRecent(typeof authTime === 'number' ? authTime : null, nowSec * 1000, maxAgeSeconds)) {
    throw new StepUpRequiredException(maxAgeSeconds);
  }
}
