// Fail-closed reconcile for the admin actions that change a person in ZITADEL and then in the database (FU8).
// Serves the NFR "a removed user must stop working": after a failed or conflicting write the code never replays a
// stored snapshot into ZITADEL. It reads what ZITADEL and the row say NOW and lets the closing state win:
//   - if either side says locked, deactivated or role-removed, the row ends closed and ZITADEL is closed if it is open;
//   - an undo never opens access (no unlock, no reactivate, no role added) and never deletes an identity;
//   - what differed is audited as `identity.reconciled`.
// ZITADEL is read and written with no transaction open; the row is read and written under the access-revision lock
// and the user row lock, the order every access write takes (access_revisions -> user row -> audit chain).
// `reconcile*` never throws: the caller rethrows its own error, and a later sync or admin action opens access again.
import { randomUUID } from 'node:crypto';

import type { RoleKey } from '@bos/contracts';
import { ConflictException, Logger } from '@nestjs/common';

import { lockAccessRevision } from '../../modules/access-settings/access-revision';
import type { AuditService } from '../audit/audit.service';
import type { Db } from '../db/db.module';
import { type Actor, type TxOptions, type TxScope, systemActor, withTx } from '../db/tx';
import type { UserLock, UserRow, UsersStore } from './users.store';
import {
  type ZitadelAdminClient,
  ZitadelHttpError,
  ZitadelNotConfiguredError,
  type ZitadelUser,
} from './zitadel-admin.client';

export const IDENTITY_RECONCILED = 'identity.reconciled';

/** What reconcile may call in ZITADEL: it can read, close a person and shrink their grants, never open or add. */
export type CloseOnlyIdentity = Pick<
  ZitadelAdminClient,
  'getUser' | 'listGrants' | 'setGrants' | 'lockUser' | 'deactivateUser'
>;

// Takes the access-revision lock before the user row lock and the first audited write, like every other access write.
const AFTER_ACCESS_LOCK: TxOptions = { audit: 'lazy' };

/** Waits before each round of closing a person in ZITADEL; the first round is immediate. */
const CLOSE_DELAYS_MS = [0, 250, 1_000] as const;

const errorName = (error: unknown): string => (error instanceof Error ? error.name : 'error');

export const isRowShutOut = (row: UserRow): boolean =>
  row.status !== 'active' || (row.lockReason ?? null) !== null;

const adminLock = (): UserLock => ({ reason: 'admin', lockedAt: new Date(), until: null });

type LiveState = 'open' | 'closed' | 'unknown' | 'missing';

function liveStateOf(live: ZitadelUser | null | undefined): LiveState {
  if (live === undefined) return 'unknown';
  if (live === null) return 'missing';
  if (live.status === null) return 'unknown';
  return live.status === 'inactive' || live.locked === true ? 'closed' : 'open';
}

export interface StatusDecision {
  /** The closed state to write to the row, or null to keep the row as it is. */
  closeRow: { lock: UserLock | null } | null;
  /** The ZITADEL call that closes the person, or null when ZITADEL needs none. */
  closeZitadel: 'lock' | 'deactivate' | null;
  /** What differed, for the audit row; null when there is nothing to reconcile. */
  differed: Record<string, unknown> | null;
}

/**
 * Closed wins. `failedOpening` is set for an unlock or reactivate that failed: an action that did not happen counts
 * as a closed side, so the person ends shut out (never opened by an undo, only left closed). `lock` says whether
 * they were locked (rather than deactivated) before it.
 */
export function decideStatusReconcile(input: {
  row: UserRow | null;
  live: ZitadelUser | null | undefined;
  failedOpening: { lock: boolean } | null;
}): StatusDecision {
  const none: StatusDecision = { closeRow: null, closeZitadel: null, differed: null };
  const { row, live, failedOpening } = input;
  if (!row) return none;
  const rowClosed = isRowShutOut(row);
  const liveState = liveStateOf(live);
  if (!rowClosed && liveState !== 'closed' && failedOpening === null) return none;

  // A lock (admin or timed) is held as LOCKED in ZITADEL; anything else closed is a deactivation.
  const locked = rowClosed
    ? (row.lockReason ?? null) !== null
    : liveState === 'closed'
      ? live?.locked === true
      : (failedOpening?.lock ?? false);
  const closeRow = rowClosed ? null : { lock: locked ? adminLock() : null };
  const closeZitadel = liveState === 'open' || liveState === 'unknown' ? (locked ? 'lock' : 'deactivate') : null;
  if (closeRow === null && closeZitadel === null) return none;
  return {
    closeRow,
    closeZitadel,
    differed: {
      row: { status: row.status, lockReason: row.lockReason ?? null },
      zitadel:
        live === undefined
          ? 'unreadable'
          : live === null
            ? 'missing'
            : { status: live.status, locked: live.locked === true },
      failedOpening: failedOpening !== null,
      closedRow: closeRow !== null,
      closedZitadel: closeZitadel,
    },
  };
}

export interface RolesDecision {
  /** The grants ZITADEL should hold after reconcile; always a subset of what it holds now. */
  target: RoleKey[];
  removed: RoleKey[];
}

/**
 * A role survives only if ZITADEL still holds it AND it is allowed. Allowed is what the database commits now, minus
 * the roles this failed request added (it did not happen). With no row (or an unreadable one) it is what the person
 * held before the request and the request kept. Never adds a role, so a role another admin just revoked stays gone.
 */
export function decideRolesReconcile(input: {
  live: readonly RoleKey[];
  committed: readonly RoleKey[] | null;
  previous: readonly RoleKey[];
  requested: readonly RoleKey[];
}): RolesDecision {
  const added = new Set(input.requested.filter((r) => !input.previous.includes(r)));
  const allowed =
    input.committed !== null
      ? new Set(input.committed.filter((r) => !added.has(r)))
      : new Set(input.previous.filter((r) => input.requested.includes(r)));
  const target = [...new Set(input.live)].filter((r) => allowed.has(r));
  const removed = [...new Set(input.live)].filter((r) => !allowed.has(r));
  return { target, removed };
}

export class IdentityReconciler {
  private readonly logger = new Logger(IdentityReconciler.name);

  constructor(
    private readonly db: Db,
    private readonly store: UsersStore,
    private readonly zitadel: CloseOnlyIdentity,
    private readonly audit: AuditService,
  ) {}

  /**
   * After an admin status action failed or conflicted (or left a half-done multi-step change): reads ZITADEL with no
   * transaction open, then under the locks reads the row, writes it closed when either side is closed, audits what
   * differed and closes ZITADEL when it is still open. `failedOpening` is set for unlock and reactivate.
   */
  async reconcileStatus(
    scope: TxScope,
    actor: Actor,
    target: UserRow,
    failedOpening: { lock: boolean } | null,
  ): Promise<void> {
    try {
      const live = await this.zitadel.getUser(target.zitadelUserId).catch(() => undefined);
      const decision = await withTx(
        this.db,
        scope,
        systemActor('identity-reconcile', actor.correlationId),
        async (tx) => {
          await lockAccessRevision(tx, scope.tenantId);
          const row = await this.store.findById(tx, scope, target.id, true);
          const decided = decideStatusReconcile({ row, live, failedOpening });
          if (row && decided.closeRow !== null) {
            await this.store.updateUser(tx, row.id, {
              email: row.email,
              displayName: row.displayName,
              status: 'inactive',
              lock: decided.closeRow.lock,
            });
            // Every process drops its cached principals at once, so the closed person is refused on their next request.
            await this.store.bumpAuthzVersion(tx, scope);
          }
          return decided;
        },
        AFTER_ACCESS_LOCK,
      );
      if (decision.closeZitadel !== null) {
        await this.closeInZitadel(target.zitadelUserId, decision.closeZitadel);
      }
      if (decision.differed !== null) {
        await this.recordReconciled(scope, actor, 'users', target.id, decision.differed);
      }
    } catch (error) {
      this.logger.error(
        `users.reconcile: could not reconcile ${target.id} after a failed change (kind=${errorName(error)}); the next sync mirrors what ZITADEL holds`,
      );
    }
  }

  /**
   * Shrinks a person's grants in ZITADEL after a failed setRoles or invite to what ZITADEL still holds and the database
   * still allows (decideRolesReconcile). Reads ZITADEL first with no transaction open and writes nothing without that
   * read. `skipWhenRowExists` is for an identity this request created: a row means a concurrent invite committed it, so
   * it is theirs and is left alone. `skipWhenNoRow` is for a request on an existing user whose row is gone.
   */
  async reconcileRoles(
    scope: TxScope,
    actor: Actor,
    p: {
      zitadelUserId: string;
      zitadelOrgId: string;
      idpOrgId: string;
      requested: readonly RoleKey[];
      previous: readonly RoleKey[];
      skipWhenRowExists?: boolean;
      skipWhenNoRow?: boolean;
    },
  ): Promise<void> {
    try {
      const live = await this.zitadel.listGrants(p.zitadelUserId, p.zitadelOrgId);
      let decided: RolesDecision | null;
      const note: { audited: boolean; row: string | null; before: Record<string, unknown> } = {
        audited: false,
        row: null,
        before: {},
      };
      try {
        decided = await withTx(
          this.db,
          scope,
          systemActor('identity-reconcile', actor.correlationId),
          async (tx) => {
            await lockAccessRevision(tx, scope.tenantId);
            const row = await this.store.findByZitadelId(tx, p.zitadelUserId, true);
            if (row ? p.skipWhenRowExists : p.skipWhenNoRow) return null;
            const committed = row ? await this.store.rolesOf(tx, scope.tenantId, row.id) : null;
            const next = decideRolesReconcile({
              live,
              committed,
              previous: p.previous,
              requested: p.requested,
            });
            // The row follows the closed side too: a role ZITADEL no longer holds is dropped here at once, so the
            // app does not keep granting it until the next sync.
            const rowKeeps = committed !== null && committed.every((r) => next.target.includes(r));
            if (row && committed !== null && !rowKeeps) {
              await this.store.replaceRoles(tx, scope, row.id, next.target);
              await this.store.bumpAuthzVersion(tx, scope);
            }
            note.audited = next.removed.length > 0 || (committed !== null && !rowKeeps);
            note.row = row ? row.id : null;
            note.before = { roles: committed ?? [], grants: [...live].sort() };
            return next;
          },
          AFTER_ACCESS_LOCK,
        );
      } catch {
        // The database cannot be read: fail closed on the smallest set, roles held before AND kept by the request.
        decided = decideRolesReconcile({
          live,
          committed: null,
          previous: p.previous,
          requested: p.requested,
        });
      }
      if (decided === null) return;
      if (decided.removed.length > 0) {
        await this.zitadel.setGrants(p.zitadelUserId, p.zitadelOrgId, decided.target);
      }
      if (note.audited) {
        await this.recordReconciled(
          scope,
          actor,
          note.row ? 'users' : 'idp_orgs',
          note.row ?? p.idpOrgId,
          { before: note.before, after: { roles: decided.target, grants: [...decided.target].sort() } },
        );
      }
    } catch (error) {
      this.logger.error(
        `users.reconcile: could not reconcile the roles of ${p.zitadelUserId} after a failed change (kind=${errorName(error)}); the next sync mirrors what ZITADEL holds`,
      );
    }
  }

  /**
   * Records what the reconcile found in its own transaction, so a failing audit write can never undo the closing write
   * before it. Never throws.
   */
  private async recordReconciled(
    scope: TxScope,
    actor: Actor,
    entityType: string,
    entityId: string,
    differed: Record<string, unknown>,
  ): Promise<void> {
    try {
      await withTx(
        this.db,
        scope,
        systemActor('identity-reconcile', actor.correlationId),
        (tx) =>
          this.audit.record(tx, {
            action: IDENTITY_RECONCILED,
            entityType,
            entityId,
            meta: { ...differed, requestedBy: actor.id },
          }),
      );
    } catch (error) {
      this.logger.error(
        `users.reconcile: could not audit the reconcile of ${entityId} (kind=${errorName(error)})`,
      );
    }
  }

  /**
   * Closes a person in ZITADEL. A refusal (4xx: v4.20.1 refuses lock on a locked or deactivated user and deactivate on a
   * deactivated one) tries the other close call at once; a failure that may pass (an outage) is tried again after a short
   * wait. If both are refused and ZITADEL already shows the person closed, there is nothing left to do. Never throws.
   */
  private async closeInZitadel(zitadelUserId: string, kind: 'lock' | 'deactivate'): Promise<void> {
    const order = kind === 'lock' ? (['lock', 'deactivate'] as const) : (['deactivate', 'lock'] as const);
    let last: unknown;
    for (const delay of CLOSE_DELAYS_MS) {
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      for (const call of order) {
        try {
          if (call === 'lock') await this.zitadel.lockUser(zitadelUserId);
          else await this.zitadel.deactivateUser(zitadelUserId);
          return;
        } catch (error) {
          last = error;
          if (error instanceof ZitadelNotConfiguredError) return;
          const refused = error instanceof ZitadelHttpError && error.status >= 400 && error.status < 500;
          if (!refused) break;
        }
      }
      const live = await this.zitadel.getUser(zitadelUserId).catch(() => undefined);
      if (liveStateOf(live) === 'closed') return;
    }
    this.logger.error(
      `users.reconcile: could not close ${zitadelUserId} in ZITADEL (kind=${errorName(last)}); the next sync mirrors what ZITADEL holds`,
    );
  }
}

/** Waits up to this long for another Founder-removing action of the tenant before answering 409. */
const LEASE_WAIT_MS = 3_000;
const LEASE_POLL_MS = 150;
/** A lease older than this is dead (its holder crashed) and is taken over. */
const LEASE_TTL_SECONDS = 120;

/**
 * Runs `fn` while holding the tenant's Founder-removal lease, so two actions that can take a Founder away (deactivate,
 * lock, a role set without founder) never run their guard, ZITADEL call and write interleaved: the second waits, then
 * sees the first one's result. A transaction lock cannot span the ZITADEL call, and the ZITADEL call cannot be undone
 * (an undo never opens access), so the guard has to hold before it. Never held across a database connection.
 */
export async function withFounderRemovalLease<T>(
  store: UsersStore,
  tenantId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const leaseId = randomUUID();
  const deadline = Date.now() + LEASE_WAIT_MS;
  while (!(await store.claimFounderLease(tenantId, leaseId, LEASE_TTL_SECONDS))) {
    if (Date.now() >= deadline) {
      throw new ConflictException({
        code: 'conflict',
        message: 'Another change to who can sign in is in progress. Try again in a moment.',
      });
    }
    await new Promise((resolve) => setTimeout(resolve, LEASE_POLL_MS));
  }
  try {
    return await fn();
  } finally {
    await store.releaseFounderLease(tenantId, leaseId).catch(() => undefined);
  }
}
