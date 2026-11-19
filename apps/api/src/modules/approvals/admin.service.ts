// Admin side of approvals: workflow definitions with draft and published versions, approval groups
// and their members, and delegations. Serves the NFR "approvals are auditable": a spec is edited only
// as a draft, publishing freezes it (the DB trigger refuses later edits), and a new version affects
// only requests submitted after it is published, because each request keeps its own version id.
import { WorkflowWriteSpecSchema, type WorkflowSpec } from '@bos/contracts';
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
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, isNull } from 'drizzle-orm';

import { DB, type Db, type DbTransaction } from '../../platform/db/db.module';
import { withTx, type TxScope } from '../../platform/db/tx';
import { APPROVALS_CLOCK, ApprovalsAudit, ApprovalsCaller, type Clock } from './ports';
import { activeEntityStaff, pgCode } from './requests.service';

export interface WorkflowVersionDto {
  id: string;
  version: number;
  status: 'draft' | 'published' | 'retired';
  spec: unknown;
  publishedAt: string | null;
}
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
  ) {}

  /** Runs `fn` in a transaction as the calling user, and turns constraint errors into 409. */
  private async write<T>(
    fn: (tx: DbTransaction, scope: TxScope, userId: string) => Promise<T>,
  ): Promise<T> {
    const { scope, actor, principal } = this.caller.current();
    try {
      return await withTx(this.db, scope, actor, (tx) => fn(tx, scope, principal.userId));
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
      .select({ id: users.id, displayName: users.displayName, email: users.email })
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
    return { items, nextAfter: items.length === q.limit ? (items.at(-1)?.id ?? null) : null };
  }

  // ---- workflows -----------------------------------------------------------------------------------

  async listWorkflows(): Promise<WorkflowDto[]> {
    const { scope } = this.caller.current();
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
    return defs.map((d) => ({
      id: d.id,
      key: d.key,
      name: d.name,
      documentType: d.documentType,
      currentVersionId: d.currentVersionId,
      versions: versions.filter((v) => v.definitionId === d.id).map(versionDto),
    }));
  }

  /** A new definition with version 1 as a draft. */
  async createWorkflow(b: {
    key: string;
    name: string;
    spec: unknown;
  }): Promise<WorkflowVersionDto> {
    const spec = parseSpec(b.spec);
    return this.write(async (tx, scope) => {
      const [def] = await tx
        .insert(workflowDefinitions)
        .values({ ...scope, key: b.key, name: b.name, documentType: spec.documentType })
        .returning();
      const [v] = await tx
        .insert(workflowVersions)
        .values({ ...scope, definitionId: def!.id, version: 1, status: 'draft', spec })
        .returning();
      await this.audit.record(tx, {
        action: 'approvals.workflow.create',
        entityType: 'workflow_definition',
        entityId: def!.id,
        after: { key: b.key, documentType: spec.documentType },
      });
      return versionDto(v!);
    });
  }

  /** The next version number as a draft. Requests already submitted keep the version they had. */
  async addVersion(key: string, specInput: unknown): Promise<WorkflowVersionDto> {
    const spec = parseSpec(specInput);
    return this.write(async (tx, scope) => {
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
        })
        .returning();
      await this.audit.record(tx, {
        action: 'approvals.workflow.version',
        entityType: 'workflow_version',
        entityId: v!.id,
        after: { key, version: v!.version },
      });
      return versionDto(v!);
    });
  }

  /** Publishes a draft: it becomes the current version, and the previous published one is retired. */
  async publish(key: string, version: number): Promise<WorkflowVersionDto> {
    return this.write(async (tx, scope, userId) => {
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
      const spec = parseSpec(v.spec);
      await this.assertGroupsExist(tx, scope, spec);
      const now = this.clock();
      await tx
        .update(workflowVersions)
        .set({ status: 'retired' })
        .where(
          and(eq(workflowVersions.definitionId, def.id), eq(workflowVersions.status, 'published')),
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
        action: 'approvals.workflow.publish',
        entityType: 'workflow_version',
        entityId: v.id,
        before: { currentVersionId: def.currentVersionId },
        after: { key, version },
      });
      return versionDto(published!);
    });
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
  return parsed.data;
}

function versionDto(v: typeof workflowVersions.$inferSelect): WorkflowVersionDto {
  return {
    id: v.id,
    version: v.version,
    status: v.status,
    spec: v.spec,
    publishedAt: v.publishedAt?.toISOString() ?? null,
  };
}
