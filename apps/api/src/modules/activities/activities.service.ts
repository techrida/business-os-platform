// ActivitiesService: the calls, meetings, emails and notes logged or planned against a lead, opportunity, customer,
// contact or quotation. A planned one (a follow-up, D39) has a due time and is neither completed nor cancelled
// (isPlannedSql); everything else that is not cancelled is logged. Serves the NFRs:
// - "authorization is deny-by-default": an activity takes the permission of its subject (crm.lead.* for a lead, and
//   so on). The route carries only @AnyAuthenticated because one static @Can cannot name "the subject's
//   permission"; every read and write here asserts that permission on the subject row (404 for another entity or
//   outside the caller's scope), and a caller who is not staff is refused. The unfiltered list returns only the
//   activities whose subject the caller may read, built from the same scope SQL as the subject's own list, plus
//   the caller's own follow-ups. The one exception to "write needs subject write": the assignee of a follow-up may
//   complete it on a subject they can only read (K5). A collection call (0154, R4c1 Q1) takes no permission from its
//   customer: it lists for whoever holds `ar.read` and is completed, moved or cancelled with `payment.record`, so the
//   customer's Sales owner neither sees nor cancels a call about its money;
// - "work goes only to someone who can do it" (D50, dead-end #21): a named assignee passes the assignment rule of
//   the subject's area and must be able to read the subject once assigned, else 400 with the rule's reason;
// - "one subject": the contract refines it and the activities_one_subject_check CHECK enforces it again;
// - "the pipeline is auditable": every create is a domain event as well as an audited row.
import {
  ACTIVITY_SUBJECT_KEYS,
  type ActivityDto,
  type AssignmentAreaKey,
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
} from '@bos/db';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, not, or, type SQL } from 'drizzle-orm';

import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService, scopeWhereFor } from '../../platform/authz/authz.service';
import { type Principal, type ResourceRef } from '../../platform/authz/can';
import { loadRecordReaders } from '../../platform/authz/record-reach';
import { RoleCache } from '../../platform/authz/role-cache';
import { DB, type Db } from '../../platform/db/db.module';
import { updateVersioned, withIdempotency } from '../../platform/db/idempotency';
import { withTx, type DbTransaction, type TxScope } from '../../platform/db/tx';
import { searchPage } from '../../platform/list';
import { NotifyService } from '../../platform/notify/notify.service';
import { customerRef } from '../customers/customers.service';
import {
  assertAssignable,
  assignmentRefused,
  loadAssignmentParties,
  partyHolds,
  storedAssignmentRule,
} from '../leads/lead-assignee';
import { leadRef } from '../leads/leads.service';
import { opportunityRef } from '../opportunities/opportunities.service';
import { ActivitiesCaller } from './activities.caller';
import {
  COLLECTION_CALL_CHANGE,
  COLLECTION_CALL_KIND,
  COLLECTION_CALL_READ,
  dueRangeBounds,
  activityNames,
  isPlannedSql,
  SUBJECT_PERMISSION,
  toActivityDto,
  type ActivityRow,
  type ListActivitiesQuery,
  type SubjectKey,
} from './activities.types';
import {
  activityCan,
  loadSubjectRefs,
  mayHaveActions,
  mayReadCollectionCalls,
  needsSubjectRef,
  plannedChangeDecision,
  refKey,
  subjectKeyOf,
  type PlannedChange,
} from './activity-can';
import { notifyFollowUpAssigned } from './follow-ups';

type Q = Db | DbTransaction;

/**
 * Whose assignment rule a subject follows (D50: activities follow their parent, quotations their opportunity).
 * Customers and contacts have none: any active staff member who can read the customer may be given the work.
 */
const RULE_AREA: Partial<Record<SubjectKey, AssignmentAreaKey>> = {
  leadId: 'leads',
  opportunityId: 'opportunities',
  quotationId: 'opportunities',
};

/**
 * Where the assignee opens the work: the subject's own page, or the follow-ups page for a customer or contact (the
 * customer page lists no follow-ups to act on).
 */
function assignedLink(key: SubjectKey, subjectId: string): string {
  switch (key) {
    case 'leadId':
      return `/leads/${subjectId}`;
    case 'opportunityId':
      return `/opportunities/${subjectId}`;
    case 'quotationId':
      return `/quotations/${subjectId}`;
    default:
      return '/activities/';
  }
}

const AUDIT_ENTITY = 'activities';

const subjectNotFound = () =>
  new NotFoundException({ code: 'not_found', message: 'Subject not found' });
const activityNotFound = () =>
  new NotFoundException({ code: 'not_found', message: 'Activity not found' });

@Injectable()
export class ActivitiesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly caller: ActivitiesCaller,
    private readonly roleCache: RoleCache,
    private readonly notify: NotifyService,
  ) {}

  // -------------------------------------------------------------------------------------------------- read

  async list(q: ListActivitiesQuery): Promise<{ items: ActivityDto[]; total: number }> {
    const { scope, principal } = this.caller.current();
    this.assertStaff(principal);
    const filters: SQL[] = [];
    const subject = ACTIVITY_SUBJECT_KEYS.find((k) => q[k] !== undefined);
    if (subject !== undefined) {
      const id = q[subject]!;
      await this.assertSubject(this.db, subject, id, 'read');
      filters.push(eq(activities[subject], id));
      // Reading the customer is not reading its receivables: its collection calls list by `ar.read` alone.
      if (!mayReadCollectionCalls(principal, scope)) {
        filters.push(ne(activities.kind, COLLECTION_CALL_KIND));
      }
    } else {
      filters.push(this.readableActivities(principal, scope));
    }
    if (q.kind !== undefined && q.kind.length > 0) filters.push(inArray(activities.kind, q.kind));
    // A cancelled activity never lists. Planned ones are due earliest first; logged ones newest first.
    filters.push(isNull(activities.cancelledAt));
    if (q.status === 'planned') filters.push(isPlannedSql);
    if (q.status === 'logged') filters.push(not(isPlannedSql));
    // A due-day range keeps only activities with a due time inside it (a NULL due time never compares).
    const due = dueRangeBounds(q);
    if (due.from !== undefined) filters.push(gte(activities.dueAt, due.from));
    if (due.before !== undefined) filters.push(lt(activities.dueAt, due.before));
    const order =
      q.status === 'planned'
        ? [asc(activities.dueAt), asc(activities.id)]
        : [desc(activities.occurredAt), desc(activities.id)];
    const { rows, total } = await searchPage(this.db, {
      q: q.q,
      columns: [activities.subject, activities.body],
      where: scoped(scope).where(activities, and(...filters)),
      orderBy: order,
      limit: q.limit,
      offset: q.offset,
      rows: (tx, p) =>
        tx
          .select()
          .from(activities)
          .where(p.where)
          .orderBy(...p.orderBy)
          .limit(p.limit)
          .offset(p.offset),
      count: (tx, where) => tx.$count(activities, where),
    });
    const names = await activityNames(this.db, scope.tenantId, rows);
    // Each row's actions for the caller, by the rule the write routes enforce (activity-can.ts).
    const subjects = rows.filter(mayHaveActions).flatMap((r) => {
      const key = subjectKeyOf(r);
      return key === undefined ? [] : [{ key, id: r[key]! }];
    });
    const refs = await loadSubjectRefs(this.db, scope, principal, subjects, true);
    return {
      items: rows.map((r) => toActivityDto(r, names, activityCan(principal, r, refs))),
      total,
    };
  }

  // ------------------------------------------------------------------------------------------------- create

  /**
   * A `dueAt` plans the activity (a follow-up, audited `activity.scheduled`); without one it is logged
   * (`activity.created`). The caller is recorded as its creator. A planned activity without an assignee goes to
   * the owner of its lead, opportunity or quotation (K5), otherwise to the caller. A named assignee must pass
   * `assertAssignee`, else 400. A follow-up planned for someone other than the caller notifies them
   * (`crm.assigned`, #22) in the same transaction. The Idempotency-Key is optional: the workspace form does not
   * send one.
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
    let notified = false;
    const dto = await withTx(this.db, scope, actor, async (tx) => {
      const run = async (): Promise<ActivityDto> => {
        const planned = body.dueAt !== undefined;
        const ref = await this.assertSubject(tx, key, subjectId, 'write', subjectNotFound, planned);
        if (body.assigneeUserId !== undefined) {
          await this.assertAssignee(tx, scope, key, body.assigneeUserId);
        }
        // The owner of the record does its work by default; a record without an owner (or a customer or contact,
        // whose owner is not a salesperson) falls back to the caller, so a follow-up always has someone to do it.
        const defaultAssignee =
          RULE_AREA[key] !== undefined ? (ref.ownerUserId ?? principal.userId) : principal.userId;
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
        if (planned && assigneeUserId !== null && assigneeUserId !== principal.userId) {
          await this.notifyAssigned(tx, key, row!, principal);
          notified = true;
        }
        return toActivityDto(row!, await activityNames(tx, scope.tenantId, [row!]));
      };
      if (idempotencyKey === undefined) return run();
      const done = await withIdempotency(
        tx,
        { command: 'activity.create', key: idempotencyKey, body },
        async () => ({ status: 201, response: await run() }),
      );
      return done.response;
    });
    // After the commit, never inside it (notify.service.ts): the drainer must find the outbox row.
    if (notified) await this.notify.nudge();
    return dto;
  }

  // ------------------------------------------------------------------------------ planned: complete, reschedule, cancel

  /**
   * Marks a planned activity done: it becomes logged (History) with `occurredAt` = when it actually happened
   * (default now). A note is appended to its details after a blank line.
   */
  async complete(id: string, body: CompleteActivityBody): Promise<ActivityDto> {
    return this.changePlanned(id, 'complete', async (tx, row) => {
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

  /**
   * Moves a planned activity to another due time, and optionally to another assignee. A new assignee passes the
   * same check as on create and is notified unless it is the caller; naming the current assignee again checks
   * nothing, so a follow-up stays movable after its assignee's access or department changed.
   */
  async reschedule(id: string, body: RescheduleActivityBody): Promise<ActivityDto> {
    const { principal } = this.caller.current();
    let notified = false;
    const dto = await this.changePlanned(id, 'reschedule', async (tx, row, scope, key) => {
      const newAssignee =
        body.assigneeUserId !== undefined && body.assigneeUserId !== row.assigneeUserId
          ? body.assigneeUserId
          : undefined;
      if (newAssignee !== undefined && row.kind === COLLECTION_CALL_KIND) {
        await this.assertCollector(tx, scope, newAssignee);
      } else if (newAssignee !== undefined) {
        await this.assertAssignee(tx, scope, key, newAssignee);
      }
      const updated = await updateVersioned(tx, activities, id, body.expectedVersion, {
        dueAt: new Date(body.dueAt),
        ...(body.assigneeUserId === undefined ? {} : { assigneeUserId: body.assigneeUserId }),
        updatedAt: new Date(),
      });
      if (newAssignee !== undefined && newAssignee !== principal.userId) {
        await this.notifyAssigned(tx, key, updated, principal);
        notified = true;
      }
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
    if (notified) await this.notify.nudge();
    return dto;
  }

  /** Calls off a planned activity: it never lists again (neither planned nor logged). */
  async cancel(id: string, body: CancelActivityBody): Promise<ActivityDto> {
    return this.changePlanned(id, 'cancel', async (tx, row) => {
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
   * otherwise); then `plannedChangeDecision` (activity-can.ts): the caller must hold the write permission of its
   * subject (404 out of scope, before anything that would reveal the row's state); then 409 for a server-written
   * kind or a row that is no longer planned.
   * `change` writes through updateVersioned, so a stale `expectedVersion` is a 409 too.
   *
   * The assignee is the exception (K5): their follow-up is theirs to do, so they may complete it on a subject they
   * can only read (assigned reach). Rescheduling or calling it off still needs the subject's write permission, and
   * they get a 403 for it rather than a 404: the follow-up is on their own list, so it is no secret. On a customer or
   * contact, which has no assigned reach, the assignee completes it without reaching the customer (U20a2-Q7).
   * A collection call follows the receivables permissions instead (404 without `ar.read`, 403 without
   * `payment.record`), with no assignee shortcut.
   */
  private async changePlanned(
    id: string,
    what: PlannedChange,
    change: (
      tx: DbTransaction,
      row: ActivityRow,
      scope: TxScope,
      key: SubjectKey,
    ) => Promise<ActivityRow>,
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
      const key = subjectKeyOf(row);
      if (key === undefined) throw activityNotFound();
      // The same rule the list reports as the row's `can` flags. Out of scope answers exactly like an unknown id,
      // so a guessed activity id learns nothing.
      const ref = needsSubjectRef(principal, row, key, what)
        ? (
            await loadSubjectRefs(
              tx,
              scope,
              principal,
              [{ key, id: row[key]! }],
              row.assigneeUserId === principal.userId,
            )
          ).get(refKey(key, row[key]!))
        : undefined;
      const decision = plannedChangeDecision(principal, row, key, ref, what);
      if (!decision.ok) {
        switch (decision.refusal) {
          case 'not_found':
            throw activityNotFound();
          case 'forbidden':
            throw new ForbiddenException({
              code: 'forbidden',
              message: 'Forbidden',
              reason: decision.reason,
            });
          case 'system':
            throw new ConflictException({
              code: 'conflict',
              message: 'This activity was written by the system and cannot be changed',
            });
          case 'not_planned':
            throw new ConflictException({
              code: 'conflict',
              message:
                'Only a planned activity can be changed; this one is already done or cancelled',
            });
        }
      }
      const changed = await change(tx, row, scope, key);
      return toActivityDto(changed, await activityNames(tx, scope.tenantId, [changed]));
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
   * Returns the subject's ref (owner and department; on a read also its creator and assignees, so the check
   * agrees with the subject's list). `notFound` is the 404 to answer with: a route keyed by an activity id answers
   * as if the activity itself were unknown.
   */
  private async assertSubject(
    q: Q,
    key: SubjectKey,
    id: string,
    mode: 'read' | 'write',
    notFound: () => NotFoundException = subjectNotFound,
    lockOwned = false,
  ): Promise<ResourceRef> {
    const { scope, principal } = this.caller.current();
    const ref = await this.refOf(q, key, id, scope, principal, mode === 'read', lockOwned);
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

  /**
   * The ResourceRef of the subject, undefined when it is not in this entity (tenant, for a customer). With
   * `readers`, a lead, opportunity or quotation ref also names its creator and assignees (record-reach.ts): only a
   * read permission looks at them, so a write check skips the query. `lockOwned` reads a lead or opportunity FOR
   * SHARE until the transaction ends: a follow-up planned on it then waits out an owner change in flight (which locks
   * the row FOR UPDATE and moves the old owner's follow-ups: leads.service.ts, opportunity-owner-change.service.ts)
   * and goes to the new owner, instead of landing on the old one unmoved.
   */
  private async refOf(
    q: Q,
    key: SubjectKey,
    id: string,
    scope: TxScope,
    principal: Principal,
    readers: boolean,
    lockOwned = false,
  ): Promise<ResourceRef | undefined> {
    switch (key) {
      case 'leadId': {
        const select = q
          .select()
          .from(leads)
          .where(scoped(scope).where(leads, eq(leads.id, id)));
        const [row] = lockOwned ? await select.for('share') : await select;
        if (row === undefined) return undefined;
        return leadRef(row, readers ? await loadRecordReaders(q, scope, leads, id) : undefined);
      }
      case 'opportunityId': {
        const select = q
          .select()
          .from(opportunities)
          .where(scoped(scope).where(opportunities, eq(opportunities.id, id)));
        const [row] = lockOwned ? await select.for('share') : await select;
        if (row === undefined) return undefined;
        return opportunityRef(
          row,
          readers ? await loadRecordReaders(q, scope, opportunities, id) : undefined,
        );
      }
      case 'quotationId': {
        const [row] = await q
          .select()
          .from(quotations)
          .where(scoped(scope).where(quotations, eq(quotations.id, id)));
        if (row === undefined) return undefined;
        return {
          tenantId: row.tenantId,
          organizationId: row.organizationId,
          ownerUserId: row.ownerUserId,
          // Stamped from the opportunity (migration 0088), so a department grant reaches the quotation.
          departmentId: row.departmentId,
          customerPartyId: row.customerPartyId,
          ...(readers ? await loadRecordReaders(q, scope, quotations, id) : {}),
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
   * The unfiltered list: every activity but a collection call by its subject (readableSubjects), and the collection
   * calls only for an `ar.read` holder, whatever their reach on the customer, assignee included.
   */
  private readableActivities(p: Principal, scope: TxScope): SQL {
    const notCollection = and(ne(activities.kind, COLLECTION_CALL_KIND), this.readableSubjects(p))!;
    return mayReadCollectionCalls(p, scope)
      ? or(eq(activities.kind, COLLECTION_CALL_KIND), notCollection)!
      : notCollection;
  }

  /**
   * The unfiltered list: an activity is readable when its subject is one the caller may read, or when it is
   * assigned to the caller (their own follow-ups always list, even on a customer they cannot read any more). Each
   * subject branch reuses the subject's own scope SQL (scopeWhereFor), so the list and the subject's page agree,
   * assigned reach included. Customers are tenant-level, so they get the same rule customers use: `all` is the
   * tenant, `own` the owner column.
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
      eq(activities.assigneeUserId, p.userId),
      inArray(activities.leadId, ids(leads, 'crm.lead.read')),
      inArray(activities.opportunityId, ids(opportunities, 'crm.opportunity.read')),
      inArray(activities.quotationId, ids(quotations, 'quotation.read')),
      inArray(activities.customerId, visibleCustomers),
      inArray(activities.contactId, contactsOfVisible),
    )!;
  }

  /**
   * A named assignee, else a 400 carrying the reason as `details.assignmentReason` (lead-assignee.ts):
   * - on a lead, opportunity or quotation, the hand-over the leads module checks for an owner: an active staff member
   *   of the acting entity whom the area's assignment rule (the entity's stored settings, D50/U20b; quotations follow
   *   their opportunity) lets the caller hand work to, and whose live grants hold the subject's read permission at
   *   some scope, which the assignment then extends to this record (#21);
   * - on a customer or contact, any active staff member of the acting entity, as before: no rule governs who may
   *   be handed work on a customer.
   */
  private async assertAssignee(
    tx: DbTransaction,
    scope: TxScope,
    key: SubjectKey,
    userId: string,
  ): Promise<void> {
    const area = RULE_AREA[key];
    if (area !== undefined) {
      await assertAssignable(tx, this.caller.current().principal, scope, userId, 'assigneeUserId', {
        roleCache: this.roleCache,
        context: 'reassign',
        rule: storedAssignmentRule(tx, scope, area),
        subjectRead: SUBJECT_PERMISSION[key].read,
      });
      return;
    }
    const [target] = await loadAssignmentParties(tx, scope, [userId]);
    if (target === undefined) throw assignmentRefused('assigneeUserId', 'not_active_staff');
  }

  /**
   * A collection call's new assignee: active staff of the entity whose live grants record payments, else a 400
   * (`cannot_read_subject`), so the call never lands with someone who may not finish it.
   */
  private async assertCollector(tx: DbTransaction, scope: TxScope, userId: string): Promise<void> {
    const [target] = await loadAssignmentParties(tx, scope, [userId]);
    if (target === undefined) throw assignmentRefused('assigneeUserId', 'not_active_staff');
    // Both grants: the assignment notice names the invoice, so a user who cannot read receivables gets neither
    // the call nor the notice.
    if (
      !(await partyHolds(this.roleCache, scope, target, COLLECTION_CALL_CHANGE)) ||
      !(await partyHolds(this.roleCache, scope, target, COLLECTION_CALL_READ))
    ) {
      throw assignmentRefused('assigneeUserId', 'cannot_read_subject');
    }
  }

  /**
   * `crm.assigned` (#22) to the follow-up's assignee: the bell row and the email, inside the caller's transaction,
   * so a rolled-back assignment notifies nobody. Keyed by the row version, so a later hand-back is a new notice and
   * a retried request is not.
   */
  private async notifyAssigned(
    tx: DbTransaction,
    key: SubjectKey,
    row: ActivityRow,
    by: Principal,
  ): Promise<void> {
    await notifyFollowUpAssigned(tx, this.notify, row, assignedLink(key, row[key]!), by);
  }
}
