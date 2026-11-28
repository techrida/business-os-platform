/**
 * Postgres refusals that mean "the database was busy, try the same request again": a deadlock victim
 * (40P01), a lock wait longer than `lock_timeout` (55P03) or a statement that ran longer than
 * `statement_timeout` (57014, query_canceled). The transaction was rolled back, so a retry with the same
 * idempotency key runs it afresh.
 */
export type DbBusyKind = 'deadlock' | 'lock_timeout' | 'statement_timeout';

const BUSY_CODES: Readonly<Record<string, DbBusyKind>> = {
  '40P01': 'deadlock',
  '55P03': 'lock_timeout',
  '57014': 'statement_timeout',
};

const MAX_CAUSE_DEPTH = 5;

/** The SQLSTATE of a pg error, also when drizzle wraps it (`DrizzleQueryError.cause`). */
export function pgErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) return undefined;
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === 'string') return code;
    current = cause;
  }
  return undefined;
}

export function dbBusyKindOf(error: unknown): DbBusyKind | undefined {
  const code = pgErrorCode(error);
  return code === undefined ? undefined : BUSY_CODES[code];
}

/** Seconds a client should wait before retrying: a deadlock clears at once, a held lock may not. */
export const DB_BUSY_RETRY_AFTER_SECONDS: Readonly<Record<DbBusyKind, number>> = {
  deadlock: 1,
  lock_timeout: 2,
  statement_timeout: 5,
};
