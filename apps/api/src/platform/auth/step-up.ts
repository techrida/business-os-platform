// Step-up authentication (K7, kernel gap M24): some decisions, such as approving a Founder step,
// need the user to have signed in recently, not just to hold a valid token. The token's `auth_time`
// says when that sign-in happened. Anything we cannot read as a recent sign-in is stale, so the
// default is "sign in again".
import { UnauthorizedException } from '@nestjs/common';

import type { AuthIdentity } from './claims';

/** The error code a client switches on to send the user through a fresh sign-in. */
export const STEP_UP_REQUIRED = 'step_up_required';

/** How recent the sign-in must be, in seconds, unless STEP_UP_MAX_AGE_SECONDS overrides it. */
export const DEFAULT_STEP_UP_MAX_AGE_SECONDS = 300;

/** DI token for the window in seconds. Provide a positive integer to change the default. */
export const STEP_UP_MAX_AGE_SECONDS = Symbol('STEP_UP_MAX_AGE_SECONDS');

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
