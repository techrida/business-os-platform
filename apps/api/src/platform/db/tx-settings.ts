import type { DbBusyKind } from './busy';

export const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
export const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;
export const DEFAULT_IDLE_IN_TX_TIMEOUT_MS = 30_000;

export interface TxTimeouts {
  lockTimeoutMs: number;
  /** How long one statement inside withTx may run, then 57014. */
  statementTimeoutMs: number;
  idleInTxTimeoutMs: number;
}

export type TxOutcome = 'commit' | 'rollback';

/** Receives what each withTx did; MetricsService implements it (wired in DbModule). */
export interface TxObserver {
  observeTx(outcome: TxOutcome, setupSeconds: number | undefined, totalSeconds: number): void;
  countDbBusy(kind: DbBusyKind): void;
  /** Seconds a withTx waited for its tenant's audit-chain lock (the first statement after the settings). */
  observeTenantLockWait(seconds: number): void;
}

// Process-wide, because withTx is a plain function called from everywhere. DbModule sets them from
// config at startup; code that never builds DbModule (unit tests, scripts) runs with the defaults.
let timeouts: TxTimeouts = {
  lockTimeoutMs: DEFAULT_LOCK_TIMEOUT_MS,
  statementTimeoutMs: DEFAULT_STATEMENT_TIMEOUT_MS,
  idleInTxTimeoutMs: DEFAULT_IDLE_IN_TX_TIMEOUT_MS,
};
let observer: TxObserver | undefined;

function timeoutOrDefault(value: number | undefined, fallback: number, what: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${what} must be a non-negative integer`);
  }
  return value;
}

/** Sets the timeouts of every later withTx. A missing value means the default; 0 disables that timeout. */
export function configureTx(settings: Partial<TxTimeouts>): void {
  timeouts = {
    lockTimeoutMs: timeoutOrDefault(
      settings.lockTimeoutMs,
      DEFAULT_LOCK_TIMEOUT_MS,
      'lockTimeoutMs',
    ),
    statementTimeoutMs: timeoutOrDefault(
      settings.statementTimeoutMs,
      DEFAULT_STATEMENT_TIMEOUT_MS,
      'statementTimeoutMs',
    ),
    idleInTxTimeoutMs: timeoutOrDefault(
      settings.idleInTxTimeoutMs,
      DEFAULT_IDLE_IN_TX_TIMEOUT_MS,
      'idleInTxTimeoutMs',
    ),
  };
}

export function txTimeouts(): TxTimeouts {
  return timeouts;
}

export function setTxObserver(next: TxObserver | undefined): void {
  observer = next;
}

export function txObserver(): TxObserver | undefined {
  return observer;
}
