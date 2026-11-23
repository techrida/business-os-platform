// LeadsService: reads, create, edits and stage changes of leads, and who a lead can be handed to. Serves the NFRs:
// - "the pipeline is auditable": every row change is audited by the database trigger, and a stage change also
//   writes a domain event (with the reason and note) and a stage_change activity on the lead;
// - "no lost updates": a stage change names the version the caller saw; the row is locked, and a stale version
//   is a 409;
// - "no gaps in a numbered series": the LD number is taken inside the create transaction, from the acting entity's
//   series (a lead is entity-owned, so unlike a customer there is no default-entity switch);
// - "authorization is deny-by-default": a record outside the caller's entity or scope is a 404, never a 403.
// Who may own a lead, and who the owner select offers, is the D50 assignment rule (lead-assignee.ts) under the
// entity's stored rule, never a role default: the same check backs create, edit and the pickers.
// Converted is never set here: it belongs to the convert action (a later unit).
import {
  type AssignmentContext,
  CONTACT_ACTIVITY_KINDS,
  type ContactActivityKind,
  type CreateLeadBody,
  LEAD_STAGES,
  type LeadDto,
  type LeadLostReasonRef,
  type LeadOwnerOption,
  type LeadStage,
  type LeadStageChangeBody,
  type Permission,
  type SchedulableActivityKind,
  type UpdateLeadBody,
} from '@bos/contracts';
import { activities, leads, scoped, users } from '@bos/db';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  and,
  count,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  type SQL,
} from 'drizzle-orm';

import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService, scopeWhereFor } from '../../platform/authz/authz.service';
import { can, type Principal } from '../../platform/authz/can';
import { loadRecordReaders, type RecordReaders } from '../../platform/authz/record-reach';
import { RoleCache } from '../../platform/authz/role-cache';
import { DB, type Db } from '../../platform/db/db.module';
import { updateVersioned, withIdempotency } from '../../platform/db/idempotency';
import { withTx, type DbTransaction, type TxScope, READ_ONLY } from '../../platform/db/tx';
import { NotifyService } from '../../platform/notify/notify.service';
import { CurrencyEnabledService } from '../../platform/settings/currency-enabled';
import { searchPage } from '../../platform/list';
import { NumberingService } from '../../platform/settings/numbering.service';
import { readSetting } from '../../platform/settings/settings.service';
import { nameIn, personNameMap, personNames } from '../../platform/users/person-names';
import { nextFollowUpSql } from '../activities/activities.types';
import { moveOpenFollowUps, notifyFollowUpAssigned } from '../activities/follow-ups';
import {
  actorParty,
  type AssignmentCandidate,
  type AssignmentCheck,
  assertAssignable,
  assignableParties,
  assignmentRefused,
  storedAssignmentRule,
} from './lead-assignee';
import { decideAssignment, defaultSalesOwner } from './lead-assignment-rule';
import {
  loadLeadPhones,
  loadPhonesOfLead,
  phonesSearchText,
  replaceLeadPhones,
  sameLeadPhones,
} from './lead-phones';
import { assertLinkableCustomer } from './lead-customer-link';
import { LeadsCaller } from './leads.caller';
import { LeadLostReasonsService, lostReasonRefs } from './lost-reasons.service';
import {
  addressChange,
  addressColumnsOf,
  changedLeadFields,
  type LeadRow,
  type LeadSummary,
  type LeadSummaryQuery,
  type ListLeadsQuery,
  toLeadDto,
} from './leads.types';
import {
  leadRef,
  mayReopenLead,
  planLeadStageChange,
  type LeadStageCaller,
  type LeadStageRefusal,
} from './lead-stage';

export { allowedLeadMoves, isStageManager, leadRef } from './lead-stage';

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

const notFound = () => new NotFoundException({ code: 'not_found', message: 'Lead not found' });

/** The name a person is shown by in a picker or a notice (D54-2): their display name, never part of an address. */
const shownName = (displayName: string | null): string => displayName?.trim() || 'Unnamed user';

/** Picker order: by name, then id, so two people of one name keep a stable order. */
const byName = (a: LeadOwnerOption, b: LeadOwnerOption): number =>
  a.displayName.localeCompare(b.displayName) || a.userId.localeCompare(b.userId);

/**
 * Searchable text of a lead: what the table shows plus what a salesperson types from an inbound email or call. Every
 * number of the lead is in `phones_search` (lead-phones.ts), so a call from its second number finds it too.
 */
const SEARCH_COLUMNS = [
  leads.title,
  leads.number,
  leads.companyName,
  leads.contactName,
  leads.emailNorm,
  leads.phonesSearch,
  leads.campaign,
];

/** The 400 an edit gets when it would leave the lead with no way to reach the person. */
const CONTACT_WAY_MESSAGE = 'A lead needs an email or at least one phone number';

/** FR-6 (D48): the 409 a move to contacted gets when the lead has no contact yet and the request logs none. */
export const CONTACT_REQUIRED_MESSAGE =
  'Log a call, email or meeting before moving this lead to Contacted.';

/** The subject a contact logged with a move to contacted gets when the caller types none. */
const INITIAL_CONTACT_SUBJECT: Record<ContactActivityKind, string> = {
  call: 'Initial call',
  email: 'Initial email',
  meeting: 'Initial meeting',
};

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
    private readonly currencies: CurrencyEnabledService,
    private readonly lostReasons: LeadLostReasonsService,
    private readonly roleCache: RoleCache,
    private readonly notify: NotifyService,
  ) {}

  // -------------------------------------------------------------------------------------------------- read

  async list(q: ListLeadsQuery): Promise<{ rows: LeadDto[]; total: number }> {
    const { scope, principal } = this.caller.current();
    const where = this.listWhere(q, q.stage);
    const { rows, total } = await searchPage(this.db, {
      q: q.q,
      columns: SEARCH_COLUMNS,
      where: scoped(scope).where(leads, where),
      orderBy: [desc(leads.createdAt), desc(leads.id)],
      limit: q.limit,
      offset: q.offset,
      // `nextFollowUp` is a correlated subquery on each lead row, so it can also be a sort key (nulls last) or a
      // filter (isNotNull(nextFollowUpSql())). The planned-per-lead partial index of migration 0062 serves it.
      rows: (tx, p) =>
        tx
          .select(leadWithNextFollowUp())
          .from(leads)
          .where(p.where)
          .orderBy(...p.orderBy)
          .limit(p.limit)
          .offset(p.offset),
      count: (tx, w) => tx.$count(leads, w),
    });
    const names = await personNameMap(
      this.db,
      scope.tenantId,
      rows.map((r) => r.ownerUserId),
    );
    const refs = await lostReasonRefs(
      this.db,
      scope.tenantId,
      rows.map((r) => r.lostReasonId),
    );
    const phones = await loadLeadPhones(
      this.db,
      scope,
      rows.map((r) => r.id),
    );
    return {
      rows: rows.map(({ nextFollowUp, ...row }) =>
        toLeadDto(
          row,
          nextFollowUp,
          nameIn(names, row.ownerUserId),
          refs.get(row.lostReasonId ?? '') ?? null,
          phones.get(row.id) ?? [],
          principal,
        ),
      ),
      total,
    };
  }

  /**
   * Leads per stage under the list's scope, search and filters except `stage`. Its search decision ignores the stage
   * too, so in fuzzy mode (few exact hits) a card can differ from the list's total for the same stage filter.
   */
  async summary(q: LeadSummaryQuery): Promise<LeadSummary> {
    const { scope } = this.caller.current();
    const { rows, total } = await searchPage(this.db, {
      q: q.q,
      columns: SEARCH_COLUMNS,
      where: scoped(scope).where(leads, this.listWhere(q, undefined)),
      orderBy: [desc(leads.id)],
      // One grouped row per stage; the page window does not apply.
      limit: 1,
      offset: 0,
      rows: (tx, p) =>
        tx
          .select({ stage: leads.stage, n: count() })
          .from(leads)
          .where(p.where)
          .groupBy(leads.stage),
      count: (tx, w) => tx.$count(leads, w),
    });
    const byStage = Object.fromEntries(LEAD_STAGES.map((s) => [s, 0])) as LeadSummary['byStage'];
    for (const r of rows) byStage[r.stage] = r.n;
    return { total, byStage };
  }

  async get(id: string): Promise<LeadDto> {
    const { scope, principal } = this.caller.current();
    const [found] = await this.db
      .select(leadWithNextFollowUp())
      .from(leads)
      .where(scoped(scope).where(leads, eq(leads.id, id)));
    if (found === undefined) throw notFound();
    const { nextFollowUp, ...row } = found;
    // The creator and the follow-up assignees read the lead too (D50, D55-5), as the list query lets them.
    this.assertVisible(
      'crm.lead.read',
      row,
      await loadRecordReaders(this.db, scope, leads, row.id),
    );
    return toLeadDto(
      row,
      nextFollowUp,
      await this.ownerNameOf(this.db, row),
      await this.lostReasonOf(this.db, row),
      await loadPhonesOfLead(this.db, scope, row.id),
      principal,
    );
  }

  // ------------------------------------------------------------------------------------------------- create

  /**
   * Who may start a lead is the route's `crm.lead.write`; who owns it is the assignment rule (context `create`).
   * Without a named owner it is the caller when the rule lets them keep it; Finance, Accountant and PMO start leads
   * for Sales (D50), so for them it is the Sales head (`defaultSalesOwner` over the people they may pick), and with
   * no such head a 400 `sales_owner_required`. A named owner, and a named follow-up assignee, must pass the same rule
   * and be able to read the lead (lead-assignee.ts, 400 with `details.assignmentReason`). The caller is recorded as
   * the lead's creator (D55-2), which keeps it readable to them under an `own` read grant. A lead owned by someone
   * else tells that owner (`crm.assigned`, #22). The Idempotency-Key is optional: the workspace form does not send
   * one.
   *
   * `followUp` (or the old `nextFollowUpAt`, a call named "Follow up") plans the first follow-up as a planned
   * activity in the same transaction (D39): assigned to the owner unless named, named after its kind unless given a
   * subject. The `leads.next_follow_up_at` column is no longer written.
   *
   * The currency must be switched on for the company (D44, 422 CURRENCY_NOT_ENABLED), checked before the LD number
   * is taken so a refusal uses up no number.
   */
  async create(body: CreateLeadBody, idempotencyKey?: string): Promise<LeadDto> {
    const { scope, actor, principal } = this.caller.current();
    this.authz.assert('crm.lead.write');
    const followUp =
      body.followUp ??
      (body.nextFollowUpAt === undefined
        ? undefined
        : { kind: 'call' as const, dueAt: body.nextFollowUpAt, subject: 'Follow up' });
    const now = new Date();
    // Set inside the transaction, read after it: a property, so the compiler does not narrow it to `false`.
    const sent = { notice: false };
    const created = await withTx(this.db, scope, actor, async (tx) => {
      const run = async (): Promise<LeadDto> => {
        const check = this.assignmentCheck(tx, scope, 'create');
        const ownerUserId = await this.ownerForCreate(
          tx,
          scope,
          principal,
          body.ownerUserId,
          check,
        );
        const assigneeUserId = followUp?.assigneeUserId ?? ownerUserId;
        if (followUp?.assigneeUserId !== undefined) {
          await assertAssignable(
            tx,
            principal,
            scope,
            followUp.assigneeUserId,
            'followUp.assigneeUserId',
            check,
          );
        }
        await this.currencies.assertEnabled(scope, body.currency);
        // R6O: a picked customer is linked; checked before the LD number is taken so a refusal uses up none.
        if (body.customerId !== undefined) {
          await assertLinkableCustomer(tx, scope, principal, body.customerId, body.contactId);
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
            customerId: body.customerId ?? null,
            contactId: body.contactId ?? null,
            country: body.country,
            ...addressColumnsOf(body.address),
            emailNorm: body.email === undefined ? null : body.email.trim().toLowerCase(),
            phonesSearch: phonesSearchText(body.phones),
            requirement: body.requirement ?? null,
            expectedValue: body.expectedValue ?? null,
            currency: body.currency,
            probability: body.probability ?? null,
            expectedClose: body.expectedClose ?? null,
            notes: body.notes ?? null,
            stage: 'new',
            createdByUserId: principal.userId,
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
        await replaceLeadPhones(tx, { ...scope, leadId: row!.id, phones: body.phones });
        // Read back, so every response maps the numbers the same way (primary first, label null when unset).
        const phones = await loadPhonesOfLead(tx, scope, row!.id);
        if (ownerUserId !== principal.userId) {
          await this.notifyAssigned(tx, principal, row!);
          sent.notice = true;
        }
        const ownerName = await this.ownerNameOf(tx, row!);
        if (followUp === undefined)
          return toLeadDto(row!, null, ownerName, null, phones, principal);
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
          .returning();
        await this.audit.record(tx, {
          action: 'activity.scheduled',
          entityType: 'activities',
          entityId: planned!.id,
          after: { kind: followUp.kind, leadId: row!.id, dueAt: followUp.dueAt, assigneeUserId },
        });
        // U20a2-Q8: a first follow-up handed to someone else tells them (#22), unless they are the owner, whom the
        // lead's own notice above already told.
        if (assigneeUserId !== principal.userId && assigneeUserId !== ownerUserId) {
          await notifyFollowUpAssigned(tx, this.notify, planned!, `/leads/${row!.id}`, principal);
          sent.notice = true;
        }
        // The only planned activity of a new lead, so it is the next follow-up.
        return toLeadDto(row!, dueAt, ownerName, null, phones, principal);
      };
      if (idempotencyKey === undefined) return run();
      const done = await withIdempotency(
        tx,
        { command: 'lead.create', key: idempotencyKey, body },
        async () => ({ status: 201, response: await run() }),
      );
      return done.response;
    });
    // After the commit, never inside it (NotifyService header): the drainer must find the outbox row.
    if (sent.notice) await this.notify.nudge();
    return created;
  }

  // ------------------------------------------------------------------------------------------ stage change

  /**
   * A user's move along LEAD_TRANSITIONS. Converted is refused (the schema already keeps it out of the body, and
   * the planner refuses it for a caller that skips the controller). A manager, head or founder with write scope
   * may also take the manager edge (reopening a lost lead). Any move to contacted needs a contact
   * (FR-6, D48): a call, email or meeting logged atomically in the same request, or one already done on the lead;
   * otherwise 409 `contact_activity_required`.
   */
  async changeStage(id: string, body: LeadStageChangeBody): Promise<LeadDto> {
    const { scope, actor, principal } = this.caller.current();
    return withTx(this.db, scope, actor, async (tx) => {
      const row = await this.lock(tx, scope, id);
      // Scope first (404), then state (409): someone who may not edit learns nothing about the stage.
      this.assertVisible('crm.lead.write', row);
      // The reopen edge needs the live crm.lead.reopen grant on this lead's department as well as the level.
      const by: LeadStageCaller = mayReopenLead(principal, row) ? 'manager' : 'user';

      // Lost carries an option of the tenant's list (D49), or a new one added in this same step. The planner still
      // sees a `reason`: the option's words, which the lead keeps as a snapshot beside the reference.
      let reason = body.reason;
      let lostReasonId: string | null = null;
      const planProbe = planLeadStageChange({
        current: row.stage,
        currentVersion: row.version,
        to: body.stage,
        by,
        reason: body.stage === 'lost' ? 'probe' : body.reason,
        note: body.note,
        expectedVersion: body.expectedVersion,
        heldFromStage: row.heldFromStage,
      });
      if (!planProbe.ok) throw refusalToException(planProbe.kind, planProbe.message);
      if (body.stage === 'lost') {
        const chosen = await this.lostReasons.choose(tx, scope.tenantId, body);
        reason = chosen.label;
        lostReasonId = chosen.id;
      }
      const plan = planLeadStageChange({
        current: row.stage,
        currentVersion: row.version,
        to: body.stage,
        by,
        reason,
        note: body.note,
        expectedVersion: body.expectedVersion,
        heldFromStage: row.heldFromStage,
      });
      if (!plan.ok) throw refusalToException(plan.kind, plan.message);

      if (body.contactActivity !== undefined && body.stage !== 'contacted') {
        throw new BadRequestException({
          code: 'bad_request',
          message: 'A contact activity can only be logged when moving a lead to contacted',
        });
      }
      // FR-6 (D48): every move to contacted (from new, a resume from on_hold, a manager's reopen of a lost lead) needs
      // a contact: logged in this request, or already done on the lead. Read after the row lock, so two racing moves
      // see the same answer and the version check lets only one through.
      if (
        body.stage === 'contacted' &&
        body.contactActivity === undefined &&
        !(await this.hasDoneContact(tx, id))
      ) {
        throw new ConflictException({
          code: 'contact_activity_required',
          message: CONTACT_REQUIRED_MESSAGE,
        });
      }

      const now = new Date();
      // Leaving lost (or any move that is not to lost) clears the reference with the text.
      const updated = await updateVersioned(tx, leads, id, body.expectedVersion, {
        ...plan.set,
        lostReasonId,
        updatedAt: now,
      });
      await this.audit.record(tx, {
        action: 'lead.stage_changed',
        entityType: AUDIT_ENTITY,
        entityId: id,
        before: { stage: row.stage, version: row.version },
        after: { stage: updated.stage, version: updated.version },
        meta: {
          reason: plan.set.stageReason,
          note: plan.set.stageNote,
          lostReasonId,
          ...(body.contactActivity !== undefined ? { loggedContact: true } : {}),
          ...(row.stage === 'on_hold' || updated.stage === 'on_hold'
            ? { heldFromStage: row.heldFromStage ?? plan.set.heldFromStage }
            : {}),
        },
      });
      if (body.contactActivity !== undefined) {
        const [actRow] = await tx
          .insert(activities)
          .values({
            ...scope,
            kind: body.contactActivity.kind,
            subject:
              body.contactActivity.subject ?? INITIAL_CONTACT_SUBJECT[body.contactActivity.kind],
            body: body.contactActivity.body,
            leadId: id,
            createdByUserId: principal.userId,
            occurredAt: now,
          })
          .returning({ id: activities.id });
        await this.audit.record(tx, {
          action: 'activity.created',
          entityType: 'activities',
          entityId: actRow!.id,
          after: { kind: body.contactActivity.kind, leadId: id },
        });
      }
      await tx.insert(activities).values({
        ...scope,
        kind: 'stage_change',
        subject: `Stage changed from ${row.stage} to ${updated.stage}`,
        body: plan.set.stageNote,
        leadId: id,
        createdByUserId: principal.userId,
        occurredAt: body.contactActivity !== undefined ? new Date(now.getTime() + 1) : now,
      });
      return toLeadDto(
        updated,
        await this.nextFollowUpOf(tx, id),
        await this.ownerNameOf(tx, updated),
        await this.lostReasonOf(tx, updated),
        await loadPhonesOfLead(tx, scope, id),
        principal,
      );
    });
  }

  // ------------------------------------------------------------------------------------------------ update

  /**
   * An edit of the lead's own fields; only the fields sent change. Checks run in this order, the first failure is
   * the answer: out of scope 404 (the caller's write grant must reach the lead: its owner, or its department for a
   * department grant), stale version 409, converted 400, nothing changed 400, then a new owner (the assignment rule,
   * context `reassign`: an active staff member of the entity whom the rule lets the caller hand work to and who can
   * read leads, else 400 with `details.assignmentReason`), then a new currency that the company has not switched on
   * (D44, 422 CURRENCY_NOT_ENABLED). Currency has no default here, so an owner-only edit keeps the lead's currency.
   * Only a changed currency is checked: a lead whose currency was switched off later can still have its other fields
   * edited.
   *
   * Only changed fields are written, so `owner_user_id` is never set to its own value and the database re-stamps the
   * lead's department only when the owner really changes (D55-4). A new owner other than the caller is told
   * (`crm.assigned`, #22) after the follow-ups moved with them (D45).
   */
  async update(id: string, body: UpdateLeadBody): Promise<LeadDto> {
    const { scope, actor, principal } = this.caller.current();
    const { expectedVersion, phones: sentPhones, address: sentAddress, ...fields } = body;
    const sent = { notice: false };
    const edited = await withTx(this.db, scope, actor, async (tx) => {
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
      const storedPhones = await loadPhonesOfLead(tx, scope, id);
      const phonesChanged =
        sentPhones !== undefined && !sameLeadPhones(storedPhones, row.phonesSearch, sentPhones);
      const address = addressChange(row, sentAddress);
      if (changes.length === 0 && !phonesChanged && address === undefined) {
        throw new BadRequestException({ code: 'bad_request', message: 'Nothing to change' });
      }
      // The email cannot be cleared by an edit, so only the stored one and the numbers after the edit decide.
      const emailAfter = fields.email ?? row.emailNorm;
      const phonesAfter = phonesChanged ? sentPhones : storedPhones;
      if (emailAfter === null && phonesAfter.length === 0) {
        throw new BadRequestException({ code: 'bad_request', message: CONTACT_WAY_MESSAGE });
      }
      const set = Object.fromEntries(changes.map((c) => [c.column, c.after])) as Partial<
        typeof leads.$inferInsert
      >;
      // Written with the versioned update, so the phones' own replace below finds the search text already in line.
      if (phonesChanged) set.phonesSearch = phonesSearchText(sentPhones);
      if (address !== undefined) Object.assign(set, address.columns);
      const newOwner = set.ownerUserId;
      if (typeof newOwner === 'string') {
        await assertAssignable(
          tx,
          principal,
          scope,
          newOwner,
          'ownerUserId',
          this.assignmentCheck(tx, scope, 'reassign'),
        );
      }
      if (changes.some((c) => c.field === 'currency')) {
        await this.currencies.assertEnabled(scope, fields.currency);
      }

      const updated = await updateVersioned(tx, leads, id, expectedVersion, {
        ...set,
        updatedAt: new Date(),
      });
      if (phonesChanged) {
        await replaceLeadPhones(tx, { ...scope, leadId: id, phones: sentPhones });
      }
      await this.audit.record(tx, {
        action: 'lead.updated',
        entityType: AUDIT_ENTITY,
        entityId: id,
        before: {
          ...Object.fromEntries(changes.map((c) => [c.field, c.before])),
          ...(phonesChanged ? { phones: storedPhones.map((p) => p.e164) } : {}),
          ...(address === undefined ? {} : { address: address.before }),
        },
        after: {
          ...Object.fromEntries(changes.map((c) => [c.field, c.after])),
          ...(phonesChanged ? { phones: sentPhones.map((p) => p.e164) } : {}),
          ...(address === undefined ? {} : { address: address.after }),
        },
      });
      if (typeof newOwner === 'string') {
        await this.audit.record(tx, {
          action: 'lead.owner_changed',
          entityType: AUDIT_ENTITY,
          entityId: id,
          before: { ownerUserId: row.ownerUserId },
          after: { ownerUserId: newOwner },
        });
        await moveOpenFollowUps(tx, scope, this.audit, {
          subject: 'leadId',
          subjectId: id,
          from: row.ownerUserId,
          to: newOwner,
          reason: 'lead_owner_changed',
        });
        if (newOwner !== principal.userId) {
          await this.notifyAssigned(tx, principal, updated);
          sent.notice = true;
        }
      }
      return toLeadDto(
        updated,
        await this.nextFollowUpOf(tx, id),
        await this.ownerNameOf(tx, updated),
        await this.lostReasonOf(tx, updated),
        phonesChanged ? await loadPhonesOfLead(tx, scope, id) : storedPhones,
        principal,
      );
    });
    if (sent.notice) await this.notify.nudge();
    return edited;
  }

  // ------------------------------------------------------------------------------------------------ owners

  /**
   * The people the caller may hand a lead to (the owner select, and the follow-up assignee select): exactly whom
   * create and PATCH accept, so the select never offers a 400. That is the assignment rule's targets under the
   * entity's stored rule (`assignableTargets`), among the active staff of the acting entity, kept only when their
   * live grants read and write leads (Management reads every lead and owns none). `create` lists whom a new lead
   * may be started for: for Finance, Accountant and PMO the Sales users, not themselves.
   */
  async owners(context: AssignmentContext = 'reassign'): Promise<LeadOwnerOption[]> {
    const { scope, actor, principal } = this.caller.current();
    return withTx(
      this.db,
      scope,
      actor,
      async (tx) => {
        const people = await assignableParties(
          tx,
          principal,
          scope,
          this.assignmentCheck(tx, scope, context),
        );
        // Only when the caller may not keep a new lead: the person an ownerless create goes to is marked, so the
        // form shows them instead of a placeholder.
        const self = actorParty(principal);
        const fallback =
          context === 'create' &&
          decideAssignment(self, self, 'create').reason === 'sales_owner_required'
            ? await this.fallbackOwner(tx, scope, people)
            : null;
        return people
          .map((c) => ({
            userId: c.userId,
            displayName: shownName(c.displayName),
            // Never sent: a picker has no use for an address, and the list reaches client-component props.
            email: '',
            avatarDocumentId: c.avatarDocumentId,
            role: c.role,
            ...(fallback?.userId === c.userId ? { defaultOwner: fallback.source } : {}),
          }))
          .sort(byName);
      },
      READ_ONLY,
    );
  }

  /**
   * The people the leads list's Owner filter offers: everyone who owns a lead the caller can read (the list's own
   * scope, so it names nobody the list would not show), plus the people the caller may hand a lead to, so a
   * salesperson can find a colleague before they own anything. Names come from the records' person names, never the
   * admin directory, and no address is sent: the filter only needs to tell people apart.
   */
  async ownerFilter(): Promise<LeadOwnerOption[]> {
    const { scope, actor, principal } = this.caller.current();
    return withTx(
      this.db,
      scope,
      actor,
      async (tx) => {
        const owned = await tx
          .selectDistinct({ userId: leads.ownerUserId })
          .from(leads)
          .where(
            scoped(scope).where(
              leads,
              and(scopeWhereFor(principal, leads, 'crm.lead.read'), isNotNull(leads.ownerUserId)),
            ),
          );
        const ids = new Set<string>();
        for (const { userId } of owned) if (userId !== null) ids.add(userId);
        if (can(principal, 'crm.lead.write').allowed) {
          const targets = await assignableParties(
            tx,
            principal,
            scope,
            this.assignmentCheck(tx, scope, 'reassign'),
          );
          for (const { userId } of targets) ids.add(userId);
        }
        const named = new Map(
          (await personNames(tx, scope.tenantId, ids)).map((p) => [p.userId, p]),
        );
        return [...ids]
          .map((userId) => ({
            userId,
            displayName: named.get(userId)?.name ?? 'Unnamed user',
            email: '',
            avatarDocumentId: named.get(userId)?.avatarDocumentId ?? null,
          }))
          .sort(byName);
      },
      READ_ONLY,
    );
  }

  // ----------------------------------------------------------------------------------------------- helpers

  /** Scope first, then the filters, which only narrow it (never widen); search is added by searchPage. */
  private listWhere(
    q: Pick<LeadSummaryQuery, 'source' | 'ownerUserId'>,
    stage: LeadStage[] | undefined,
  ): SQL | undefined {
    const { principal } = this.caller.current();
    const filters: SQL[] = [scopeWhereFor(principal, leads, 'crm.lead.read')];
    if (stage !== undefined && stage.length > 0) filters.push(inArray(leads.stage, stage));
    if (q.source !== undefined && q.source.length > 0) {
      filters.push(inArray(leads.source, q.source));
    }
    if (q.ownerUserId !== undefined && q.ownerUserId.length > 0) {
      filters.push(inArray(leads.ownerUserId, q.ownerUserId));
    }
    return and(...filters);
  }

  /**
   * How a lead's owner is checked in this transaction: the leads area's stored rule, lead read for the target, and
   * lead write for an owner (a role that never edits leads never owns one).
   */
  private assignmentCheck(
    tx: DbTransaction,
    scope: TxScope,
    context: AssignmentContext,
  ): AssignmentCheck {
    return {
      roleCache: this.roleCache,
      context,
      rule: storedAssignmentRule(tx, scope, 'leads'),
      subjectRead: 'crm.lead.read',
      ownerWrite: 'crm.lead.write',
    };
  }

  /**
   * The owner of a new lead (see `create`). The caller's own claim needs no directory read: the rule answers it
   * from the request's roles, so a salesperson's create costs nothing extra.
   */
  private async ownerForCreate(
    tx: DbTransaction,
    scope: TxScope,
    principal: Principal,
    named: string | undefined,
    check: AssignmentCheck,
  ): Promise<string> {
    if (named !== undefined) {
      await assertAssignable(tx, principal, scope, named, 'ownerUserId', check);
      return named;
    }
    const self = actorParty(principal);
    const decision = decideAssignment(self, self, 'create');
    if (decision.allowed) {
      // Keeping the lead must pass what naming yourself passes: a caller whose lead read does not reach what they
      // own would lose the lead the moment it is created.
      await assertAssignable(tx, principal, scope, principal.userId, 'ownerUserId', check);
      return principal.userId;
    }
    if (decision.reason === 'sales_owner_required') {
      const fallback = await this.fallbackOwner(
        tx,
        scope,
        await assignableParties(tx, principal, scope, check),
      );
      if (fallback !== null) return fallback.userId;
    }
    throw assignmentRefused('ownerUserId', decision.reason);
  }

  /**
   * F1-Q21: who a lead started with no owner chosen goes to when its creator may not keep it: the entity's default
   * lead owner when set and still someone this lead may be handed to, else the Sales head. One function for the
   * create path and for the owner list that shows the person (`owners('create')`), so they cannot disagree.
   */
  private async fallbackOwner(
    tx: DbTransaction,
    scope: TxScope,
    parties: readonly AssignmentCandidate[],
  ): Promise<{ userId: string; source: 'settings' | 'sales_head' } | null> {
    const configured = (await readSetting(tx, scope, 'crm.default_lead_owner')).value;
    if (configured !== null && parties.some((p) => p.userId === configured)) {
      return { userId: configured, source: 'settings' };
    }
    const head = defaultSalesOwner(parties);
    return head === null ? null : { userId: head, source: 'sales_head' };
  }

  /**
   * Tells the lead's owner it was handed to them (#22): a bell row and an email, in this transaction so a rolled
   * back change tells nobody. The caller nudges the drainer after the commit. One notice per owner change: the key
   * names the lead's version.
   */
  private async notifyAssigned(
    tx: DbTransaction,
    principal: Principal,
    lead: LeadRow,
  ): Promise<void> {
    if (lead.ownerUserId === null) return;
    const [me] = await tx
      .select({ displayName: users.displayName })
      .from(users)
      .where(and(eq(users.tenantId, lead.tenantId), eq(users.id, principal.userId)));
    const assignerName = shownName(me?.displayName ?? null);
    const linkPath = `/leads/${lead.id}`;
    await this.notify.notifyUser(tx, {
      userId: lead.ownerUserId,
      title: `Lead ${lead.number} assigned to you`,
      body: `${assignerName} assigned the lead ${lead.number} (${lead.title}) to you.`,
      link: linkPath,
      email: {
        template: 'crm.assigned',
        vars: { entityType: 'lead', entityName: lead.number, assignerName, linkPath },
      },
      dedupeKey: `crm.assigned:lead:${lead.id}:${lead.version}`,
    });
  }

  /**
   * Record-level authz that answers 404, not 403, for a lead outside the caller's scope: a 403 would confirm that a
   * guessed id exists. Other denials (no grant at all, inactive user) stay 403. `readers` only on a read (leadRef).
   */
  private assertVisible(action: Permission, row: LeadRow, readers?: RecordReaders): void {
    try {
      this.authz.assert(action, leadRef(row, readers));
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

  /** The lost reason option of a lead, by its current label (D49); null for a lead without one. */
  private async lostReasonOf(
    q: Db | DbTransaction,
    row: Pick<LeadRow, 'tenantId' | 'lostReasonId'>,
  ): Promise<LeadLostReasonRef | null> {
    if (row.lostReasonId === null) return null;
    return (
      (await lostReasonRefs(q, row.tenantId, [row.lostReasonId])).get(row.lostReasonId) ?? null
    );
  }

  /** The owner's display name (D46), read in the lead's tenant. */
  private async ownerNameOf(
    q: Db | DbTransaction,
    row: Pick<LeadRow, 'tenantId' | 'ownerUserId'>,
  ): Promise<string | null> {
    return nameIn(await personNameMap(q, row.tenantId, [row.ownerUserId]), row.ownerUserId);
  }

  /**
   * Whether the lead already has a contact that happened (FR-6): a call, email or meeting that is not cancelled and
   * is either completed, or was logged (no due time) at or before now. A planned follow-up, even an overdue one, a
   * note and a stage_change row do not count.
   */
  private async hasDoneContact(tx: DbTransaction, id: string): Promise<boolean> {
    const [row] = await tx
      .select({ id: activities.id })
      .from(activities)
      .where(
        and(
          eq(activities.leadId, id),
          inArray(activities.kind, [...CONTACT_ACTIVITY_KINDS]),
          isNull(activities.cancelledAt),
          or(
            isNotNull(activities.completedAt),
            and(isNull(activities.dueAt), lte(activities.occurredAt, new Date())),
          ),
        ),
      )
      .limit(1);
    return row !== undefined;
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
