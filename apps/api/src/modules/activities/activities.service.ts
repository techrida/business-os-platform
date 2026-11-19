// ActivitiesService: the calls, meetings, emails and notes logged or planned against a lead, opportunity, customer,
// contact or quotation. A planned one (a follow-up, D39) has a due time and is neither completed nor cancelled
// (isPlannedSql); everything else that is not cancelled is logged. Serves the NFRs:
// - "authorization is deny-by-default": an activity takes the permission of its subject (crm.lead.* for a lead, and
//   so on). The route carries only @AnyAuthenticated because one static @Can cannot name "the subject's
//   permission"; every read and write here asserts that permission on the subject row (404 for another entity or
//   outside the caller's scope), and a caller who is not staff is refused. The unfiltered list returns only the
//   activities whose subject the caller may read, built from the same scope SQL as the subject's own list;
// - "one subject": the contract refines it and the activities_one_subject_check CHECK enforces it again;
// - "the pipeline is auditable": every create is a domain event as well as an audited row.
import {
  ACTIVITY_SUBJECT_KEYS,
  type ActivityDto,
  type CancelActivityBody,
  type CompleteActivityBody,
  type CreateActivityBody,
  type Permission,
  type RescheduleActivityBody,
} from '@bos/contracts';
import {
  activities,
  customerContacts,
  customers,
  leads,
  opportunities,
  quotations,
  scoped,
  users,
} from '@bos/db';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, not, or, type SQL } from 'drizzle-orm';

import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService, scopeWhereFor } from '../../platform/authz/authz.service';
import { type Principal, type ResourceRef } from '../../platform/authz/can';
import { DB, type Db } from '../../platform/db/db.module';
import { updateVersioned, withIdempotency } from '../../platform/db/idempotency';
import { withTx, type DbTransaction, type TxScope } from '../../platform/db/tx';
import { customerRef } from '../customers/customers.service';
import { leadRef } from '../leads/leads.service';
import { opportunityRef } from '../opportunities/opportunities.service';
import { ActivitiesCaller } from './activities.caller';
import {
  isPlannedRow,
  isPlannedSql,
  SUBJECT_PERMISSION,
  toActivityDto,
  type ActivityRow,
  type ListActivitiesQuery,
  type SubjectKey,
} from './activities.types';

type Q = Db | DbTransaction;

const AUDIT_ENTITY = 'activities';

const subjectNotFound = () =>
  new NotFoundException({ code: 'not_found', message: 'Subject not found' });
const activityNotFound = () =>
  new NotFoundException({ code: 'not_found', message: 'Activity not found' });

/** Kinds only the server writes: they record what happened and are never planned, done or called off by hand. */
const SYSTEM_KINDS: ReadonlySet<ActivityRow['kind']> = new Set(['system', 'stage_change']);

@Injectable()
export class ActivitiesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly caller: ActivitiesCaller,
  ) {}

  // -------------------------------------------------------------------------------------------------- read

  async list(q: ListActivitiesQuery): Promise<ActivityDto[]> {
    const { scope, principal } = this.caller.current();
    this.assertStaff(principal);
    const filters: SQL[] = [];
    const subject = ACTIVITY_SUBJECT_KEYS.find((k) => q[k] !== undefined);
    if (subject !== undefined) {
      const id = q[subject]!;
      await this.assertSubject(this.db, subject, id, 'read');
      filters.push(eq(activities[subject], id));
    } else {
      filters.push(this.readableSubjects(principal));
    }
    if (q.kind !== undefined) filters.push(eq(activities.kind, q.kind));
    // A cancelled activity never lists. Planned ones are due earliest first; logged ones newest first.
    filters.push(isNull(activities.cancelledAt));
    if (q.status === 'planned') filters.push(isPlannedSql);
    if (q.status === 'logged') filters.push(not(isPlannedSql));
    const order =
      q.status === 'planned'
        ? [asc(activities.dueAt), asc(activities.id)]
        : [desc(activities.occurredAt), desc(activities.id)];
    const rows = await this.db
      .select()
      .from(activities)
      .where(scoped(scope).where(activities, and(...filters)))
      .orderBy(...order)
      .limit(q.limit);
    return rows.map(toActivityDto);
  }

  // ------------------------------------------------------------------------------------------------- create

  /**
   * A `dueAt` plans the activity (a follow-up, audited `activity.scheduled`); without one it is logged
   * (`activity.created`). The caller is recorded as its creator. A planned activity without an assignee goes to
   * the lead's owner when its subject is a lead, otherwise to the caller. The Idempotency-Key is optional: the
   * workspace form does not send one.
   */
  async create(body: CreateActivityBody, idempotencyKey?: string): Promise<ActivityDto> {
    const { scope, actor, principal } = this.caller.current();
    this.assertStaff(principal);
    // The contract guarantees exactly one subject; a caller that skips the controller is refused here too.
    const subjects = ACTIVITY_SUBJECT_KEYS.filter((k) => body[k] !== undefined);
    if (subjects.length !== 1) {
      throw new BadRequestException({
        code: 'bad_request',
        message: 'exactly one of leadId, opportunityId, customerId, contactId or quotationId',
      });
    }
    const key = subjects[0]!;
    const subjectId = body[key]!;
    return withTx(this.db, scope, actor, async (tx) => {
      const run = async (): Promise<ActivityDto> => {
        const ref = await this.assertSubject(tx, key, subjectId, 'write');
        if (body.assigneeUserId !== undefined) {
          await this.assertUser(tx, scope.tenantId, body.assigneeUserId);
        }
        const planned = body.dueAt !== undefined;
        // A lead without an owner falls back to the caller, so a follow-up always has someone to do it.
        const defaultAssignee =
          key === 'leadId' ? (ref.ownerUserId ?? principal.userId) : principal.userId;
        const assigneeUserId = body.assigneeUserId ?? (planned ? defaultAssignee : null);
        const [row] = await tx
          .insert(activities)
          .values({
            ...scope,
            kind: body.kind,
            subject: body.subject,
            body: body.body ?? null,
            [key]: subjectId,
            dueAt: body.dueAt === undefined ? null : new Date(body.dueAt),
            assigneeUserId,
            createdByUserId: principal.userId,
            ...(body.occurredAt === undefined ? {} : { occurredAt: new Date(body.occurredAt) }),
          })
          .returning();
        await this.audit.record(tx, {
          action: planned ? 'activity.scheduled' : 'activity.created',
          entityType: 'activities',
          entityId: row!.id,
          after: {
            kind: body.kind,
            [key]: subjectId,
            ...(planned ? { dueAt: body.dueAt, assigneeUserId } : {}),
          },
        });
        return toActivityDto(row!);
      };
      if (idempotencyKey === undefined) return run();
      const done = await withIdempotency(
        tx,
        { command: 'activity.create', key: idempotencyKey, body },
        async () => ({ status: 201, response: await run() }),
      );
      return done.response;
    });
  }

  // ------------------------------------------------------------------------------ planned: complete, reschedule, cancel

  /**
   * Marks a planned activity done: it becomes logged (History) with `occurredAt` = when it actually happened
   * (default now). A note is appended to its details after a blank line.
   */
  async complete(id: string, body: CompleteActivityBody): Promise<ActivityDto> {
    return this.changePlanned(id, async (tx, row) => {
      const now = new Date();
      const note = body.note?.trim();
      const details =
        note === undefined || note === ''
          ? row.body
          : row.body === null || row.body.trim() === ''
            ? note
            : `${row.body}\n\n${note}`;
      const updated = await updateVersioned(tx, activities, id, body.expectedVersion, {
        completedAt: now,
        occurredAt: body.occurredAt === undefined ? now : new Date(body.occurredAt),
        body: details,
        updatedAt: now,
      });
      await this.audit.record(tx, {
        action: 'activity.completed',
        entityType: AUDIT_ENTITY,
        entityId: id,
        before: {
          completedAt: null,
          occurredAt: row.occurredAt.toISOString(),
          version: row.version,
        },
        after: {
          completedAt: now.toISOString(),
          occurredAt: updated.occurredAt.toISOString(),
          version: updated.version,
        },
        ...(details === row.body ? {} : { meta: { noteAppended: true } }),
      });
      return updated;
    });
  }

  /** Moves a planned activity to another due time, and optionally to another assignee of this tenant. */
  async reschedule(id: string, body: RescheduleActivityBody): Promise<ActivityDto> {
    return this.changePlanned(id, async (tx, row, scope) => {
      if (body.assigneeUserId !== undefined) {
        await this.assertUser(tx, scope.tenantId, body.assigneeUserId);
      }
      const updated = await updateVersioned(tx, activities, id, body.expectedVersion, {
        dueAt: new Date(body.dueAt),
        ...(body.assigneeUserId === undefined ? {} : { assigneeUserId: body.assigneeUserId }),
        updatedAt: new Date(),
      });
      await this.audit.record(tx, {
        action: 'activity.rescheduled',
        entityType: AUDIT_ENTITY,
        entityId: id,
        before: {
          dueAt: row.dueAt?.toISOString() ?? null,
          assigneeUserId: row.assigneeUserId,
          version: row.version,
        },
        after: {
          dueAt: updated.dueAt?.toISOString() ?? null,
          assigneeUserId: updated.assigneeUserId,
          version: updated.version,
        },
      });
      return updated;
    });
  }

  /** Calls off a planned activity: it never lists again (neither planned nor logged). */
  async cancel(id: string, body: CancelActivityBody): Promise<ActivityDto> {
    return this.changePlanned(id, async (tx, row) => {
      const now = new Date();
      const updated = await updateVersioned(tx, activities, id, body.expectedVersion, {
        cancelledAt: now,
        updatedAt: now,
      });
      await this.audit.record(tx, {
        action: 'activity.cancelled',
        entityType: AUDIT_ENTITY,
        entityId: id,
        before: { cancelledAt: null, version: row.version },
        after: { cancelledAt: now.toISOString(), version: updated.version },
      });
      return updated;
    });
  }

  /**
   * The shared frame of the three planned-activity changes: staff only; the row is locked in this entity (404
   * otherwise); the caller must hold the write permission of its subject (404 out of scope, before anything
   * that would reveal the row's state); then 409 for a server-written kind or a row that is no longer planned.
   * `change` writes through updateVersioned, so a stale `expectedVersion` is a 409 too.
   */
  private async changePlanned(
    id: string,
    change: (tx: DbTransaction, row: ActivityRow, scope: TxScope) => Promise<ActivityRow>,
  ): Promise<ActivityDto> {
    const { scope, actor, principal } = this.caller.current();
    this.assertStaff(principal);
    return withTx(this.db, scope, actor, async (tx) => {
      const [row] = await tx
        .select()
        .from(activities)
        .where(scoped(scope).where(activities, eq(activities.id, id)))
        .for('update');
      if (row === undefined) throw activityNotFound();
      const key = ACTIVITY_SUBJECT_KEYS.find((k) => row[k] !== null);
      if (key === undefined) throw activityNotFound();
      // Out of scope answers exactly like an unknown id, so a guessed activity id learns nothing.
      await this.assertSubject(tx, key, row[key]!, 'write', activityNotFound);
      if (SYSTEM_KINDS.has(row.kind)) {
        throw new ConflictException({
          code: 'conflict',
          message: 'This activity was written by the system and cannot be changed',
        });
      }
      if (!isPlannedRow(row)) {
        throw new ConflictException({
          code: 'conflict',
          message: 'Only a planned activity can be changed; this one is already done or cancelled',
        });
      }
      return toActivityDto(await change(tx, row, scope));
    });
  }

  // ----------------------------------------------------------------------------------------------- helpers

  /** Activities are staff-only: a portal user holding a CRM grant by mistake is still refused. */
  private assertStaff(p: Principal): void {
    if (p.orgKind !== 'staff') {
      throw new ForbiddenException({
        code: 'forbidden',
        message: 'Forbidden',
        reason: 'no_permission',
      });
    }
  }

  /**
   * The subject row must exist in this entity (tenant, for a customer or contact) and the caller must hold the
   * subject's read or write permission on it. Out of scope is a 404, never a 403, so a guessed id learns nothing.
   * Returns the subject's ref (a lead's carries its owner). `notFound` is the 404 to answer with: a route keyed by
   * an activity id answers as if the activity itself were unknown.
   */
  private async assertSubject(
    q: Q,
    key: SubjectKey,
    id: string,
    mode: 'read' | 'write',
    notFound: () => NotFoundException = subjectNotFound,
  ): Promise<ResourceRef> {
    const { scope, principal } = this.caller.current();
    const ref = await this.refOf(q, key, id, scope, principal);
    if (ref === undefined) throw notFound();
    const action: Permission = SUBJECT_PERMISSION[key][mode];
    try {
      this.authz.assert(action, ref);
      return ref;
    } catch (error) {
      const reason =
        error instanceof ForbiddenException
          ? (error.getResponse() as { reason?: unknown }).reason
          : undefined;
      if (reason === 'out_of_scope') throw notFound();
      throw error;
    }
  }

  private async refOf(
    q: Q,
    key: SubjectKey,
    id: string,
    scope: { tenantId: string; organizationId: string },
    principal: Principal,
  ): Promise<ResourceRef | undefined> {
    switch (key) {
      case 'leadId': {
        const [row] = await q
          .select()
          .from(leads)
          .where(scoped(scope).where(leads, eq(leads.id, id)));
        return row === undefined ? undefined : leadRef(row);
      }
      case 'opportunityId': {
        const [row] = await q
          .select()
          .from(opportunities)
          .where(scoped(scope).where(opportunities, eq(opportunities.id, id)));
        return row === undefined ? undefined : opportunityRef(row);
      }
      case 'quotationId': {
        const [row] = await q
          .select()
          .from(quotations)
          .where(scoped(scope).where(quotations, eq(quotations.id, id)));
        return row === undefined
          ? undefined
          : {
              tenantId: row.tenantId,
              organizationId: row.organizationId,
              ownerUserId: row.ownerUserId,
              customerPartyId: row.customerPartyId,
            };
      }
      case 'customerId':
      case 'contactId': {
        let customerId = id;
        if (key === 'contactId') {
          const [contact] = await q
            .select({ customerId: customerContacts.customerId })
            .from(customerContacts)
            .where(and(eq(customerContacts.tenantId, scope.tenantId), eq(customerContacts.id, id)));
          if (contact === undefined) return undefined;
          customerId = contact.customerId;
        }
        const [row] = await q
          .select()
          .from(customers)
          .where(and(eq(customers.tenantId, scope.tenantId), eq(customers.id, customerId)));
        return row === undefined ? undefined : customerRef(row, principal);
      }
    }
  }

  /**
   * The unfiltered list: an activity is readable when its subject is one the caller may read. Each branch reuses
   * the subject's own scope SQL (scopeWhereFor), so the list and the subject's page agree. Customers are
   * tenant-level, so they get the same rule customers use: `all` is the tenant, `own` the owner column.
   */
  private readableSubjects(p: Principal): SQL {
    const ids = <T extends typeof leads | typeof opportunities | typeof quotations>(
      table: T,
      permission: Permission,
    ) =>
      this.db
        .select({ id: table.id })
        .from(table as typeof leads)
        .where(scopeWhereFor(p, table, permission));
    const customerIds = (): SQL => {
      const grant = p.grants.get('customer.read');
      const inTenant = eq(customers.tenantId, p.tenantId);
      if (p.status !== 'active') return inArray(customers.id, []);
      if (grant === 'all') return inTenant;
      if (grant === 'own') return and(inTenant, eq(customers.ownerUserId, p.userId))!;
      return inArray(customers.id, []);
    };
    const visibleCustomers = this.db
      .select({ id: customers.id })
      .from(customers)
      .where(customerIds());
    const contactsOfVisible = this.db
      .select({ id: customerContacts.id })
      .from(customerContacts)
      .where(
        and(
          eq(customerContacts.tenantId, p.tenantId),
          inArray(customerContacts.customerId, visibleCustomers),
        ),
      );
    return or(
      inArray(activities.leadId, ids(leads, 'crm.lead.read')),
      inArray(activities.opportunityId, ids(opportunities, 'crm.opportunity.read')),
      inArray(activities.quotationId, ids(quotations, 'quotation.read')),
      inArray(activities.customerId, visibleCustomers),
      inArray(activities.contactId, contactsOfVisible),
    )!;
  }

  /** The assignee must be a user of this tenant: say so as a 400 instead of a foreign-key 500. */
  private async assertUser(tx: DbTransaction, tenantId: string, userId: string): Promise<void> {
    const [user] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.id, userId)))
      .limit(1);
    if (user === undefined) {
      throw new BadRequestException({
        code: 'bad_request',
        message: 'assigneeUserId is not a user of this tenant',
      });
    }
  }
}
