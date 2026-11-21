// Test-only. Shared pieces of the concurrency tests (*.concurrency.integration.test.ts): two real service calls race
// on the same tenant data, each in its own transaction on its own pool connection, and every round's outcome is
// recorded before anything is asserted.
// The pools come in from the test file (a *.test.ts may import pg; this helper may not), so they are typed by shape.
import { HttpException } from '@nestjs/common';

export interface QueryPool {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
}
export interface LockClient extends QueryPool {
  release: () => void;
}
export interface ConnectPool extends QueryPool {
  connect: () => Promise<LockClient>;
}

export type PgFields = { code?: string; detail?: string; message?: string };

/** The pg error behind `error` (drizzle wraps it as `cause`). */
export function pgErrorOf(error: unknown): PgFields {
  let e: unknown = error;
  for (let depth = 0; typeof e === 'object' && e !== null && depth < 5; depth++) {
    const x = e as { code?: unknown; detail?: unknown; message?: unknown; cause?: unknown };
    if (typeof x.code === 'string' && /^[0-9A-Z]{5}$/.test(x.code)) {
      return {
        code: x.code,
        ...(typeof x.detail === 'string' ? { detail: x.detail } : {}),
        ...(typeof x.message === 'string' ? { message: x.message } : {}),
      };
    }
    e = x.cause;
  }
  return {};
}

/**
 * 'ok', 'pg-<sqlstate>', 'http-<status>:<body code>' or 'other: <message>'. The pg cause is looked for first, so a
 * deadlock that some layer wrapped in an HTTP error still shows as pg-40P01.
 */
export function outcomeOf(r: PromiseSettledResult<unknown>): string {
  if (r.status === 'fulfilled') return 'ok';
  const e: unknown = r.reason;
  const pg = pgErrorOf(e);
  if (pg.code !== undefined) return `pg-${pg.code}`;
  if (e instanceof HttpException) {
    const body = e.getResponse();
    const code =
      typeof body === 'object' &&
      body !== null &&
      typeof (body as { code?: unknown }).code === 'string'
        ? (body as { code: string }).code
        : '-';
    return `http-${e.getStatus()}:${code}`;
  }
  return `other: ${e instanceof Error ? e.message : String(e)}`;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The start delays of round `round` (1-based): 0 to 10 ms, on the second side in odd rounds and on the first side in
 * even rounds, so both start orders occur at every offset.
 */
export function offsetsFor(round: number): { a: number; b: number } {
  const ms = (round - 1) % 11;
  return round % 2 === 1 ? { a: 0, b: ms } : { a: ms, b: 0 };
}

/** Runs `a` and `b` together with the start delays of `round`; both settle before this returns. */
export async function race(
  round: number,
  a: () => Promise<unknown>,
  b: () => Promise<unknown>,
): Promise<{
  offsets: { a: number; b: number };
  a: PromiseSettledResult<unknown>;
  b: PromiseSettledResult<unknown>;
}> {
  const offsets = offsetsFor(round);
  const [ra, rb] = await Promise.allSettled([sleep(offsets.a).then(a), sleep(offsets.b).then(b)]);
  return { offsets, a: ra, b: rb };
}

export interface Waiter {
  pid: number;
  locktype: string;
  mode: string;
}

/** Ungranted locks of other sessions in this test's database (Postgres is shared with other test files). */
export async function ungrantedLocks(pool: QueryPool): Promise<Waiter[]> {
  const { rows } = await pool.query(
    `SELECT l.pid, l.locktype, l.mode
       FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE NOT l.granted AND a.datname = current_database()
      ORDER BY l.pid`,
  );
  return rows as Waiter[];
}

/** Waits until `n` distinct sessions wait on a lock, `stop()` turns true, or `timeoutMs` passes. */
export async function waitForWaiters(
  pool: QueryPool,
  n: number,
  stop: () => boolean,
  timeoutMs: number,
): Promise<{ reached: boolean; waiters: Waiter[] }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const waiters = await ungrantedLocks(pool);
    if (new Set(waiters.map((w) => w.pid)).size >= n) return { reached: true, waiters };
    if (stop() || Date.now() > deadline) return { reached: false, waiters };
    await sleep(20);
  }
}

/**
 * Holds the tenant's audit-chain advisory lock (the one every audited write takes, until COMMIT:
 * packages/db/migrations/0008_audit_hardening.sql:111) on a connection of its own until `release()`.
 */
export async function holdAuditChainLock(
  pool: ConnectPool,
  tenantId: string,
): Promise<{ release: () => Promise<void> }> {
  const client = await pool.connect();
  await client.query('BEGIN');
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended('audit.chain:' || $1::text, 0))`,
    [tenantId],
  );
  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      try {
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    },
  };
}

export interface ForcedRound {
  first: PromiseSettledResult<unknown>;
  second: PromiseSettledResult<unknown>;
  /** Whether `first` was seen waiting before `second` started, and both were seen waiting before the release. */
  firstWaited: boolean;
  bothWaited: boolean;
  waiters: Waiter[];
}

/**
 * One forced interleaving: a third connection holds the tenant's audit-chain lock; `first` starts and runs until it
 * waits (for an operation that claims an Idempotency-Key first, at that claim); then `second` starts and runs until
 * it waits too (on the audit lock or on a row `first` holds); then the lock is released and the queue decides. The
 * release comes within 2.5 s (1 s for `first` to wait, 1.5 s for both), half withTx's 5 s lock_timeout, so a waiter
 * never times out under a slow machine. Callers assert `firstWaited` and `bothWaited`: without them the round is an
 * ordinary race, not the order it claims.
 */
export async function forcedRound(
  lockPool: ConnectPool,
  watchPool: QueryPool,
  tenantId: string,
  first: () => Promise<unknown>,
  second: () => Promise<unknown>,
): Promise<ForcedRound> {
  const blocker = await holdAuditChainLock(lockPool, tenantId);
  let settled = 0;
  let p1: Promise<unknown> = Promise.resolve();
  let p2: Promise<unknown> = Promise.resolve();
  let firstWaited = false;
  let bothWaited = false;
  let waiters: Waiter[] = [];
  try {
    p1 = first().finally(() => (settled += 1));
    p1.catch(() => undefined);
    firstWaited = (await waitForWaiters(watchPool, 1, () => settled > 0, 1000)).reached;
    p2 = second().finally(() => (settled += 1));
    p2.catch(() => undefined);
    const seen = await waitForWaiters(watchPool, 2, () => settled > 0, 1500);
    bothWaited = seen.reached;
    waiters = seen.waiters;
  } finally {
    await blocker.release();
  }
  const [r1, r2] = await Promise.allSettled([p1, p2]);
  return { first: r1, second: r2, firstWaited, bothWaited, waiters };
}

/** Counts of each side's outcome and of each outcome pair over the rounds. */
export function tally<R extends Record<string, unknown>>(
  rounds: readonly R[],
  sides: readonly (keyof R & string)[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
  for (const r of rounds) {
    for (const side of sides) bump(`${side}:${String(r[side])}`);
    bump(`pair:${sides.map((s) => String(r[s])).join(' / ')}`);
  }
  return counts;
}
