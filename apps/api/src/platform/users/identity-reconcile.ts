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
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

import { ConflictException, Logger, ServiceUnavailableException } from '@nestjs/common';

import { lockAccessRevision } from '../../modules/access-settings/access-revision';
import type { AuditService } from '../audit/audit.service';
import type { Db, DbTransaction } from '../db/db.module';
import { type Actor, type TxOptions, type TxScope, systemActor, withTx } from '../db/tx';
import type { UserLock, UsersStore } from './users.store';
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
      local = await withTx(
        this.db,
        scope,
        systemActor('identity-reconcile', actor.correlationId),
        async (tx) => {
          await lockAccessRevision(tx, scope.tenantId);
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
    } catch (error) {
      localFailed = true;
      this.logger.error(
        `users.review: could not flag ${spec.zitadelUserId} (kind=${errorName(error)}); trying the remote close anyway`,
      );
    }

    const remote =
      spec.close === null ? null : await this.closeInZitadel(spec.zitadelUserId, spec.close);

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
 * A lease older than this is dead (its holder crashed) and is taken over. It is far longer than the operation's own
 * deadline plus the slowest in-flight provider call and the best-effort close, so a live holder is never overtaken.
 */
const LEASE_TTL_SECONDS = 300;
/** After this long a guarded operation starts no more provider mutations (a best-effort close is still allowed). */
export const OPERATION_DEADLINE_MS = 60_000;

const operation = new AsyncLocalStorage<{ startedAt: number; deadlineMs: number }>();

/**
 * Call before every provider mutation of a guarded operation: throws 503 once the operation has run past its hard
 * deadline, so nothing new starts while the lease could be about to be taken over.
 */
export function assertWithinOperationDeadline(): void {
  const current = operation.getStore();
  if (current && Date.now() - current.startedAt > current.deadlineMs) {
    throw new ServiceUnavailableException('This change took too long. Try again.');
  }
}

/**
 * Runs `fn` while holding the tenant's identity lease, so two actions that change who can sign in (deactivate, lock,
 * unlock, reactivate, a role set, an invite) never run their guard, ZITADEL call and write interleaved: the second
 * waits (3 s at most, bounded in the claim statement itself), then sees the first one's result. A transaction lock
 * cannot span a ZITADEL call. The operation has a hard deadline (`OPERATION_DEADLINE_MS`) after which no provider
 * mutation starts, and the lease TTL is longer than that deadline plus everything still allowed after it. Never held
 * across a database connection.
 */
export async function withFounderRemovalLease<T>(
  store: UsersStore,
  tenantId: string,
  fn: () => Promise<T>,
  deadlineMs: number = OPERATION_DEADLINE_MS,
): Promise<T> {
  const leaseId = randomUUID();
  const giveUpAt = Date.now() + LEASE_WAIT_MS;
  for (;;) {
    const remaining = giveUpAt - Date.now();
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
  try {
    return await operation.run({ startedAt: Date.now(), deadlineMs }, fn);
  } finally {
    await store.releaseFounderLease(tenantId, leaseId).catch(() => undefined);
  }
}
