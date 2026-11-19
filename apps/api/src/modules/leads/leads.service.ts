// LeadsService: reads, create, edits and stage changes of leads, and who a lead can be handed to. Serves the NFRs:
// - "the pipeline is auditable": every row change is audited by the database trigger, and a stage change also
//   writes a domain event (with the reason and note) and a stage_change activity on the lead;
// - "no lost updates": a stage change names the version the caller saw; the row is locked, and a stale version
//   is a 409;
// - "no gaps in a numbered series": the LD number is taken inside the create transaction, from the acting entity's
//   series (a lead is entity-owned, so unlike a customer there is no default-entity switch);
// - "authorization is deny-by-default": a record outside the caller's entity or scope is a 404, never a 403.
// Converted is never set here: it belongs to the convert action (a later unit).
import {
  type CreateLeadBody,
  DEFAULT_ROLE_PERMISSIONS,
  type LeadDto,
  type LeadOwnerOption,
  type LeadStageChangeBody,
  type Permission,
  type SchedulableActivityKind,
  type Scope,
  type UpdateLeadBody,
} from '@bos/contracts';
import { activities, leads, rolePermissions, scoped, userRoles } from '@bos/db';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, getTableColumns, ilike, or, type SQL } from 'drizzle-orm';

import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService, scopeWhereFor } from '../../platform/authz/authz.service';
import { type ResourceRef } from '../../platform/authz/can';
import { DB, type Db } from '../../platform/db/db.module';
import { updateVersioned, withIdempotency } from '../../platform/db/idempotency';
import { withTx, type DbTransaction, type TxScope } from '../../platform/db/tx';
import { NumberingService } from '../../platform/settings/numbering.service';
import { nextFollowUpSql } from '../activities/activities.types';
import { activeStaffOfEntity, assertLeadAssignee, mayAssignLead } from './lead-assignee';
import { LeadsCaller } from './leads.caller';
import { changedLeadFields, type LeadRow, type ListLeadsQuery, toLeadDto } from './leads.types';
import { planLeadStageChange, type LeadStageCaller, type LeadStageRefusal } from './lead-stage';

const AUDIT_ENTITY = 'leads';

/** The numbering series key; NumberingService formats it like LD-2082/83-00001. */
export const LEAD_SERIES = 'LD';

/** A follow-up planned on create without a subject is named after its kind. */
const KIND_LABEL: Record<SchedulableActivityKind, string> = {
  call: 'Call',
  meeting: 'Meeting',
  email: 'Email',
};

/**
 * The lead columns plus the derived next follow-up. The derived field has its own name: `leads` already has a
 * (no longer used) `nextFollowUpAt` column, and a same-named key would silently shadow one of the two.
 */
const leadWithNextFollowUp = () => ({ ...getTableColumns(leads), nextFollowUp: nextFollowUpSql() });

/** Narrow to wide, as RoleCache merges roles: when two roles grant crm.lead.write, the wider scope counts. */
const SCOPE_RANK: Readonly<Record<Scope, number>> = {
  own: 0,
  department: 1,
  customer_org: 2,
  all: 3,
};

const notFound = () => new NotFoundException({ code: 'not_found', message: 'Lead not found' });

/** What authz decides on for one lead. No party column: a portal grant reaches no lead. */
export function leadRef(
  row: Pick<LeadRow, 'tenantId' | 'organizationId' | 'ownerUserId'>,
): ResourceRef {
  return {
    tenantId: row.tenantId,
    organizationId: row.organizationId,
    ownerUserId: row.ownerUserId,
  };
}

/** `%` and `_` are wildcards in LIKE; a search for "50%" must match the text, not everything. */
const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function refusalToException(kind: LeadStageRefusal, message: string): Error {
  switch (kind) {
    case 'reason_required':
    case 'use_convert':
      return new BadRequestException({ code: 'bad_request', message });
    case 'manager_only':
      return new ForbiddenException({ code: 'forbidden', message, reason: 'no_permission' });
    default:
      // stale, no_edge: the record's state does not allow this move.
      return new ConflictException({ code: 'conflict', message });
  }
}

@Injectable()
export class LeadsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly numbering: NumberingService,
    private readonly caller: LeadsCaller,
  ) {}

  // -------------------------------------------------------------------------------------------------- read

  async list(q: ListLeadsQuery): Promise<LeadDto[]> {
    const { scope, principal } = this.caller.current();
    const filters: SQL[] = [scopeWhereFor(principal, leads, 'crm.lead.read')];
    if (q.stage !== undefined) filters.push(eq(leads.stage, q.stage));
    if (q.q !== undefined) {
      const pattern = `%${escapeLike(q.q)}%`;
      filters.push(
        or(
          ilike(leads.title, pattern),
          ilike(leads.number, pattern),
          ilike(leads.companyName, pattern),
          ilike(leads.contactName, pattern),
        )!,
      );
    }
    // `nextFollowUp` is a correlated subquery on each lead row, so it can also be a sort key or a filter (U13):
    // `.orderBy(sql`${nextFollowUpSql()} asc nulls last`, desc(leads.id))`, or `isNotNull(nextFollowUpSql())`.
    // The planned-per-lead partial index of migration 0062 serves the subquery.
    const rows = await this.db
      .select(leadWithNextFollowUp())
      .from(leads)
      .where(scoped(scope).where(leads, and(...filters)))
      .orderBy(desc(leads.createdAt), desc(leads.id))
      .limit(q.limit);
    return rows.map(({ nextFollowUp, ...row }) => toLeadDto(row, nextFollowUp));
  }

  async get(id: string): Promise<LeadDto> {
    const { scope } = this.caller.current();
    const [found] = await this.db
      .select(leadWithNextFollowUp())
      .from(leads)
      .where(scoped(scope).where(leads, eq(leads.id, id)));
    if (found === undefined) throw notFound();
    const { nextFollowUp, ...row } = found;
    this.assertVisible('crm.lead.read', row);
    return toLeadDto(row, nextFollowUp);
  }

  // ------------------------------------------------------------------------------------------------- create

  /**
   * The owner defaults to the caller: a salesperson holding `own` scope could otherwise not see the lead they just
   * made. Naming another owner needs a grant that reaches that owner (an `own` scope does not, 403), checked with
   * the same authz rule as every other write; a named owner or follow-up assignee must also be someone the owner
   * select offers (assertLeadAssignee, 400). The Idempotency-Key is optional: the workspace form does not send one.
   *
   * `followUp` (or the old `nextFollowUpAt`, a call named "Follow up") plans the first follow-up as a planned
   * activity in the same transaction (D39): assigned to the owner unless named, named after its kind unless given a
   * subject. The `leads.next_follow_up_at` column is no longer written.
   */
  async create(body: CreateLeadBody, idempotencyKey?: string): Promise<LeadDto> {
    const { scope, actor, principal } = this.caller.current();
    const ownerUserId = body.ownerUserId ?? principal.userId;
    this.authz.assert('crm.lead.write', leadRef({ ...scope, ownerUserId }));
    const followUp =
      body.followUp ??
      (body.nextFollowUpAt === undefined
        ? undefined
        : { kind: 'call' as const, dueAt: body.nextFollowUpAt, subject: 'Follow up' });
    const now = new Date();
    return withTx(this.db, scope, actor, async (tx) => {
      const run = async (): Promise<LeadDto> => {
        // Only a named person is checked: the defaults (the caller, then the owner) keep working as before.
        if (body.ownerUserId !== undefined) {
          await assertLeadAssignee(tx, principal, scope, body.ownerUserId, 'ownerUserId');
        }
        const assigneeUserId = followUp?.assigneeUserId ?? ownerUserId;
        if (followUp?.assigneeUserId !== undefined) {
          await assertLeadAssignee(
            tx,
            principal,
            scope,
            followUp.assigneeUserId,
            'followUp.assigneeUserId',
          );
        }
        const { number } = await this.numbering.issue(tx, LEAD_SERIES, now);
        const [row] = await tx
          .insert(leads)
          .values({
            ...scope,
            number,
            title: body.title,
            source: body.source,
            campaign: body.campaign ?? null,
            ownerUserId,
            companyName: body.companyName,
            contactName: body.contactName,
            emailNorm: body.email === undefined ? null : body.email.trim().toLowerCase(),
            phoneE164: body.phone ?? null,
            requirement: body.requirement ?? null,
            expectedValue: body.expectedValue ?? null,
            currency: body.currency,
            probability: body.probability ?? null,
            expectedClose: body.expectedClose ?? null,
            notes: body.notes ?? null,
            stage: 'new',
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        await this.audit.record(tx, {
          action: 'lead.created',
          entityType: AUDIT_ENTITY,
          entityId: row!.id,
          after: { number, stage: row!.stage, ownerUserId },
        });
        if (followUp === undefined) return toLeadDto(row!, null);
        const dueAt = new Date(followUp.dueAt);
        const [planned] = await tx
          .insert(activities)
          .values({
            ...scope,
            kind: followUp.kind,
            subject: followUp.subject ?? KIND_LABEL[followUp.kind],
            body: followUp.body ?? null,
            leadId: row!.id,
            dueAt,
            assigneeUserId,
            createdByUserId: principal.userId,
          })
          .returning({ id: activities.id });
        await this.audit.record(tx, {
          action: 'activity.scheduled',
          entityType: 'activities',
          entityId: planned!.id,
          after: { kind: followUp.kind, leadId: row!.id, dueAt: followUp.dueAt, assigneeUserId },
        });
        // The only planned activity of a new lead, so it is the next follow-up.
        return toLeadDto(row!, dueAt);
      };
      if (idempotencyKey === undefined) return run();
      const done = await withIdempotency(
        tx,
        { command: 'lead.create', key: idempotencyKey, body },
        async () => ({ status: 201, response: await run() }),
      );
      return done.response;
    });
  }

  // ------------------------------------------------------------------------------------------ stage change

  /**
   * A user's move along LEAD_TRANSITIONS. Converted is refused (the schema already keeps it out of the body, and
   * the planner refuses it for a caller that skips the controller). The manager edge (reopening a lost lead) stays
   * closed over HTTP until the product names who a manager is, as for opportunities.
   */
  async changeStage(id: string, body: LeadStageChangeBody): Promise<LeadDto> {
    const { scope, actor, principal } = this.caller.current();
    const by: LeadStageCaller = 'user';
    return withTx(this.db, scope, actor, async (tx) => {
      const row = await this.lock(tx, scope, id);
      // Scope first (404), then state (409): someone who may not edit learns nothing about the stage.
      this.assertVisible('crm.lead.write', row);

      const plan = planLeadStageChange({
        current: row.stage,
        currentVersion: row.version,
        to: body.stage,
        by,
        reason: body.reason,
        note: body.note,
        expectedVersion: body.expectedVersion,
      });
      if (!plan.ok) throw refusalToException(plan.kind, plan.message);

      const updated = await updateVersioned(tx, leads, id, body.expectedVersion, {
        ...plan.set,
        updatedAt: new Date(),
      });
      await this.audit.record(tx, {
        action: 'lead.stage_changed',
        entityType: AUDIT_ENTITY,
        entityId: id,
        before: { stage: row.stage, version: row.version },
        after: { stage: updated.stage, version: updated.version },
        meta: { reason: plan.set.stageReason, note: plan.set.stageNote },
      });
      await tx.insert(activities).values({
        ...scope,
        kind: 'stage_change',
        subject: `Stage changed from ${row.stage} to ${updated.stage}`,
        body: plan.set.stageNote,
        leadId: id,
        createdByUserId: principal.userId,
      });
      return toLeadDto(updated, await this.nextFollowUpOf(tx, id));
    });
  }

  // ------------------------------------------------------------------------------------------------ update

  /**
   * An edit of the lead's own fields; only the fields sent change. Checks run in this order, the first failure is
   * the answer: out of scope 404, stale version 409, converted 400, nothing changed 400, then a new owner (the same
   * rule as create: an `own` grant cannot hand the lead to someone else, 403; not an active staff member of the
   * entity, 400).
   * Currency has no default here, so an owner-only edit keeps the lead's currency.
   */
  async update(id: string, body: UpdateLeadBody): Promise<LeadDto> {
    const { scope, actor, principal } = this.caller.current();
    const { expectedVersion, ...fields } = body;
    return withTx(this.db, scope, actor, async (tx) => {
      const row = await this.lock(tx, scope, id);
      this.assertVisible('crm.lead.write', row);
      if (row.version !== expectedVersion) {
        throw new ConflictException({
          code: 'conflict',
          message: 'This record was changed by someone else; reload it and try again',
        });
      }
      if (row.stage === 'converted') {
        throw new BadRequestException({
          code: 'bad_request',
          message: 'A converted lead cannot be edited',
        });
      }
      const changes = changedLeadFields(row, fields);
      if (changes.length === 0) {
        throw new BadRequestException({ code: 'bad_request', message: 'Nothing to change' });
      }
      const set = Object.fromEntries(changes.map((c) => [c.column, c.after])) as Partial<
        typeof leads.$inferInsert
      >;
      const newOwner = set.ownerUserId;
      if (typeof newOwner === 'string') {
        // assert, not assertVisible: refusing a new owner is a 403, the lead itself is already in scope.
        this.authz.assert('crm.lead.write', leadRef({ ...row, ownerUserId: newOwner }));
        await assertLeadAssignee(tx, principal, scope, newOwner, 'ownerUserId');
      }

      const updated = await updateVersioned(tx, leads, id, expectedVersion, {
        ...set,
        updatedAt: new Date(),
      });
      await this.audit.record(tx, {
        action: 'lead.updated',
        entityType: AUDIT_ENTITY,
        entityId: id,
        before: Object.fromEntries(changes.map((c) => [c.field, c.before])),
        after: Object.fromEntries(changes.map((c) => [c.field, c.after])),
      });
      if (typeof newOwner === 'string') {
        await this.audit.record(tx, {
          action: 'lead.owner_changed',
          entityType: AUDIT_ENTITY,
          entityId: id,
          before: { ownerUserId: row.ownerUserId },
          after: { ownerUserId: newOwner },
        });
      }
      return toLeadDto(updated, await this.nextFollowUpOf(tx, id));
    });
  }

  // ------------------------------------------------------------------------------------------------ owners

  /**
   * The people the caller may hand a lead to (the owner select, and the follow-up assignee select). The caller is
   * offered when their own grant reaches a lead they own, so an `own` grant offers only the caller. Everyone else
   * must be an active staff member of the acting entity whose roles (narrowed by that membership, as in
   * `UsersStore.userIdsWithRole`) grant crm.lead.write at a scope that reaches a lead they own (`own` or `all`;
   * a lead has no department or party column, so no other scope reaches one), and the caller's grant must reach a
   * lead owned by them: the same `can()` rule as PATCH, so the list never offers a 403.
   */
  async owners(): Promise<LeadOwnerOption[]> {
    const { scope, actor, principal } = this.caller.current();
    return withTx(this.db, scope, actor, async (tx) => {
      const candidates = await activeStaffOfEntity(tx, scope);
      const roleRows = await tx
        .select({ userId: userRoles.userId, roleKey: userRoles.roleKey })
        .from(userRoles)
        .where(eq(userRoles.tenantId, scope.tenantId));
      const writeScopeOf = await this.leadWriteScopes(tx, scope.tenantId);

      const rolesOf = new Map<string, string[]>();
      for (const r of roleRows) rolesOf.set(r.userId, [...(rolesOf.get(r.userId) ?? []), r.roleKey]);
      const ownsLeads = (userId: string, membershipRoles: string[] | null): boolean => {
        const roles = (rolesOf.get(userId) ?? []).filter(
          (role) => membershipRoles === null || membershipRoles.includes(role),
        );
        let widest: Scope | undefined;
        for (const role of roles) {
          const s = writeScopeOf.get(role);
          if (s !== undefined && (widest === undefined || SCOPE_RANK[s] > SCOPE_RANK[widest])) {
            widest = s;
          }
        }
        return widest === 'own' || widest === 'all';
      };

      return candidates
        .filter(
          (c) =>
            mayAssignLead(principal, scope, c.userId) &&
            (c.userId === principal.userId || ownsLeads(c.userId, c.roleKeys)),
        )
        .map((c) => ({
          userId: c.userId,
          displayName: c.displayName ?? c.email ?? 'Unnamed user',
          email: c.email ?? '',
        }))
        .sort(
          (a, b) =>
            a.displayName.localeCompare(b.displayName) || a.userId.localeCompare(b.userId),
        );
    });
  }

  // ----------------------------------------------------------------------------------------------- helpers

  /**
   * Role key to its crm.lead.write scope in this tenant. The tenant's `role_permissions` rows are the truth once it
   * has any; a tenant with none uses the defaults, as RoleCache does.
   */
  private async leadWriteScopes(tx: DbTransaction, tenantId: string): Promise<Map<string, Scope>> {
    const [any] = await tx
      .select({ id: rolePermissions.id })
      .from(rolePermissions)
      .where(eq(rolePermissions.tenantId, tenantId))
      .limit(1);
    if (any === undefined) {
      const defaults = new Map<string, Scope>();
      for (const [role, grants] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
        const s = (grants)['crm.lead.write'];
        if (s !== undefined) defaults.set(role, s);
      }
      return defaults;
    }
    const rows = await tx
      .select({ roleKey: rolePermissions.roleKey, scope: rolePermissions.scope })
      .from(rolePermissions)
      .where(
        and(
          eq(rolePermissions.tenantId, tenantId),
          eq(rolePermissions.permission, 'crm.lead.write'),
        ),
      );
    return new Map(rows.map((r) => [r.roleKey, r.scope]));
  }

  /**
   * Record-level authz that answers 404, not 403, for a lead outside the caller's scope: a 403 would confirm that a
   * guessed id exists. Other denials (no grant at all, inactive user) stay 403.
   */
  private assertVisible(action: Permission, row: LeadRow): void {
    try {
      this.authz.assert(action, leadRef(row));
    } catch (error) {
      const reason =
        error instanceof ForbiddenException
          ? (error.getResponse() as { reason?: unknown }).reason
          : undefined;
      if (reason === 'out_of_scope') throw notFound();
      throw error;
    }
  }

  /** The lead row of this entity, locked until the transaction ends (updateVersioned filters on the tenant only). */
  private async lock(tx: DbTransaction, scope: TxScope, id: string): Promise<LeadRow> {
    const [row] = await tx
      .select()
      .from(leads)
      .where(scoped(scope).where(leads, eq(leads.id, id)))
      .for('update');
    if (row === undefined) throw notFound();
    return row;
  }

  /** The derived next follow-up of one lead (see toLeadDto), read inside the caller's transaction. */
  private async nextFollowUpOf(tx: DbTransaction, id: string): Promise<Date | null> {
    const [row] = await tx
      .select({ nextFollowUp: nextFollowUpSql() })
      .from(leads)
      .where(eq(leads.id, id));
    return row?.nextFollowUp ?? null;
  }
}
