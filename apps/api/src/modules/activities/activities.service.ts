// ActivitiesService: the calls, meetings, emails, notes and tasks logged against a lead, opportunity, customer,
// contact or quotation. Serves the NFRs:
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
  type CreateActivityBody,
  type Permission,
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
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, inArray, or, type SQL } from 'drizzle-orm';

import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService, scopeWhereFor } from '../../platform/authz/authz.service';
import { type Principal, type ResourceRef } from '../../platform/authz/can';
import { DB, type Db } from '../../platform/db/db.module';
import { withIdempotency } from '../../platform/db/idempotency';
import { withTx, type DbTransaction } from '../../platform/db/tx';
import { searchPage } from '../../platform/list';
import { customerRef } from '../customers/customers.service';
import { leadRef } from '../leads/leads.service';
import { opportunityRef } from '../opportunities/opportunities.service';
import { ActivitiesCaller } from './activities.caller';
import {
  SUBJECT_PERMISSION,
  toActivityDto,
  type ListActivitiesQuery,
  type SubjectKey,
} from './activities.types';

type Q = Db | DbTransaction;

const subjectNotFound = () =>
  new NotFoundException({ code: 'not_found', message: 'Subject not found' });

@Injectable()
export class ActivitiesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly caller: ActivitiesCaller,
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
    } else {
      filters.push(this.readableSubjects(principal));
    }
    if (q.kind !== undefined && q.kind.length > 0) filters.push(inArray(activities.kind, q.kind));
    const { rows, total } = await searchPage(this.db, {
      q: q.q,
      columns: [activities.subject, activities.body],
      where: scoped(scope).where(activities, and(...filters)),
      orderBy: [desc(activities.occurredAt), desc(activities.id)],
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
    return { items: rows.map(toActivityDto), total };
  }

  // ------------------------------------------------------------------------------------------------- create

  /** The Idempotency-Key is optional: the workspace form does not send one. */
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
        await this.assertSubject(tx, key, subjectId, 'write');
        if (body.assigneeUserId !== undefined) {
          await this.assertUser(tx, scope.tenantId, body.assigneeUserId);
        }
        const [row] = await tx
          .insert(activities)
          .values({
            ...scope,
            kind: body.kind,
            subject: body.subject,
            body: body.body ?? null,
            [key]: subjectId,
            dueAt: body.dueAt === undefined ? null : new Date(body.dueAt),
            assigneeUserId: body.assigneeUserId ?? null,
            ...(body.occurredAt === undefined ? {} : { occurredAt: new Date(body.occurredAt) }),
          })
          .returning();
        await this.audit.record(tx, {
          action: 'activity.created',
          entityType: 'activities',
          entityId: row!.id,
          after: { kind: body.kind, [key]: subjectId },
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
   */
  private async assertSubject(
    q: Q,
    key: SubjectKey,
    id: string,
    mode: 'read' | 'write',
  ): Promise<void> {
    const { scope, principal } = this.caller.current();
    const ref = await this.refOf(q, key, id, scope, principal);
    if (ref === undefined) throw subjectNotFound();
    const action: Permission = SUBJECT_PERMISSION[key][mode];
    try {
      this.authz.assert(action, ref);
    } catch (error) {
      const reason =
        error instanceof ForbiddenException
          ? (error.getResponse() as { reason?: unknown }).reason
          : undefined;
      if (reason === 'out_of_scope') throw subjectNotFound();
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
