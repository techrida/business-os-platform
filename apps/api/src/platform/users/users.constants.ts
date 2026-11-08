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

export interface UsersSyncData {
  zitadelUserId: string;
}
