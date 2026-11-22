// Local denial after a failed or ambiguous write to ZITADEL (FU8, round 3).
// BOS never tries to undo a ZITADEL write: it cannot know what ZITADEL holds after a timeout, a refusal in the middle of
// a multi-step change, or a webhook sync that already copied the change. So:
//   - any failed or ambiguous identity write (a status action, a role set, an invite) closes the person's row and sets
//     `identity_review_required` in its own transaction. A trigger (migration 0190) keeps a flagged row from ever being
//     'active', whoever writes it; sync never clears the flag; an admin resolves it after reading ZITADEL again;
//   - there is no compensation in ZITADEL: no grants replaced, no role stripped or re-granted, no identity deleted;
//   - one best-effort remote close (lock or deactivate) is attempted after the local write, and it does not depend on
//     the local write having worked;
//   - the local change and the remote outcome are audited separately (`identity.review_required`, `identity.reconciled`).
// ZITADEL is called with no transaction open. The row is written under the access-revision lock, the order every access
// write takes (access_revisions -> user row -> audit chain). `denyAfterFailure` never throws: the caller rethrows its own
// error.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import { ConflictException, Logger, ServiceUnavailableException } from '@nestjs/common';

import { lockAccessRevision } from '../../modules/access-settings/access-revision';
import type { AuditService } from '../audit/audit.service';
import type { Db, DbTransaction } from '../db/db.module';
import { type Actor, type TxOptions, type TxScope, systemActor, withTx } from '../db/tx';
import {
  assertWithinOperationDeadline,
  OPERATION_DEADLINE_MS,
  runOutsideOperationDeadline,
  runWithOperationDeadline,
} from './operation-deadline';
import type { PendingFounderRemoval, UserLock, UsersStore } from './users.store';
import {
  type ZitadelAdminClient,
  ZitadelHttpError,
  ZitadelNotConfiguredError,
  type ZitadelUser,
} from './zitadel-admin.client';

/** The row is closed and flagged: what changed locally. */
export const IDENTITY_REVIEW_REQUIRED = 'identity.review_required';
/** The best-effort close in ZITADEL: what the remote side answered. */
export const IDENTITY_RECONCILED = 'identity.reconciled';
/** An admin read ZITADEL again and cleared the flag. */
export const IDENTITY_REVIEW_RESOLVED = 'identity.review_resolved';

/** What the denial may call in ZITADEL: read, and close a person. Never open, grant, replace or delete. */
export type CloseOnlyIdentity = Pick<ZitadelAdminClient, 'getUser' | 'lockUser' | 'deactivateUser'>;

// Takes the access-revision lock before the user row lock and the first audited write, like every other access write.
const AFTER_ACCESS_LOCK: TxOptions = { audit: 'lazy' };

/** Waits before each round of closing a person in ZITADEL; the first round is immediate. */
const CLOSE_DELAYS_MS = [0, 250, 1_000] as const;

const errorName = (error: unknown): string => (error instanceof Error ? error.name : 'error');

const adminLock = (): UserLock => ({ reason: 'admin', lockedAt: new Date(), until: null });

/** A ZITADEL answer that says nothing was applied: a 4xx refusal, or no ZITADEL configured. */
export function isDefiniteRefusal(error: unknown): boolean {
  if (error instanceof ZitadelNotConfiguredError) return true;
  if (error instanceof ConflictException) return true; // identityCall maps a 4xx refusal to 409 identity_refused
  return error instanceof ZitadelHttpError && error.status >= 400 && error.status < 500;
}

const isClosed = (live: ZitadelUser | null | undefined): boolean =>
  live !== undefined && live !== null && (live.status === 'inactive' || live.locked === true);

export interface DenySpec {
  /** Why, for the audit rows (the action that failed). */
  reason: string;
  /** The row to close: by id, or by ZITADEL id. */
  userId?: string;
  zitadelUserId: string;
  /** Writes the closed row of a person who has none yet (an invite that failed before its write), returning its id. */
  createRow?: (tx: DbTransaction) => Promise<string>;
  /** The best-effort remote close, or null for none (role sets and invites are denied locally only). */
  close: 'lock' | 'deactivate' | null;
  /**
   * The lease was lost: the row is still closed and flagged (with the admin lock `close: 'lock'` asks for), but no
   * ZITADEL call is made, since past the lease fence it could not start anyway.
   */
  localOnly?: boolean;
}

export class IdentityReconciler {
  private readonly logger = new Logger('IdentityReconciler');

  constructor(
    private readonly db: Db,
    private readonly store: UsersStore,
    private readonly zitadel: CloseOnlyIdentity,
    private readonly audit: AuditService,
  ) {}

  /**
   * Closes and flags the person in the database, then tries one remote close, then audits both separately. The remote
   * close runs even when the local write failed. Never throws.
   */
  async denyAfterFailure(scope: TxScope, actor: Actor, spec: DenySpec): Promise<void> {
    let local: {
      id: string;
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    } | null = null;
    let localFailed = false;
    try {
      const written = await withTx(
        this.db,
        scope,
        systemActor('identity-reconcile', actor.correlationId),
        async (tx) => {
          await lockAccessRevision(tx, scope.tenantId);
          // A holder whose lease was taken over writes nothing more: its recorded removal is the record, and the new
          // holder has flagged the person already.
          if (
            spec.userId !== undefined &&
            (await settleOwnFounderRemoval(tx, spec.userId)) === 'lost'
          ) {
            return 'lease_lost' as const;
          }
          let row =
            spec.userId !== undefined
              ? await this.store.findById(tx, scope, spec.userId, true)
              : await this.store.findByZitadelId(tx, spec.zitadelUserId, true);
          if (!row && spec.createRow) {
            row = await this.store.findById(tx, scope, await spec.createRow(tx), true);
          }
          if (!row) return null;
          // A locked person stays locked as an admin lock (a timed lock would be lifted when its window ends); an
          // invited row keeps its status and takes no lock.
          const lock =
            spec.close === 'lock' && row.status !== 'invited' && row.lockReason !== 'admin'
              ? adminLock()
              : undefined;
          await this.store.flagIdentityReview(tx, row.id, lock);
          await this.store.bumpAuthzVersion(tx, scope);
          return {
            id: row.id,
            before: {
              status: row.status,
              lockReason: row.lockReason ?? null,
              reviewRequired: row.identityReviewRequired === true,
            },
            after: {
              status: row.status === 'active' ? 'inactive' : row.status,
              lockReason: lock ? lock.reason : (row.lockReason ?? null),
              reviewRequired: true,
            },
          };
        },
        AFTER_ACCESS_LOCK,
      );
      if (written === 'lease_lost') {
        this.logger.error(
          `users.review: lease taken over before ${spec.zitadelUserId} was flagged; left to the new holder`,
        );
        return;
      }
      local = written;
    } catch (error) {
      localFailed = true;
      this.logger.error(
        `users.review: could not flag ${spec.zitadelUserId} (kind=${errorName(error)}); trying the remote close anyway`,
      );
    }

    const remote =
      spec.close === null || spec.localOnly === true
        ? null
        : await runOutsideOperationDeadline(() =>
            this.closeInZitadel(spec.zitadelUserId, spec.close!),
          );

    if (local) {
      await this.record(scope, actor, IDENTITY_REVIEW_REQUIRED, local.id, {
        reason: spec.reason,
        before: local.before,
        after: local.after,
      });
    }
    if (remote !== null) {
      await this.record(scope, actor, IDENTITY_RECONCILED, local?.id ?? spec.userId ?? null, {
        reason: spec.reason,
        zitadelUserId: spec.zitadelUserId,
        close: spec.close,
        outcome: remote,
        localChange: localFailed ? 'failed' : local ? 'committed' : 'none',
      });
    }
  }

  /**
   * Settles a Founder removal the previous lease holder recorded and never cleared (it crashed, or stalled until its
   * lease was taken over): ZITADEL may already have removed that person, so the row is closed and flagged for review
   * now, as after any ambiguous write, and the record is cleared in the same transaction. The flag is set whatever the
   * row shows: a sync may already have mirrored the removal (a fresh admin lock reads as a timed failed-sign-in lock,
   * which the expiry job would lift), so an inherited lock is pinned as an admin lock. No ZITADEL call. Throws when it
   * cannot finish; the record then stays on the lease.
   */
  async settleOutstandingRemoval(
    scope: TxScope,
    actor: Actor,
    removal: PendingFounderRemoval,
    clearRecord: (tx: DbTransaction) => Promise<boolean>,
  ): Promise<void> {
    const local = await withTx(
      this.db,
      scope,
      systemActor('identity-reconcile', actor.correlationId),
      async (tx) => {
        await lockAccessRevision(tx, scope.tenantId);
        if (!(await clearRecord(tx))) throw new FounderLeaseLostError();
        const row = await this.store.findById(tx, scope, removal.userId, true);
        if (!row) return null;
        const lock =
          removal.intent === 'lock' && row.lockReason !== 'admin' ? adminLock() : undefined;
        await this.store.flagIdentityReview(tx, row.id, lock);
        await this.store.bumpAuthzVersion(tx, scope);
        return {
          id: row.id,
          before: {
            status: row.status,
            lockReason: row.lockReason ?? null,
            reviewRequired: row.identityReviewRequired === true,
          },
          after: {
            status: row.status === 'active' ? 'inactive' : row.status,
            lockReason: lock ? lock.reason : (row.lockReason ?? null),
            reviewRequired: true,
          },
        };
      },
      AFTER_ACCESS_LOCK,
    );
    if (local) {
      await this.record(scope, actor, IDENTITY_REVIEW_REQUIRED, local.id, {
        reason: `users.${removal.intent}:lease_taken_over`,
        before: local.before,
        after: local.after,
      });
    }
  }

  /** One best-effort close; never throws. Returns what ZITADEL ended up as far as this call could tell. */
  private async closeInZitadel(
    zitadelUserId: string,
    kind: 'lock' | 'deactivate',
  ): Promise<'closed' | 'failed'> {
    const order =
      kind === 'lock' ? (['lock', 'deactivate'] as const) : (['deactivate', 'lock'] as const);
    let last: unknown;
    for (const delay of CLOSE_DELAYS_MS) {
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      for (const call of order) {
        try {
          if (call === 'lock') await this.zitadel.lockUser(zitadelUserId);
          else await this.zitadel.deactivateUser(zitadelUserId);
          return 'closed';
        } catch (error) {
          last = error;
          if (error instanceof ZitadelNotConfiguredError) return 'failed';
          if (!isDefiniteRefusal(error)) break;
          // A refusal usually means ZITADEL is already closed (it refuses to lock a locked person): look before trying
          // the other close.
          if (isClosed(await this.zitadel.getUser(zitadelUserId).catch(() => undefined))) {
            return 'closed';
          }
        }
      }
      const live = await this.zitadel.getUser(zitadelUserId).catch(() => undefined);
      if (isClosed(live)) return 'closed';
    }
    this.logger.error(
      `users.review: could not close ${zitadelUserId} in ZITADEL (kind=${errorName(last)}); the row stays closed and flagged`,
    );
    return 'failed';
  }

  /** An audit row in its own transaction, so a failing audit write can never undo the closing write. Never throws. */
  private async record(
    scope: TxScope,
    actor: Actor,
    action: string,
    entityId: string | null,
    detail: Record<string, unknown>,
  ): Promise<void> {
    if (entityId === null) return;
    try {
      await withTx(this.db, scope, systemActor('identity-reconcile', actor.correlationId), (tx) =>
        this.audit.record(tx, {
          action,
          entityType: 'users',
          entityId,
          meta: { ...detail, requestedBy: actor.kind === 'user' ? actor.id : actor.kind },
        }),
      );
    } catch (error) {
      this.logger.warn(`users.review: could not audit ${action} (kind=${errorName(error)})`);
    }
  }
}

/** Waits up to this long for another identity change of the tenant before answering 409. */
const LEASE_WAIT_MS = 3_000;
const LEASE_POLL_MS = 150;
/**
 * A lease older than this is dead (its holder crashed or stalled) and is taken over. It is far longer than the
 * operation's own deadline plus the slowest in-flight provider call and the best-effort close, so a live holder is
 * never overtaken while it can still change ZITADEL.
 */
const LEASE_TTL_SECONDS = 300;
/**
 * The lease fence: this long after its claim started, a holder starts no provider call at all (the best-effort close
 * included). The margin to the TTL covers one provider request in flight (10 s timeout) and clock drift.
 */
const LEASE_FENCE_MS = (LEASE_TTL_SECONDS - 60) * 1000;
export { assertWithinOperationDeadline, OPERATION_DEADLINE_MS } from './operation-deadline';

/** The lease the current operation holds (see withFounderRemovalLease). */
interface LeaseHolder {
  store: UsersStore;
  tenantId: string;
  leaseId: string;
  /** The person whose removal this holder recorded on the lease, until the write that shows it clears it. */
  removalOf: string | null;
}

const lease = new AsyncLocalStorage<LeaseHolder>();

/** The operation's lease was taken over (it stalled past the TTL): it changes nothing more. */
export class FounderLeaseLostError extends ServiceUnavailableException {
  constructor() {
    super('This change took too long and was stopped. Reload the page and check the person.');
  }
}

/**
 * Call right before the first provider call that may take a Founder away (a deactivate or lock, a role set): records
 * the removal on the lease, so a holder that takes the lease over after this one stalled sees it and flags the person
 * before its own last-Founder guard runs. Throws FounderLeaseLostError (503) when the lease is no longer held, or the
 * deadline's 503 when it passed meanwhile; then no provider call may start.
 */
export async function recordFounderRemoval(
  target: { id: string; zitadelUserId: string },
  intent: string,
): Promise<void> {
  const holder = lease.getStore();
  if (!holder) throw new Error('recordFounderRemoval runs only under withFounderRemovalLease');
  const recorded = await holder.store.recordFounderRemoval(holder.tenantId, holder.leaseId, {
    userId: target.id,
    zitadelUserId: target.zitadelUserId,
    intent,
  });
  if (!recorded) throw new FounderLeaseLostError();
  holder.removalOf = target.id;
  // Past the deadline now, nothing has changed in ZITADEL yet: drop the record before the 503 goes out.
  try {
    assertWithinOperationDeadline();
  } catch (error) {
    await dropOwnFounderRemoval(target.id);
    throw error;
  }
}

/**
 * Inside the transaction of a write about `userId`, right after the access-revision lock: when this holder recorded a
 * removal of `userId`, clears it (it commits with the write, or is undone with it) and checks the lease is still held,
 * keeping the lease row locked until the transaction ends. 'lost': the lease was taken over, write nothing.
 */
export async function settleOwnFounderRemoval(
  tx: DbTransaction,
  userId: string,
): Promise<'none' | 'held' | 'lost'> {
  const holder = lease.getStore();
  if (!holder || holder.removalOf !== userId) return 'none';
  return (await holder.store.settleFounderRemoval(holder.tenantId, holder.leaseId, tx))
    ? 'held'
    : 'lost';
}

/** Whether this holder recorded a Founder removal of `userId` on its lease (then a successor settles it). */
export function recordedFounderRemovalOf(userId: string): boolean {
  return lease.getStore()?.removalOf === userId;
}

/**
 * For the final write of every lease-protected change, right after the access-revision lock: checks the lease is still
 * held and keeps its row locked until the transaction ends, whether or not a removal was recorded (a stalled role set
 * that grants Founder must not land after a takeover either). Clears this holder's own record with the write. Throws
 * FounderLeaseLostError (503) when the lease was taken over; then nothing is written.
 */
export async function assertFounderLeaseHeld(tx: DbTransaction): Promise<void> {
  const holder = lease.getStore();
  if (!holder) return;
  if (!(await holder.store.settleFounderRemoval(holder.tenantId, holder.leaseId, tx))) {
    throw new FounderLeaseLostError();
  }
}

/**
 * After a refusal that changed nothing in ZITADEL: drops this holder's own record of removing `userId`. Best effort; a
 * record left behind only makes the next holder flag the person for review.
 */
export async function dropOwnFounderRemoval(userId: string): Promise<void> {
  const holder = lease.getStore();
  if (!holder || holder.removalOf !== userId) return;
  await holder.store.settleFounderRemoval(holder.tenantId, holder.leaseId).catch(() => undefined);
}

/**
 * Settles an outstanding removal inherited with the lease (IdentityReconciler.settleOutstandingRemoval); `clearRecord`
 * clears it inside the caller's transaction and says whether the lease is still held.
 */
export type SettleOutstandingRemoval = (
  removal: PendingFounderRemoval,
  clearRecord: (tx: DbTransaction) => Promise<boolean>,
) => Promise<void>;

/**
 * Runs `fn` while holding the tenant's identity lease, so two actions that change who can sign in (deactivate, lock,
 * unlock, reactivate, a role set, an invite) never run their guard, ZITADEL call and write interleaved: the second
 * waits (3 s at most, bounded in the claim statement itself), then sees the first one's result. A transaction lock
 * cannot span a ZITADEL call. The operation has a hard deadline (`OPERATION_DEADLINE_MS`) after which no provider
 * mutation starts, and a lease fence after which no provider call starts at all; the lease TTL is longer than both.
 * Never held across a database connection.
 *
 * A holder records a possible Founder removal on the lease before its provider call (recordFounderRemoval) and clears
 * it in the transaction that writes the outcome. A removal still recorded when the lease passes on (its holder crashed,
 * or stalled past the TTL after ZITADEL already closed the person) goes with the lease: the next holder settles it with
 * `settleOutstanding` before `fn` runs, so its last-Founder guard counts that person as removed. Without a settler, or
 * when settling fails, the operation is refused and the record stays.
 */
export async function withFounderRemovalLease<T>(
  store: UsersStore,
  tenantId: string,
  fn: () => Promise<T>,
  deadlineMs: number = OPERATION_DEADLINE_MS,
  settleOutstanding?: SettleOutstandingRemoval,
): Promise<T> {
  const leaseId = randomUUID();
  const giveUpAt = Date.now() + LEASE_WAIT_MS;
  let claimStartedAt = Date.now();
  for (;;) {
    claimStartedAt = Date.now();
    const remaining = giveUpAt - claimStartedAt;
    if (
      await store.claimFounderLease(tenantId, leaseId, LEASE_TTL_SECONDS, Math.max(remaining, 100))
    ) {
      break;
    }
    if (Date.now() >= giveUpAt) {
      throw new ConflictException({
        code: 'conflict',
        message: 'Another change to who can sign in is in progress. Try again in a moment.',
      });
    }
    await new Promise((resolve) => setTimeout(resolve, LEASE_POLL_MS));
  }
  // Measured from before the winning claim statement, so the fence never ends later than the database thinks.
  const fenceAt = claimStartedAt + LEASE_FENCE_MS;
  try {
    const inherited = await store.outstandingFounderRemoval(tenantId, leaseId);
    if (inherited) {
      if (!settleOutstanding) {
        throw new ConflictException({
          code: 'conflict',
          message:
            'An earlier change to who can sign in is still being settled. Try again in a moment.',
        });
      }
      try {
        await settleOutstanding(inherited, (tx) =>
          store.settleFounderRemoval(tenantId, leaseId, tx),
        );
      } catch {
        throw new ServiceUnavailableException(
          'An earlier change to who can sign in could not be settled. Try again in a moment.',
        );
      }
    }
    return await lease.run({ store, tenantId, leaseId, removalOf: null }, () =>
      runWithOperationDeadline(deadlineMs, fn, fenceAt),
    );
  } finally {
    await store.releaseFounderLease(tenantId, leaseId).catch(() => undefined);
  }
}
