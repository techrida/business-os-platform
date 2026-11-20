// Queue and job names for k-users. Kept in their own file so the HTTP side (hook, JIT) and the
// worker side (processor, scheduler) agree on the names without importing each other.

/** BullMQ queue for user mirroring (P1-PLAN §6.2). */
export const USERS_QUEUE = 'users';
/** One user: re-fetch from ZITADEL and upsert. Data: `{ zitadelUserId }`. */
export const USERS_SYNC_JOB = 'users.sync';
/** The backstop for lost webhooks: walk every known org and fix drift. */
export const USERS_RECONCILE_JOB = 'users.reconcile';
/** Every 10 min: restAsync has no documented retry, so this bounds how long a missed event lasts. */
export const USERS_RECONCILE_EVERY_MS = 10 * 60_000;
/**
 * The ops.sync_cursors row holding when the lockout policy was first known to be pinned on a staff org (an ISO
 * timestamp). Only a lock ZITADEL set after it can be its lockout policy at work (F1-Q4, P2-1).
 */
export const lockoutPinnedCursor = (zitadelOrgId: string) => `users.lockout-pinned:${zitadelOrgId}`;
/** Ends the timed sign-in locks whose time is up (F1-Q4, UserLocks.expire). */
export const USERS_LOCK_EXPIRY_JOB = 'users.lock-expiry';
/**
 * Every minute: a lock lasts ACCOUNT_LOCKOUT.lockMinutes (15), so a person waits at most a minute longer than the
 * window. A run is one indexed query (users_lock_expiry_idx) that is empty almost always, and calls ZITADEL only for
 * locks that are due.
 */
export const USERS_LOCK_EXPIRY_EVERY_MS = 60_000;

export interface UsersSyncData {
  zitadelUserId: string;
}
