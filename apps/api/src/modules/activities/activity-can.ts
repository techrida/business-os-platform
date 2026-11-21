// Who may complete, reschedule or cancel a planned activity: one rule for the write routes (they throw from its
// answer) and for the list (it reports the answer as the row's `can` flags), so the two cannot drift.
import { ACTIVITY_SUBJECT_KEYS, type ActivityCan, type Permission } from '@bos/contracts';
import { customerContacts, customers, leads, opportunities, quotations } from '@bos/db';
import { and, eq, inArray } from 'drizzle-orm';

import { can, type DenyReason, type Principal, type ResourceRef } from '../../platform/authz/can';
import { loadReaders, type RecordReaders } from '../../platform/authz/record-reach';
import type { Db, DbTransaction } from '../../platform/db/db.module';
import type { TxScope } from '../../platform/db/tx';
import { customerRef } from '../customers/customers.service';
import { leadRef } from '../leads/leads.service';
import { opportunityRef } from '../opportunities/opportunities.service';
import {
  COLLECTION_CALL_CHANGE,
  COLLECTION_CALL_KIND,
  COLLECTION_CALL_READ,
  isPlannedRow,
  SUBJECT_PERMISSION,
  type ActivityRow,
  type SubjectKey,
} from './activities.types';

/** The changes to a planned activity. Only `complete` is open to an assignee who can merely read the subject. */
export type PlannedChange = 'complete' | 'reschedule' | 'cancel';

/** The subjects without assigned reach: customers are tenant master data, read `all` or `own` (D55-6). */
export const CUSTOMER_KEYS: ReadonlySet<SubjectKey> = new Set<SubjectKey>([
  'customerId',
  'contactId',
]);

/** The acting entity as a ResourceRef: a collection call belongs to the entity's receivables, not to a record. */
const entityRef = (where: { tenantId: string; organizationId: string }): ResourceRef => ({
  tenantId: where.tenantId,
  organizationId: where.organizationId,
});

/** Whether the caller may read this entity's collection calls (`ar.read`, as the receivables aging). */
export const mayReadCollectionCalls = (
  p: Principal,
  where: { tenantId: string; organizationId: string },
): boolean => can(p, COLLECTION_CALL_READ, entityRef(where)).allowed;

/** Kinds only the server writes: they record what happened and are never planned, done or called off by hand. */
export const SYSTEM_KINDS: ReadonlySet<ActivityRow['kind']> = new Set(['system', 'stage_change']);

/**
 * The answer for one change. `not_found` is a 404 (out of scope answers like an unknown id), `forbidden` a 403 with
 * the deny reason, `system` and `not_planned` a 409. Authorization is decided before the 409s, so a caller out of
 * scope never learns the row's state.
 */
export type PlannedChangeDecision =
  | { ok: true }
  | { ok: false; refusal: 'not_found' }
  | { ok: false; refusal: 'forbidden'; reason: DenyReason }
  | { ok: false; refusal: 'system' | 'not_planned' };

const OK: PlannedChangeDecision = { ok: true };
const NOT_FOUND: PlannedChangeDecision = { ok: false, refusal: 'not_found' };
const forbidden = (reason: DenyReason): PlannedChangeDecision => ({
  ok: false,
  refusal: 'forbidden',
  reason,
});

/** The subject check: no ref or out of scope is a 404, any other denial a 403. */
function onSubject(
  p: Principal,
  action: Permission,
  ref: ResourceRef | undefined,
): PlannedChangeDecision {
  if (ref === undefined) return NOT_FOUND;
  const d = can(p, action, ref);
  if (d.allowed) return OK;
  return d.reason === 'out_of_scope' ? NOT_FOUND : forbidden(d.reason);
}

/** Whether the assignee completes a follow-up on a customer or contact, which needs only the read grant (U20a2-Q7). */
const assigneeCompletesOnCustomer = (
  p: Principal,
  row: Pick<ActivityRow, 'assigneeUserId'>,
  key: SubjectKey,
  what: PlannedChange,
): boolean => row.assigneeUserId === p.userId && what === 'complete' && CUSTOMER_KEYS.has(key);

/**
 * Whether `ref` must be loaded to decide `what` on this row: a collection call (decided on the entity) and the
 * assignee completing on a customer need none.
 */
export function needsSubjectRef(
  p: Principal,
  row: Pick<ActivityRow, 'assigneeUserId' | 'kind'>,
  key: SubjectKey,
  what: PlannedChange,
): boolean {
  return row.kind !== COLLECTION_CALL_KIND && !assigneeCompletesOnCustomer(p, row, key, what);
}

/**
 * A collection call (R4c1 Q1) takes no permission from its customer: no `ar.read` is a 404 like any unreadable
 * row, reading without `payment.record` (Management) a 403. The assignee gets no shortcut.
 */
function onCollectionCall(
  p: Principal,
  row: Pick<ActivityRow, 'tenantId' | 'organizationId'>,
): PlannedChangeDecision {
  if (!mayReadCollectionCalls(p, row)) return NOT_FOUND;
  const d = can(p, COLLECTION_CALL_CHANGE, entityRef(row));
  return d.allowed ? OK : forbidden(d.reason);
}

/**
 * The caller must hold the write permission of the subject, else 404. The assignee is the exception (K5): their
 * follow-up is theirs to do, so they may complete it on a subject they can only read (assigned reach).
 * Rescheduling or calling it off still needs the subject's write permission, and they get a 403 for it rather
 * than a 404: the follow-up is on their own list, so it is no secret. On a customer or contact, which has no
 * assigned reach, the assignee completes it with the customer read grant at any scope (U20a2-Q7). `ref` is the
 * subject's ref, with its readers when the caller is the assignee. A collection call follows `onCollectionCall`
 * instead, and needs no ref.
 */
export function plannedChangeDecision(
  p: Principal,
  row: Pick<
    ActivityRow,
    | 'tenantId'
    | 'organizationId'
    | 'assigneeUserId'
    | 'kind'
    | 'dueAt'
    | 'completedAt'
    | 'cancelledAt'
  >,
  key: SubjectKey,
  ref: ResourceRef | undefined,
  what: PlannedChange,
): PlannedChangeDecision {
  const perm = SUBJECT_PERMISSION[key];
  if (row.kind === COLLECTION_CALL_KIND) {
    const call = onCollectionCall(p, row);
    if (!call.ok) return call;
  } else if (assigneeCompletesOnCustomer(p, row, key, what)) {
    const d = can(p, perm.read);
    if (!d.allowed) return forbidden(d.reason);
  } else if (row.assigneeUserId === p.userId) {
    const read = onSubject(p, perm.read, ref);
    if (!read.ok) return read;
    if (what !== 'complete') {
      const d = can(p, perm.write, ref);
      if (!d.allowed) return forbidden(d.reason);
    }
  } else {
    const write = onSubject(p, perm.write, ref);
    if (!write.ok) return write;
  }
  if (SYSTEM_KINDS.has(row.kind)) return { ok: false, refusal: 'system' };
  if (!isPlannedRow(row)) return { ok: false, refusal: 'not_planned' };
  return OK;
}

const NONE: ActivityCan = Object.freeze({ complete: false, reschedule: false, cancel: false });

/** The subject an activity hangs off, or undefined for a row with none (the CHECK forbids it). */
export function subjectKeyOf(row: ActivityRow): SubjectKey | undefined {
  return ACTIVITY_SUBJECT_KEYS.find((k) => row[k] !== null);
}

/** Whether a row can have any action at all: planned and not written by the system. Others need no ref. */
export const mayHaveActions = (row: ActivityRow): boolean =>
  !SYSTEM_KINDS.has(row.kind) && isPlannedRow(row);

/** The row's `can` flags for the caller, from `plannedChangeDecision` with the refs `loadSubjectRefs` returned. */
export function activityCan(
  p: Principal,
  row: ActivityRow,
  refs: ReadonlyMap<string, ResourceRef>,
): ActivityCan {
  const key = subjectKeyOf(row);
  if (key === undefined || !mayHaveActions(row)) return NONE;
  const ref = refs.get(refKey(key, row[key]!));
  const allowed = (what: PlannedChange) => plannedChangeDecision(p, row, key, ref, what).ok;
  return {
    complete: allowed('complete'),
    reschedule: allowed('reschedule'),
    cancel: allowed('cancel'),
  };
}

export const refKey = (key: SubjectKey, id: string): string => `${key}:${id}`;

/**
 * The ResourceRef of each subject, keyed by `refKey`; a subject not in this entity (tenant, for a customer or
 * contact) is absent. With `readers`, a lead, opportunity or quotation ref also names its creator and assignees
 * (record-reach.ts), which only a read permission looks at. A few queries per subject kind, whatever the count.
 */
export async function loadSubjectRefs(
  q: Db | DbTransaction,
  scope: TxScope,
  p: Principal,
  subjects: readonly { key: SubjectKey; id: string }[],
  readers: boolean,
): Promise<Map<string, ResourceRef>> {
  const out = new Map<string, ResourceRef>();
  const ids = (key: SubjectKey) => [
    ...new Set(subjects.filter((s) => s.key === key).map((s) => s.id)),
  ];
  const readersOf = async (
    table: typeof leads | typeof opportunities | typeof quotations,
    list: string[],
  ): Promise<ReadonlyMap<string, RecordReaders> | undefined> =>
    readers ? loadReaders(q, scope, table, list) : undefined;
  const inEntity = <T extends typeof leads | typeof opportunities | typeof quotations>(
    table: T,
    list: string[],
  ) =>
    and(
      eq(table.tenantId, scope.tenantId),
      eq(table.organizationId, scope.organizationId),
      inArray(table.id, list),
    );

  const leadIds = ids('leadId');
  if (leadIds.length > 0) {
    const rows = await q.select().from(leads).where(inEntity(leads, leadIds));
    const r = await readersOf(leads, leadIds);
    for (const row of rows) out.set(refKey('leadId', row.id), leadRef(row, r?.get(row.id)));
  }
  const opportunityIds = ids('opportunityId');
  if (opportunityIds.length > 0) {
    const rows = await q
      .select()
      .from(opportunities)
      .where(inEntity(opportunities, opportunityIds));
    const r = await readersOf(opportunities, opportunityIds);
    for (const row of rows) {
      out.set(refKey('opportunityId', row.id), opportunityRef(row, r?.get(row.id)));
    }
  }
  const quotationIds = ids('quotationId');
  if (quotationIds.length > 0) {
    const rows = await q.select().from(quotations).where(inEntity(quotations, quotationIds));
    const r = await readersOf(quotations, quotationIds);
    for (const row of rows) {
      const who = r?.get(row.id);
      out.set(refKey('quotationId', row.id), {
        tenantId: row.tenantId,
        organizationId: row.organizationId,
        ownerUserId: row.ownerUserId,
        // Stamped from the opportunity (migration 0088), so a department grant reaches the quotation.
        departmentId: row.departmentId,
        customerPartyId: row.customerPartyId,
        ...(who === undefined
          ? {}
          : { creatorUserId: who.creatorUserId, assigneeUserIds: who.assigneeUserIds }),
      });
    }
  }

  // Customers are tenant-level; a contact takes its customer's ref.
  const contactIds = ids('contactId');
  const contactCustomer = new Map<string, string>();
  if (contactIds.length > 0) {
    const rows = await q
      .select({ id: customerContacts.id, customerId: customerContacts.customerId })
      .from(customerContacts)
      .where(
        and(
          eq(customerContacts.tenantId, scope.tenantId),
          inArray(customerContacts.id, contactIds),
        ),
      );
    for (const row of rows) contactCustomer.set(row.id, row.customerId);
  }
  const customerIds = [...new Set([...ids('customerId'), ...contactCustomer.values()])];
  if (customerIds.length > 0) {
    const rows = await q
      .select()
      .from(customers)
      .where(and(eq(customers.tenantId, scope.tenantId), inArray(customers.id, customerIds)));
    const byId = new Map(rows.map((row) => [row.id, customerRef(row, p)]));
    for (const id of ids('customerId')) {
      const ref = byId.get(id);
      if (ref !== undefined) out.set(refKey('customerId', id), ref);
    }
    for (const [contactId, customerId] of contactCustomer) {
      const ref = byId.get(customerId);
      if (ref !== undefined) out.set(refKey('contactId', contactId), ref);
    }
  }
  return out;
}
