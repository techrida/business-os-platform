// Admin side of approvals: workflow definitions with draft and published versions, approval groups
// and their members, and delegations. Serves the NFR "approvals are auditable": a spec is edited only
// as a draft, publishing freezes it (the DB trigger refuses later edits), and a new version affects
// only requests submitted after it is published, because each request keeps its own version id.
import {
  MEMO_APPROVER_DOCUMENT_TYPE,
  WorkflowWriteSpecSchema,
  type WorkflowSpec,
} from '@bos/contracts';
import {
  approvalGroupMembers,
  approvalGroups,
  delegations,
  idpOrgs,
  userEntities,
  users,
  workflowDefinitions,
  workflowVersions,
} from '@bos/db';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, isNull } from 'drizzle-orm';

import { RoleCache } from '../../platform/authz/role-cache';
import {
  isSoleEligible,
  otherEligibleUsers,
  type SoleEligibleDeps,
} from '../../platform/authz/sole-eligible';
import { DB, type Db, type DbTransaction } from '../../platform/db/db.module';
import { withTx, type Actor, type TxOptions, type TxScope } from '../../platform/db/tx';
import { departmentNames, roleLine } from '../../platform/users/person-role';
import { SettingsService } from '../../platform/settings/settings.service';
import { APPROVALS_CLOCK, ApprovalsAudit, ApprovalsCaller, type Clock } from './ports';
import { activeEntityStaff, pgCode } from './requests.service';

export interface WorkflowVersionDto {
  id: string;
  version: number;
  status: 'draft' | 'published' | 'retired';
  spec: unknown;
  publishedAt: string | null;
  /** Who saved this version; null for a version saved before the editor was recorded (0127). */
  createdBy: string | null;
  /**
   * The editor's display name, so a Management member who cannot read the user directory still sees who saved a
   * draft. 'Unnamed user' for a user without a display name (D54-2); null when the editor is unknown. List only.
   */
  createdByName?: string | null;
  /** Who published it; null while it is a draft. */
  publishedBy: string | null;
  /** True when the caller saved it, so the caller cannot be the second person who publishes it (F1-Q11). */
  savedByCaller: boolean;
  /**
   * True when the caller may still publish this draft they saved, under the small-team rule (F1-Q11 a): they are a
   * Founder and nobody else may publish (active, or only temporarily locked after failed sign-ins, holding approvals.definitions.publish in this entity).
   * The publish then needs a reason. Computed in the list read only; false elsewhere.
   */
  publishSoleEligible: boolean;
}

/** Why a publish was refused to its caller (F1-Q11); recorded in the audit trail as well. */
/**
 * Re-checks, inside the publish transaction, that the person publishing may still publish. The route's guard reads
 * the sign-in token, so someone demoted from Management would otherwise keep publishing until it expires. The HTTP
 * route passes the live-grant check (access-revision lock, then the mirror's current roles); every caller must name
 * one, so none skips it by accident.
 */
export type PublisherCheck = (
  tx: DbTransaction,
  scope: TxScope,
  actor: Actor,
) => Promise<{ roles: readonly string[] } | void>;

type PublishRefusal = 'own_draft' | 'editor_unknown';

/** Thrown inside the publish transaction, so the refusal can be audited after that transaction rolls back. */
class PublishRefused extends Error {
  constructor(
    readonly reason: PublishRefusal,
    readonly versionId: string,
    readonly createdBy: string | null,
  ) {
    super(reason);
  }
}

const PUBLISH_REFUSAL_MESSAGE: Record<PublishRefusal, string> = {
  own_draft:
    'You saved this version, so another Management member must publish it. A workflow decides who approves money, so it needs a second person.',
  editor_unknown:
    'This draft was saved before the editor was recorded. Save it again as a new draft, then ask another Management member to publish it.',
};
export interface WorkflowDto {
  id: string;
  key: string;
  name: string;
  documentType: string;
  currentVersionId: string | null;
  versions: WorkflowVersionDto[];
}

@Injectable()
export class ApprovalsAdminService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: ApprovalsAudit,
    private readonly caller: ApprovalsCaller,
    @Inject(APPROVALS_CLOCK) private readonly clock: Clock,
    // Optional so unit tests that build the service by hand keep the schema's own SLA defaults (24h/72h/founder),
    // which equal the setting's default. ApprovalsModule imports SettingsModule, so the app always has it.
    @Optional() private readonly settings?: SettingsService,
    // The role -> permission table for the small-team rule (F1-Q11 a). Optional so hand-built services in tests keep
    // compiling; without it the rule never applies and the second-person refusal stands (fails closed).
    @Optional() private readonly roleCache?: RoleCache,
  ) {}

  /** `cached`: a plain read uses the role cache's cached table; a write reads it fresh on its own transaction. */
  private soleEligibleDeps(cached: boolean): SoleEligibleDeps | null {
    const cache = this.roleCache;
    if (cache === undefined) return null;
    return {
      grants: {
        grantsFor: (tenantId, organizationId, roles, level, on) =>
          cache.grantsFor(tenantId, organizationId, roles, level, cached ? undefined : on),
      },
    };
  }

  /**
   * Who else could publish a workflow version in `scope` right now, leaving out `excludeUserIds`; null when the role
   * table is not wired. Workflow definitions belong to one entity (tenant + organization), and the publish route's
   * live check narrows roles by the membership in that entity, so this is entity-scoped too.
   */
  private async otherPublishers(
    q: DbTransaction,
    scope: TxScope,
    excludeUserIds: readonly string[],
    cached = false,
  ): Promise<string[] | null> {
    const deps = this.soleEligibleDeps(cached);
    if (deps === null) return null;
    return otherEligibleUsers(q, deps, scope, 'approvals.definitions.publish', {
      excludeUserIds,
      entityScoped: true,
    });
  }

  /**
   * A spec that leaves `sla` out gets the entity's `approvals.sla_defaults` written into it, so the version stores
   * (and later freezes into each request) the SLA in force when it was drafted. A spec that names `sla`, even
   * partly, is left as it is: the schema fills its missing fields exactly as before.
   */
  private async withSlaDefaults(input: unknown): Promise<unknown> {
    if (
      this.settings === undefined ||
      input === null ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      'sla' in input
    ) {
      return input;
    }
    const { scope } = this.caller.current();
    return { ...input, sla: await this.settings.get(scope, 'approvals.sla_defaults') };
  }

  /** Runs `fn` in a transaction as the calling user, and turns constraint errors into 409. */
  private async write<T>(
    fn: (tx: DbTransaction, scope: TxScope, userId: string, actor: Actor) => Promise<T>,
    options?: TxOptions,
  ): Promise<T> {
    const { scope, actor, principal } = this.caller.current();
    try {
      return await withTx(
        this.db,
        scope,
        actor,
        (tx) => fn(tx, scope, principal.userId, actor),
        options,
      );
    } catch (error) {
      const code = pgCode(error);
      if (code === '23505') throw new ConflictException('That key already exists');
      if (code === '23503') throw new ConflictException('It is still in use');
      if (code === '23514')
        throw new ConflictException('A published workflow version cannot change');
      throw error;
    }
  }

  /** Minimal picker data, restricted to the same active entity staff accepted by assignment writes.
   * HTTP callers need the corresponding approval-management permission, never directory access.
   */
  async listAssignmentPeople(q: { limit: number; after?: string | undefined }) {
    const { scope } = this.caller.current();
    const items = await this.db
      .select({
        id: users.id,
        displayName: users.displayName,
        email: users.email,
        jobTitle: userEntities.jobTitle,
        departmentId: userEntities.departmentId,
      })
      .from(users)
      .innerJoin(
        userEntities,
        and(
          eq(userEntities.tenantId, users.tenantId),
          eq(userEntities.userId, users.id),
          eq(userEntities.organizationId, scope.organizationId),
        ),
      )
      .innerJoin(idpOrgs, and(eq(idpOrgs.tenantId, users.tenantId), eq(idpOrgs.id, users.idpOrgId)))
      .where(
        and(
          eq(users.tenantId, scope.tenantId),
          eq(users.status, 'active'),
          eq(idpOrgs.kind, 'staff'),
          q.after ? gt(users.id, q.after) : undefined,
        ),
      )
      .orderBy(asc(users.id))
      .limit(q.limit);
    const deptNames = await departmentNames(
      this.db,
      scope,
      items.map((i) => i.departmentId),
    );
    return {
      // The role line is what a member picker shows after the name (BOS-UI-001).
      items: items.map(({ jobTitle, departmentId, ...person }) => ({
        ...person,
        role: roleLine(jobTitle, departmentId === null ? null : (deptNames.get(departmentId) ?? null)),
      })),
      nextAfter: items.length === q.limit ? (items.at(-1)?.id ?? null) : null,
    };
  }

  // ---- workflows -----------------------------------------------------------------------------------

  async listWorkflows(): Promise<WorkflowDto[]> {
    const { scope, principal } = this.caller.current();
    const defs = await this.db
      .select()
      .from(workflowDefinitions)
      .where(
        and(
          eq(workflowDefinitions.tenantId, scope.tenantId),
          eq(workflowDefinitions.organizationId, scope.organizationId),
        ),
      )
      .orderBy(asc(workflowDefinitions.key));
    if (defs.length === 0) return [];
    const versions = await this.db
      .select()
      .from(workflowVersions)
      .where(
        inArray(
          workflowVersions.definitionId,
          defs.map((d) => d.id),
        ),
      )
      .orderBy(asc(workflowVersions.version));
    const editorIds = [
      ...new Set(versions.flatMap((v) => (v.createdBy === null ? [] : [v.createdBy]))),
    ];
    const editors =
      editorIds.length === 0
        ? []
        : await this.db
            .select({ id: users.id, displayName: users.displayName })
            .from(users)
            .where(and(eq(users.tenantId, scope.tenantId), inArray(users.id, editorIds)));
    // Once per read, not per version: only the caller's own drafts can carry the flag, so one exclusion set serves.
    const ownDraft = versions.some(
      (v) => v.status === 'draft' && v.createdBy !== null && v.createdBy === principal.userId,
    );
    let soleEligible = false;
    if (ownDraft && principal.roles.includes('founder')) {
      const others = await this.otherPublishers(
        this.db as unknown as DbTransaction,
        scope,
        [principal.userId],
        true,
      );
      soleEligible = others !== null && isSoleEligible(principal.roles, others);
    }
    const nameOf = (id: string | null): string | null => {
      if (id === null) return null;
      const editor = editors.find((u) => u.id === id);
      return editor === undefined ? null : editor.displayName?.trim() || 'Unnamed user';
    };
    return defs.map((d) => ({
      id: d.id,
      key: d.key,
      name: d.name,
      documentType: d.documentType,
      currentVersionId: d.currentVersionId,
      versions: versions
        .filter((v) => v.definitionId === d.id)
        .map((v) => ({
          ...versionDto(v, principal.userId, soleEligible),
          createdByName: nameOf(v.createdBy),
        })),
    }));
  }

  /** A new definition with version 1 as a draft. */
  async createWorkflow(b: {
    key: string;
    name: string;
    spec: unknown;
  }): Promise<WorkflowVersionDto> {
    const spec = parseSpec(await this.withSlaDefaults(b.spec));
    return this.write(async (tx, scope, userId) => {
      const [def] = await tx
        .insert(workflowDefinitions)
        .values({ ...scope, key: b.key, name: b.name, documentType: spec.documentType })
        .returning();
      const [v] = await tx
        .insert(workflowVersions)
        .values({
          ...scope,
          definitionId: def!.id,
          version: 1,
          status: 'draft',
          spec,
          createdBy: userId,
        })
        .returning();
      await this.audit.record(tx, {
        action: 'approvals.workflow.create',
        entityType: 'workflow_definition',
        entityId: def!.id,
        after: { key: b.key, documentType: spec.documentType },
      });
      return versionDto(v!, userId);
    });
  }

  /** The next version number as a draft. Requests already submitted keep the version they had. */
  async addVersion(key: string, specInput: unknown): Promise<WorkflowVersionDto> {
    const spec = parseSpec(await this.withSlaDefaults(specInput));
    return this.write(async (tx, scope, userId) => {
      const def = await this.definition(tx, scope, key);
      if (spec.documentType !== def.documentType) {
        throw new BadRequestException(`spec.documentType must stay "${def.documentType}"`);
      }
      const [last] = await tx
        .select({ version: workflowVersions.version })
        .from(workflowVersions)
        .where(eq(workflowVersions.definitionId, def.id))
        .orderBy(desc(workflowVersions.version))
        .limit(1);
      const [v] = await tx
        .insert(workflowVersions)
        .values({
          ...scope,
          definitionId: def.id,
          version: (last?.version ?? 0) + 1,
          status: 'draft',
          spec,
          createdBy: userId,
        })
        .returning();
      await this.audit.record(tx, {
        action: 'approvals.workflow.version',
        entityType: 'workflow_version',
        entityId: v!.id,
        after: { key, version: v!.version },
      });
      return versionDto(v!, userId);
    });
  }

  /**
   * Publishes a draft: it becomes the current version, and the previous published one is retired. A second person
   * publishes (F1-Q11, D7): the route needs approvals.definitions.publish (Management and the Founder by default),
   * and whoever saved the draft is refused here, as is a draft whose editor was never recorded. A refusal is
   * audited on its own transaction, because the publish transaction rolls back with it. The one exception is the
   * small-team rule (F1-Q11 a): a Founder (by the sign-in roles; the publish grant itself is re-read live) may publish
   * their own draft when nobody else may publish it, with a reason, audited as `publish_sole_eligible`.
   */
  async publish(
    key: string,
    version: number,
    assertPublisher: PublisherCheck,
    body: { reason?: string | undefined } = {},
  ): Promise<WorkflowVersionDto> {
    const { principal } = this.caller.current();
    const reason = body.reason?.trim() ?? '';
    try {
      return await this.write(
        async (tx, scope, userId, actor) => {
          // First, before any row lock: the grant answer then holds for the rest of the transaction.
          const live = await assertPublisher(tx, scope, actor);
          // The Founder test for the small-team rule uses the roles the check just read live. A check that returns
          // none (the test seam) leaves the sign-in roles.
          const publisherRoles: readonly string[] = live ? live.roles : principal.roles;
          const def = await this.definition(tx, scope, key);
          const [v] = await tx
            .select()
            .from(workflowVersions)
            .where(
              and(eq(workflowVersions.definitionId, def.id), eq(workflowVersions.version, version)),
            )
            .for('update');
          if (v === undefined)
            throw new NotFoundException(`Workflow "${key}" has no version ${version}`);
          if (v.status !== 'draft')
            throw new ConflictException(`Version ${version} is already ${v.status}`);
          if (v.createdBy === null) throw new PublishRefused('editor_unknown', v.id, null);
          // The small-team rule (F1-Q11 a): a Founder may publish their own draft when nobody else may publish it,
          // with a reason. A second eligible person, even one who is away, keeps the refusal.
          let soleEligible = false;
          if (v.createdBy === userId) {
            const others = publisherRoles.includes('founder')
              ? await this.otherPublishers(tx, scope, [userId, v.createdBy])
              : null;
            if (others === null || !isSoleEligible(publisherRoles, others)) {
              throw new PublishRefused('own_draft', v.id, v.createdBy);
            }
            if (reason === '') {
              throw new BadRequestException({
                code: 'bad_request',
                reason: 'sole_eligible_reason_required',
                message:
                  'Nobody else may publish this workflow, so you may publish your own draft; give a reason.',
              });
            }
            soleEligible = true;
          }
          const spec = parseSpec(v.spec);
          await this.assertGroupsExist(tx, scope, spec);
          const now = this.clock();
          await tx
            .update(workflowVersions)
            .set({ status: 'retired' })
            .where(
              and(
                eq(workflowVersions.definitionId, def.id),
                eq(workflowVersions.status, 'published'),
              ),
            );
          const [published] = await tx
            .update(workflowVersions)
            .set({ status: 'published', publishedAt: now, publishedBy: userId })
            .where(eq(workflowVersions.id, v.id))
            .returning();
          await tx
            .update(workflowDefinitions)
            .set({ currentVersionId: v.id })
            .where(eq(workflowDefinitions.id, def.id));
          await this.audit.record(tx, {
            action: soleEligible
              ? 'approvals.workflow.publish_sole_eligible'
              : 'approvals.workflow.publish',
            entityType: 'workflow_version',
            entityId: v.id,
            before: { currentVersionId: def.currentVersionId },
            // The editor and the second person both stand in the trail (D7); a sole-eligible publish says why.
            after: soleEligible
              ? { key, version, editedBy: v.createdBy, publishedBy: userId, soleEligible, reason }
              : { key, version, editedBy: v.createdBy, publishedBy: userId },
          });
          return versionDto(published!, userId);
          // 'lazy': the access-revision lock comes first here, as on the ZITADEL admin paths that cannot take the
          // tenant audit lock first; taking that lock before it would invert the order against them.
        },
        { audit: 'lazy' },
      );
    } catch (error) {
      if (!(error instanceof PublishRefused)) throw error;
      await this.write(async (tx) => {
        await this.audit.record(tx, {
          action: 'approvals.workflow.publish_refused',
          entityType: 'workflow_version',
          entityId: error.versionId,
          after: { key, version, reason: error.reason, editedBy: error.createdBy },
        });
      });
      throw new ForbiddenException({
        code: 'forbidden',
        reason: 'separation_of_duties',
        message: PUBLISH_REFUSAL_MESSAGE[error.reason],
      });
    }
  }

  private async definition(tx: DbTransaction, scope: TxScope, key: string) {
    const [def] = await tx
      .select()
      .from(workflowDefinitions)
      .where(
        and(
          eq(workflowDefinitions.tenantId, scope.tenantId),
          eq(workflowDefinitions.organizationId, scope.organizationId),
          eq(workflowDefinitions.key, key),
        ),
      )
      .for('update');
    if (def === undefined) throw new NotFoundException(`Workflow "${key}" not found`);
    return def;
  }

  /** A published spec may only name groups that exist, so a submit never routes to nothing. */
  private async assertGroupsExist(
    tx: DbTransaction,
    scope: TxScope,
    spec: WorkflowSpec,
  ): Promise<void> {
    const keys = [
      ...new Set(
        [...spec.steps, ...spec.rules.map((r) => r.add)].flatMap((s) =>
          s.kind === 'group' && s.group ? [s.group] : [],
        ),
      ),
    ];
    if (keys.length === 0) return;
    const rows = await tx
      .select({ key: approvalGroups.key })
      .from(approvalGroups)
      .where(
        and(
          eq(approvalGroups.tenantId, scope.tenantId),
          eq(approvalGroups.organizationId, scope.organizationId),
          inArray(approvalGroups.key, keys),
        ),
      );
    const missing = keys.filter((k) => !rows.some((r) => r.key === k));
    if (missing.length > 0)
      throw new BadRequestException(`Unknown approval group(s): ${missing.join(', ')}`);
  }

  /**
   * Every id must be an active staff user of this tenant with a membership in the acting entity
   * (ADR 0027 §3). Group members and delegations hold bare uuids (no FK to app.users), so without this
   * a typo or the id of a user who may not act for this entity is stored silently.
   */
  private async assertActiveUsers(
    tx: DbTransaction,
    scope: TxScope,
    ids: readonly string[],
  ): Promise<void> {
    const wanted = [...new Set(ids)];
    const found = new Set(await activeEntityStaff(tx, scope, wanted));
    const missing = wanted.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new BadRequestException(
        `Not an active user of this organization: ${missing.join(', ')}`,
      );
    }
  }

  // ---- groups --------------------------------------------------------------------------------------

  async listGroups() {
    const { scope } = this.caller.current();
    const groups = await this.db
      .select()
      .from(approvalGroups)
      .where(
        and(
          eq(approvalGroups.tenantId, scope.tenantId),
          eq(approvalGroups.organizationId, scope.organizationId),
        ),
      )
      .orderBy(asc(approvalGroups.key));
    const members = await this.db
      .select({ groupId: approvalGroupMembers.groupId, userId: approvalGroupMembers.userId })
      .from(approvalGroupMembers)
      .where(
        and(
          eq(approvalGroupMembers.tenantId, scope.tenantId),
          eq(approvalGroupMembers.organizationId, scope.organizationId),
        ),
      );
    return groups.map((g) => ({
      id: g.id,
      key: g.key,
      name: g.name,
      memberUserIds: members.filter((m) => m.groupId === g.id).map((m) => m.userId),
    }));
  }

  createGroup(b: { key: string; name: string }): Promise<{ id: string }> {
    return this.write(async (tx, scope) => {
      const [g] = await tx
        .insert(approvalGroups)
        .values({ ...scope, key: b.key, name: b.name })
        .returning({ id: approvalGroups.id });
      await this.audit.record(tx, {
        action: 'approvals.group.create',
        entityType: 'approval_group',
        entityId: g!.id,
        after: b,
      });
      return { id: g!.id };
    });
  }

  deleteGroup(groupId: string): Promise<void> {
    return this.write(async (tx, scope) => {
      const deleted = await tx
        .delete(approvalGroups)
        .where(
          and(
            eq(approvalGroups.id, groupId),
            eq(approvalGroups.tenantId, scope.tenantId),
            eq(approvalGroups.organizationId, scope.organizationId),
          ),
        )
        .returning({ id: approvalGroups.id });
      if (deleted.length === 0) throw new NotFoundException('Approval group not found');
      await this.audit.record(tx, {
        action: 'approvals.group.delete',
        entityType: 'approval_group',
        entityId: groupId,
      });
    });
  }

  addMember(groupId: string, userId: string): Promise<void> {
    return this.write(async (tx, scope) => {
      const [g] = await tx
        .select({ id: approvalGroups.id })
        .from(approvalGroups)
        .where(
          and(
            eq(approvalGroups.id, groupId),
            eq(approvalGroups.tenantId, scope.tenantId),
            eq(approvalGroups.organizationId, scope.organizationId),
          ),
        );
      if (g === undefined) throw new NotFoundException('Approval group not found');
      await this.assertActiveUsers(tx, scope, [userId]);
      await tx
        .insert(approvalGroupMembers)
        .values({ ...scope, groupId, userId })
        .onConflictDoNothing();
      await this.audit.record(tx, {
        action: 'approvals.group.add_member',
        entityType: 'approval_group',
        entityId: groupId,
        after: { userId },
      });
    });
  }

  removeMember(groupId: string, userId: string): Promise<void> {
    return this.write(async (tx, scope) => {
      // The group must belong to this org: an admin of org A must not edit org B's groups in the
      // same tenant. 404 either way, so A cannot tell B's group ids from unknown ones.
      const [g] = await tx
        .select({ id: approvalGroups.id })
        .from(approvalGroups)
        .where(
          and(
            eq(approvalGroups.id, groupId),
            eq(approvalGroups.tenantId, scope.tenantId),
            eq(approvalGroups.organizationId, scope.organizationId),
          ),
        );
      if (g === undefined) throw new NotFoundException('Approval group not found');
      const deleted = await tx
        .delete(approvalGroupMembers)
        .where(
          and(
            eq(approvalGroupMembers.groupId, groupId),
            eq(approvalGroupMembers.userId, userId),
            eq(approvalGroupMembers.tenantId, scope.tenantId),
            eq(approvalGroupMembers.organizationId, scope.organizationId),
          ),
        )
        .returning({ id: approvalGroupMembers.id });
      if (deleted.length === 0) throw new NotFoundException('Not a member of that group');
      await this.audit.record(tx, {
        action: 'approvals.group.remove_member',
        entityType: 'approval_group',
        entityId: groupId,
        before: { userId },
      });
    });
  }

  // ---- delegations ---------------------------------------------------------------------------------

  async listDelegations() {
    const { scope } = this.caller.current();
    const rows = await this.db
      .select()
      .from(delegations)
      .where(
        and(
          eq(delegations.tenantId, scope.tenantId),
          eq(delegations.organizationId, scope.organizationId),
          isNull(delegations.revokedAt),
        ),
      )
      .orderBy(asc(delegations.startsAt));
    return rows.map((d) => ({
      id: d.id,
      fromUserId: d.fromUserId,
      toUserId: d.toUserId,
      startsAt: d.startsAt.toISOString(),
      endsAt: d.endsAt.toISOString(),
      documentType: d.documentType,
    }));
  }

  createDelegation(b: {
    fromUserId: string;
    toUserId: string;
    startsAt: Date;
    endsAt: Date;
    documentType: string | null;
  }): Promise<{ id: string }> {
    if (b.fromUserId === b.toUserId)
      throw new BadRequestException('A user cannot delegate to themselves');
    if (b.endsAt <= b.startsAt) throw new BadRequestException('endsAt must be after startsAt');
    return this.write(async (tx, scope, userId) => {
      await this.assertActiveUsers(tx, scope, [b.fromUserId, b.toUserId]);
      const [d] = await tx
        .insert(delegations)
        .values({ ...scope, ...b, createdBy: userId })
        .returning({ id: delegations.id });
      await this.audit.record(tx, {
        action: 'approvals.delegation.create',
        entityType: 'delegation',
        entityId: d!.id,
        after: { ...b, startsAt: b.startsAt.toISOString(), endsAt: b.endsAt.toISOString() },
      });
      return { id: d!.id };
    });
  }

  /** Revoking keeps the row (the audit trail shows who stood in, when); it just stops counting. */
  revokeDelegation(id: string): Promise<void> {
    return this.write(async (tx, scope) => {
      const updated = await tx
        .update(delegations)
        .set({ revokedAt: this.clock() })
        .where(
          and(
            eq(delegations.id, id),
            eq(delegations.tenantId, scope.tenantId),
            eq(delegations.organizationId, scope.organizationId),
            isNull(delegations.revokedAt),
          ),
        )
        .returning({ id: delegations.id });
      if (updated.length === 0) throw new NotFoundException('Delegation not found');
      await this.audit.record(tx, {
        action: 'approvals.delegation.revoke',
        entityType: 'delegation',
        entityId: id,
      });
    });
  }
}

function parseSpec(input: unknown): WorkflowSpec {
  const parsed = WorkflowWriteSpecSchema.safeParse(input);
  if (!parsed.success) {
    throw new BadRequestException(
      `Invalid workflow spec: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  assertMemoApproverShape(parsed.data);
  return parsed.data;
}

/**
 * The Memo approver workflow names the one person or role who signs "Approved by" (F1-Q9), so it has exactly one
 * step and no rules; a spec that says more is refused rather than applied in part.
 */
function assertMemoApproverShape(spec: WorkflowSpec): void {
  if (spec.documentType !== MEMO_APPROVER_DOCUMENT_TYPE) return;
  if (spec.steps.length !== 1 || spec.rules.length !== 0) {
    throw new BadRequestException(
      'The memo approver workflow has exactly one step (who approves the memo) and no rules.',
    );
  }
}

function versionDto(
  v: typeof workflowVersions.$inferSelect,
  callerUserId: string,
  callerSoleEligible = false,
): WorkflowVersionDto {
  const savedByCaller = v.createdBy !== null && v.createdBy === callerUserId;
  return {
    id: v.id,
    version: v.version,
    status: v.status,
    spec: v.spec,
    publishedAt: v.publishedAt?.toISOString() ?? null,
    createdBy: v.createdBy,
    publishedBy: v.publishedBy,
    savedByCaller,
    publishSoleEligible: callerSoleEligible && savedByCaller && v.status === 'draft',
  };
}
