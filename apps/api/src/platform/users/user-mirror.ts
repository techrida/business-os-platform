// The k-users core: keeps app.users and app.user_roles equal to what ZITADEL says.
// Serves the NFR "role assignment has one source of truth" (P1-PLAN §1): ZITADEL grants are the
// truth, this file only mirrors them so approver lookups (userIdsWithRole) work without a token.
//
// Three ways in, all ending in the same apply(): the webhook (users.sync job), the 10-minute
// reconcile (the backstop for lost webhooks), and the JIT insert on a user's first request.
// It imports nothing from platform/authz at runtime (only the port's types), so the worker (which
// has no AuthzModule) can use it.
//
// ADR 0027: users are tenant-scoped. A ZITADEL org maps to app.idp_orgs; a staff user acts for the
// legal entities listed in app.user_entities, and a new staff user gets one membership in the
// tenant's default entity (the bootstrap rule). Writes run with the default entity as the withTx
// scope, because the audit fallback for tenant-scoped rows reads bos.organization_id.
import type { AdminUsersQuery, RoleKey } from '@bos/contracts';
import { InjectQueue } from '@nestjs/bullmq';
import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';

import type { EntityMembership, ResolvedUser } from '../authz/user-directory';
import { DB, type Db, type DbTransaction } from '../db/db.module';
import { type TxScope, systemActor, withTx } from '../db/tx';
import { USERS_QUEUE, USERS_SYNC_JOB, type UsersSyncData } from './users.constants';
import { type IdpOrgRow, type ListedUsers, type UserRow, UsersStore } from './users.store';
import {
  ZitadelAdminClient,
  ZitadelHttpError,
  ZitadelNotConfiguredError,
  type ZitadelUser,
} from './zitadel-admin.client';

/** The audit actor for everything that arrives from ZITADEL (hook, sync, reconcile, JIT). */
const zitadelActor = () => systemActor('zitadel');

const cursorName = (zitadelOrgId: string) => `users.reconcile:${zitadelOrgId}`;

/**
 * Hard stops for one reconcile pass. 200 pages of 100 is 20,000 users in one org, far above any real
 * org here; a walk that long means ZITADEL is not paging (offset ignored, endless list), not growth.
 * Twenty deactivations per pass is far above normal churn between two 10-minute passes; more than
 * that looks like a bug or an attack on the mirror, so it stops and waits for a human to look.
 */
const MAX_PAGES = 200;
const MAX_DEACTIVATIONS_PER_PASS = 20;

export interface ReconcileLimits {
  maxPages?: number;
  maxDeactivations?: number;
}

function sameRoles(a: readonly string[], b: readonly string[]): boolean {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return left.length === right.length && left.every((v, i) => v === right[i]);
}

export type { EntityMembership, ResolvedUser };

@Injectable()
export class UserMirror {
  private readonly logger = new Logger(UserMirror.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly store: UsersStore,
    private readonly zitadel: ZitadelAdminClient,
    @InjectQueue(USERS_QUEUE) private readonly queue: Queue<UsersSyncData>,
  ) {}

  /**
   * Re-fetches one user and their grants from ZITADEL and upserts the mirror. Returns whether
   * anything changed. A user ZITADEL reports as inactive is deactivated by apply().
   *
   * `getUser` returning nothing is NOT proof the user was deleted: the provisioner token only sees
   * the orgs it is a member of, so a customer or vendor user looks "not found" to it. Deactivating
   * on that locked every portal persona out on the real stack (2026-11-08). Only a complete
   * reconcile pass of the user's org may deactivate a user who is missing from ZITADEL.
   */
  async syncUser(zitadelUserId: string): Promise<boolean> {
    const user = await this.zitadel.getUser(zitadelUserId);
    if (!user) {
      this.logger.warn(`users.sync: ZITADEL did not return ${zitadelUserId}; left unchanged`);
      return false;
    }

    const org = await this.store.idpOrgByZitadelId(user.orgId);
    if (!org) {
      // P2 adds org sync; until then a user of an unknown org has nowhere to live.
      this.logger.warn(`users.sync skipped ${zitadelUserId}: its org has no app.idp_orgs row`);
      return false;
    }
    const roles = await this.zitadel.listGrants(zitadelUserId, org.zitadelOrgId);
    return this.apply(org, user, roles);
  }

  /**
   * Walks every staff IdP org page by page and upserts each user. A user missing from a COMPLETE and
   * TRUSTWORTHY pass of its org is a deactivation candidate (see deactivateMissing). A partial pass
   * (a page failed, or the run resumed from a saved cursor) is not proof of absence, so it
   * deactivates nobody; the next full pass will.
   *
   * The listing is only trusted when it shows signs of paging correctly. ZITADEL's offset and page
   * size are unverified, so a pass aborts (no deactivations, error logged, cursor reset) when it
   * hits the page cap, when a page repeats the previous page, or when ZITADEL's own totalResult
   * disagrees with the number of distinct users collected. Without that, a server that ignored the
   * offset would make every user beyond the first page look "missing".
   */
  async reconcile(limits: ReconcileLimits = {}): Promise<{ scanned: number; changed: number }> {
    const maxPages = limits.maxPages ?? MAX_PAGES;
    const maxDeactivations = limits.maxDeactivations ?? MAX_DEACTIVATIONS_PER_PASS;
    let scanned = 0;
    let changed = 0;
    for (const org of await this.store.listStaffIdpOrgs()) {
      const name = cursorName(org.zitadelOrgId);
      const start = await this.store.getCursor(name);
      const fullPass = start === null || start === '0';
      // Taken before the first page: anyone created in ZITADEL after this is not "missing", just new.
      const passStart = new Date();
      const seen = new Set<string>();
      let cursor: string | null = fullPass ? null : start;
      let pages = 0;
      let previousIds = new Set<string>();
      let total: number | null = null;
      let abort: string | null = null;
      try {
        for (;;) {
          if (pages >= maxPages) {
            abort = `hit the page cap of ${maxPages} pages`;
            break;
          }
          pages += 1;
          const page = await this.zitadel.listUsers(org.zitadelOrgId, cursor);
          if (page.users.length > 0 && page.users.every((u) => previousIds.has(u.id))) {
            abort = 'a page repeated the previous page (ZITADEL may be ignoring the offset)';
            break;
          }
          previousIds = new Set(page.users.map((u) => u.id));
          total = page.totalResult ?? null;
          for (const user of page.users) {
            scanned += 1;
            seen.add(user.id);
            const roles = await this.zitadel.listGrants(user.id, org.zitadelOrgId);
            if (await this.apply(org, user, roles)) changed += 1;
          }
          if (page.nextCursor === null) break;
          cursor = page.nextCursor;
          // Saved after each page, so a crash resumes here instead of starting the org over.
          await this.store.setCursor(name, cursor);
        }
      } catch (error) {
        if (error instanceof ZitadelNotConfiguredError) {
          this.logger.warn(`users.reconcile skipped: ${error.message}`);
          return { scanned, changed };
        }
        this.logger.error(
          `users.reconcile failed for org ${org.zitadelOrgId}: ${(error as Error).message}`,
        );
        continue;
      }
      // Reset in every non-error outcome, so an aborted pass restarts the org instead of resuming
      // from a cursor a misbehaving ZITADEL handed out.
      await this.store.setCursor(name, '0');
      if (abort === null && fullPass && total !== null && seen.size !== total) {
        abort = `collected ${seen.size} users but ZITADEL reports ${total}`;
      }
      if (abort !== null) {
        this.logger.error(
          `users.reconcile aborted for org ${org.zitadelOrgId}: ${abort}; no users deactivated`,
        );
        continue;
      }
      if (fullPass) changed += await this.deactivateMissing(org, seen, passStart, maxDeactivations);
    }
    return { scanned, changed };
  }

  /**
   * UserDirectory.resolve: the app user behind a verified token. The first request of a user the
   * webhook has not delivered yet inserts a minimal active row (JIT) and asks for a full sync.
   *
   * An `invited` row behind a valid token is an accepted invite: ZITADEL only issues tokens to
   * users that finished it, and can() denies `invited`. So the row turns active here instead of
   * waiting up to 10 minutes for the webhook or the reconcile.
   */
  async resolve(i: {
    zitadelUserId: string;
    tenantId: string;
    idpOrgId: string;
  }): Promise<ResolvedUser> {
    let row = await this.store.findByZitadelId(this.db, i.zitadelUserId);
    if (!row) {
      const org = await this.store.idpOrgById(i.idpOrgId);
      if (!org || org.tenantId !== i.tenantId) throw new Error('JIT user insert: unknown IdP org');
      const scope = await this.entityScope(org.tenantId);
      await withTx(this.db, scope, zitadelActor(), async (tx) => {
        const userId = await this.store.insertUser(tx, scope, {
          zitadelUserId: i.zitadelUserId,
          idpOrgId: org.idpOrgId,
          email: null,
          displayName: null,
          status: 'active',
        });
        await this.bootstrap(tx, org, scope, userId);
      });
      await this.enqueueSync(i.zitadelUserId);
      row = await this.store.findByZitadelId(this.db, i.zitadelUserId);
      if (!row) throw new Error('JIT user insert left no row');
    } else if (row.status === 'invited') {
      const invited = row;
      await withTx(this.db, await this.entityScope(invited.tenantId), zitadelActor(), (tx) =>
        this.store.updateUser(tx, invited.id, {
          email: invited.email,
          displayName: invited.displayName,
          status: 'active',
        }),
      );
      await this.enqueueSync(i.zitadelUserId);
      row = { ...invited, status: 'active' };
    }
    return {
      userId: row.id,
      tenantId: row.tenantId,
      idpOrgId: row.idpOrgId,
      status: row.status,
      memberships: await this.store.membershipsOf(this.db, row.tenantId, row.id),
    };
  }

  /** A Valkey hiccup must not fail the user's request: the reconcile fills the row in anyway. */
  private async enqueueSync(zitadelUserId: string): Promise<void> {
    await this.queue
      .add(USERS_SYNC_JOB, { zitadelUserId }, { removeOnComplete: 100, removeOnFail: 500 })
      .catch((error: Error) => this.logger.warn(`users.sync enqueue failed: ${error.message}`));
  }

  userIdsWithRole(scope: TxScope, role: RoleKey): Promise<string[]> {
    return this.store.userIdsWithRole(scope, role);
  }

  emailOf(userId: string): Promise<string | null> {
    return this.store.emailOf(userId);
  }

  list(scope: TxScope, q: AdminUsersQuery): Promise<ListedUsers> {
    return this.store.list(scope, q);
  }

  /**
   * Creates the human in ZITADEL, grants the roles there, sends the invite mail, then writes the
   * mirror in `tx` (the admin's transaction, so the audit row names the admin). If the DB part
   * fails after ZITADEL succeeded, the webhook or reconcile creates the row later.
   */
  async invite(
    tx: DbTransaction,
    b: { email: string; givenName: string; familyName: string; roles: RoleKey[] },
  ): Promise<{ userId: string }> {
    const scope = await this.store.txScope(tx);
    const org = await this.staffOrgOf(scope);
    let zitadelUserId: string;
    try {
      zitadelUserId = await this.zitadel.createHuman(org.zitadelOrgId, b);
    } catch (error) {
      if (error instanceof ZitadelHttpError && error.status === 409) {
        throw new ConflictException('A user with this email already exists');
      }
      throw error;
    }
    await this.zitadel.setGrants(zitadelUserId, org.zitadelOrgId, b.roles);
    await this.zitadel.sendInviteCode(zitadelUserId);

    const userId = await this.store.insertUser(tx, scope, {
      zitadelUserId,
      idpOrgId: org.idpOrgId,
      email: b.email,
      displayName: `${b.givenName} ${b.familyName}`,
      status: 'invited',
    });
    await this.bootstrap(tx, org, scope, userId);
    if (b.roles.length > 0) {
      await this.store.replaceRoles(tx, scope, userId, b.roles);
      await this.store.bumpAuthzVersion(tx, scope);
    }
    return { userId };
  }

  /** ZITADEL first (it is the truth), then the mirror. The caller invalidates authz after commit. */
  async setRoles(tx: DbTransaction, userId: string, roles: RoleKey[]): Promise<void> {
    const scope = await this.store.txScope(tx);
    const user = await this.store.findById(tx, scope, userId);
    if (!user) throw new NotFoundException('User not found');
    const org = await this.staffOrgOf(scope);
    // Staff roles are granted in the staff org: a portal user is not an admin target (as before 0027).
    if (user.idpOrgId !== org.idpOrgId) throw new NotFoundException('User not found');
    const currentRoles = await this.store.rolesOf(tx, scope.tenantId, userId);
    if (
      user.status === 'active' &&
      currentRoles.includes('founder') &&
      !roles.includes('founder')
    ) {
      // Same lock key as the access settings saves: two removals cannot both see the other Founder.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('access_revisions:' || ${scope.tenantId}))`,
      );
      // Per legal entity, not company-wide: an entity whose only effective Founder is this user would
      // be left with none, even when other entities still have Founders.
      const founders = await this.store.effectiveRoleHolders(tx, scope.tenantId, 'founder');
      const orphaned = founders.filter(
        (f) =>
          f.userId === userId &&
          !founders.some((o) => o.organizationId === f.organizationId && o.userId !== userId),
      );
      if (orphaned.length > 0) {
        // Never the email: the address is not a name (U20a2-Q10).
        const name = user.displayName?.trim() || 'This person';
        const entities = orphaned.map((f) => f.entityName).join(', ');
        throw new ConflictException({
          code: 'last_founder',
          message: `${name} is the only Founder of ${entities}. Make someone else a Founder there first.`,
        });
      }
    }
    await this.zitadel.setGrants(user.zitadelUserId, org.zitadelOrgId, roles);
    if (!sameRoles(currentRoles, roles)) {
      await this.store.replaceRoles(tx, scope, userId, roles);
      await this.store.bumpAuthzVersion(tx, scope);
    }
  }

  /** The one write path for ZITADEL data: upsert the user, mirror the roles, bump authz on change. */
  private async apply(
    org: IdpOrgRow,
    user: ZitadelUser,
    roles: readonly RoleKey[],
  ): Promise<boolean> {
    const status = user.status;
    if (status === null) {
      // A state we cannot read must never lock anyone out or let anyone in: write nothing at all.
      this.logger.warn(
        `users.apply skipped ${user.id}: unknown state from ZITADEL; left unchanged`,
      );
      return false;
    }
    const scope = await this.entityScope(org.tenantId);
    return withTx(this.db, scope, zitadelActor(), async (tx) => {
      let changed = false;
      const existing = await this.store.findByZitadelId(tx, user.id, true);
      let userId: string;
      if (!existing) {
        userId = await this.store.insertUser(tx, scope, {
          zitadelUserId: user.id,
          idpOrgId: org.idpOrgId,
          email: user.email,
          displayName: user.displayName,
          status,
        });
        await this.bootstrap(tx, org, scope, userId);
        changed = true;
      } else {
        userId = existing.id;
        const statusChanged = existing.status !== status;
        if (
          existing.email !== user.email ||
          existing.displayName !== user.displayName ||
          existing.status !== status
        ) {
          await this.store.updateUser(tx, userId, {
            email: user.email,
            displayName: user.displayName,
            status,
          });
          // A status change (disabled, re-enabled) reaches every request at once: the per-request user cache
          // is keyed on the authz version, so without a bump a disabled user stays active for up to 60 s.
          if (statusChanged) await this.store.bumpAuthzVersion(tx, scope);
          changed = true;
        }
      }
      if (!sameRoles(await this.store.rolesOf(tx, scope.tenantId, userId), roles)) {
        await this.store.replaceRoles(tx, scope, userId, roles);
        await this.store.bumpAuthzVersion(tx, scope);
        changed = true;
      }
      return changed;
    });
  }

  /**
   * The org's local users the pass did not see are only CANDIDATES. Each is asked about directly,
   * and only a definite "inactive" answer deactivates it: not found (maybe just invisible to the
   * provisioner token), an unknown state, an active user the listing missed, and a user created
   * after the pass started all stay as they are. At most `max` are deactivated per pass.
   *
   * Known gap: a user deleted in ZITADEL answers "not found", so reconcile never deactivates it
   * any more; an admin must deactivate it by hand until deletion events are mirrored.
   */
  private async deactivateMissing(
    org: IdpOrgRow,
    seen: ReadonlySet<string>,
    passStart: Date,
    max: number,
  ): Promise<number> {
    const locals = await this.store.notInactiveInIdpOrg(this.db, org);
    const missing = locals.filter((u) => !seen.has(u.zitadelUserId));
    if (seen.size === 0 && missing.length > 0) {
      // Safeguard: an empty list for an org that has users is far more likely a token that cannot
      // see the org than a real mass deletion. Refuse to lock everyone out on that evidence.
      this.logger.warn(
        `users.reconcile: ZITADEL listed no users for org ${org.zitadelOrgId}; not deactivating ${missing.length}`,
      );
      return 0;
    }
    let deactivated = 0;
    for (const [index, local] of missing.entries()) {
      if (deactivated >= max) {
        this.logger.warn(
          `users.reconcile: deactivation cap of ${max} reached for org ${org.zitadelOrgId}; ${missing.length - index} candidates left for a later pass`,
        );
        break;
      }
      const remote = await this.confirm(local.zitadelUserId);
      if (!remote) continue;
      if (remote.createdAt && remote.createdAt >= passStart) continue; // newer than the pass
      if (remote.status === null) {
        this.logger.warn(
          `users.reconcile: ${local.zitadelUserId} has an unknown state in ZITADEL; left unchanged`,
        );
        continue;
      }
      if (remote.status !== 'inactive') continue;
      await this.deactivate(local);
      deactivated += 1;
    }
    return deactivated;
  }

  /** One candidate's own record, or null when it cannot be confirmed (not found or the call failed). */
  private async confirm(zitadelUserId: string): Promise<ZitadelUser | null> {
    try {
      const user = await this.zitadel.getUser(zitadelUserId);
      if (!user) {
        this.logger.warn(
          `users.reconcile: ZITADEL does not return ${zitadelUserId}; left unchanged`,
        );
      }
      return user;
    } catch (error) {
      this.logger.warn(
        `users.reconcile: could not confirm ${zitadelUserId}: ${(error as Error).message}; left unchanged`,
      );
      return null;
    }
  }

  private async deactivate(user: UserRow): Promise<void> {
    const scope = await this.entityScope(user.tenantId);
    await withTx(this.db, scope, zitadelActor(), async (tx) => {
      await this.store.updateUser(tx, user.id, {
        email: user.email,
        displayName: user.displayName,
        status: 'inactive',
      });
      // Bump the authz version so the per-request user cache drops the user at once (see apply).
      await this.store.bumpAuthzVersion(tx, scope);
    });
  }

  /** The tenant's staff IdP org: invites are created and grants are set there. */
  private async staffOrgOf(scope: TxScope): Promise<IdpOrgRow> {
    const org = await this.store.staffIdpOrgOf(scope.tenantId);
    if (!org) throw new NotFoundException('Organization not found');
    return org;
  }

  /**
   * The withTx scope for a user write: the tenant and its default entity. users and user_roles have
   * no organization_id, so their audit rows take bos.organization_id from this scope.
   */
  private async entityScope(tenantId: string): Promise<TxScope> {
    const organizationId = await this.store.defaultEntityOf(tenantId);
    if (!organizationId) throw new Error(`tenant ${tenantId} has no default entity`);
    return { tenantId, organizationId };
  }

  /**
   * The bootstrap rule (ADR 0027 section 3): a staff user just created with no membership gets one
   * in the tenant's default entity (role_keys NULL). Portal users get none. Runs in the caller's tx.
   * Public for UsersService.finishInvite, which repeats the invite's steps.
   */
  async bootstrap(
    tx: DbTransaction,
    org: IdpOrgRow,
    scope: TxScope,
    userId: string,
  ): Promise<void> {
    if (org.kind !== 'staff') return;
    const entityId = await this.store.defaultEntityOf(scope.tenantId);
    if (!entityId) throw new Error(`tenant ${scope.tenantId} has no default entity`);
    await this.store.ensureDefaultMembership(tx, scope.tenantId, entityId, userId);
  }
}
