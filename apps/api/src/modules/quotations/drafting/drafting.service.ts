// DraftingService: a new quotation and its draft content (P2 unit Q1b-B). Serves the NFRs:
// - "amounts are exact": every figure stored on a version, its lines and its tax summary comes from
//   PricingService.priceVersion (the one calculator, @bos/money-rules), never from the client;
// - "no gaps in a numbered series": the QT number is taken inside the create transaction, from the acting
//   entity's series, so a rolled-back create gives its number back;
// - "no double effects": create runs inside withIdempotency, so a retried POST returns the first answer;
// - "every change is audited": all writes run in withTx(); the status change is a quotation_status_history row
//   and the create is an audit event;
// - "authorization is deny-by-default": staff only, `quotation.draft` on a quotation the caller will own, and the
//   opportunity is read through scoped(), so another entity's opportunity is a 404.
// - list, detail and getVersion (Part 2) are staff-only and read through scopeWhereFor(), the SQL twin of can(),
//   so a quotation of another entity, or of another owner under `own` scope, is a 404 and never in the list.
// - updateDraft (Part 3) re-prices the merged draft content and guards the write with the row version.
import {
  canCancelQuotation,
  canReviseQuotation,
  type CreateQuotationBody,
  type DocumentVersionStatus,
  isQuotationEditable,
  type ListQuotationsQuery,
  type Permission,
  type QuotationAmount,
  type QuotationCapabilities,
  type QuotationDetail,
  type QuotationDto,
  type QuotationLead,
  type QuotationListItem,
  QUOTATION_STATUSES,
  type QuotationStatus,
  type QuotationSummary,
  type QuotationSummaryQuery,
  QuotationVersionContentSchema,
  type QuotationVersionDto,
  type UpdateQuotationDraftBody,
} from '@bos/contracts';
import {
  customerContacts,
  customers,
  documentVersions,
  leads,
  opportunities,
  paymentTerms,
  quotationLines,
  quotations,
  quotationStatusHistory,
  quotationTaxSummary,
  quotationVersions,
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
  Optional,
} from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';

import { AuditService } from '../../../platform/audit/audit.service';
import { AuthzService, scopeWhereFor } from '../../../platform/authz/authz.service';
import { can, type Principal, type ResourceRef } from '../../../platform/authz/can';
import { DB, type Db, type DbTransaction } from '../../../platform/db/db.module';
import { updateVersioned, withIdempotency } from '../../../platform/db/idempotency';
import { NO_LIMIT, type Reader, searchPage } from '../../../platform/list';
import { withTx, type Actor, type TxScope, READ_ONLY } from '../../../platform/db/tx';
import { CurrencyEnabledService } from '../../../platform/settings/currency-enabled';
import { NumberingService } from '../../../platform/settings/numbering.service';
import { draftReachPrincipal } from '../../opportunities/quotation-draft-reach';
import { quotationRef } from '../preview/quotation-preview.service';
import { personNames } from '../../../platform/users/person-names';
import { PricingService } from '../pricing/pricing.service';
import type { PricingInput } from '../pricing/pricing.types';
import {
  canReadCost,
  detailVisibleTo,
  pricingWithAllowedCosts,
  versionVisibleTo,
} from './cost-visibility';
import { DraftingCaller } from './drafting.caller';
import {
  toQuotationDetail,
  toQuotationDto,
  toQuotationListItem,
  toQuotationVersionDto,
  type QuotationRow,
  type QuotationVersionParts,
  QUOTATION_VERSION_BODY_COLUMNS,
  type QuotationVersionBody,
} from './mapping';

/** A version with its own rows; the parent quotation is added by the caller. */
type VersionWithParts = Omit<QuotationVersionParts, 'quotation'>;

/** Injection token for a test clock; production falls back to the system time. */
export const DRAFTING_CLOCK = Symbol('DRAFTING_CLOCK');

/** The numbering series key; its prefix is `QT`, as in QT-2082/83-00001. */
export const QUOTATION_SERIES = 'QT';

const AUDIT_ENTITY = 'quotations';

// The joins every list read shares: the current version, the customer and the (optional) owner.
const onCurrentVersion = and(
  eq(quotationVersions.tenantId, quotations.tenantId),
  eq(quotationVersions.id, quotations.currentVersionId),
);
const onCustomer = and(
  eq(customers.tenantId, quotations.tenantId),
  eq(customers.id, quotations.customerPartyId),
);
const onOwner = and(eq(users.tenantId, quotations.tenantId), eq(users.id, quotations.ownerUserId));
const LIST_SEARCH_COLUMNS = [quotations.number, customers.legalName, users.displayName];

async function countMatching(r: Reader, where: SQL | undefined): Promise<number> {
  const [row] = await r
    .select({ n: sql<number>`count(*)::int` })
    .from(quotations)
    .innerJoin(quotationVersions, onCurrentVersion)
    .innerJoin(customers, onCustomer)
    .leftJoin(users, onOwner)
    .where(where);
  return row?.n ?? 0;
}

const opportunityNotFound = () =>
  new NotFoundException({ code: 'not_found', message: 'Opportunity not found' });

const quotationNotFound = () =>
  new NotFoundException({ code: 'not_found', message: 'Quotation not found' });

const forbidden = () =>
  new ForbiddenException({ code: 'forbidden', message: 'Forbidden', reason: 'no_permission' });

const badRequest = (message: string) => new BadRequestException({ code: 'bad_request', message });

const notEditable = () =>
  new ConflictException({
    code: 'conflict',
    message: 'Only a Draft or Returned version can be edited; revise it instead',
  });

/** The pg error behind `error` (drizzle may wrap it as `cause`): its SQLSTATE and, when named, the constraint. */
function pgError(error: unknown): { code: string; constraint?: string } | undefined {
  for (
    let e: unknown = error, depth = 0;
    typeof e === 'object' && e !== null && depth < 3;
    depth++
  ) {
    const { code, constraint, cause } = e as {
      code?: unknown;
      constraint?: unknown;
      cause?: unknown;
    };
    if (typeof code === 'string' && code.length === 5) {
      return { code, ...(typeof constraint === 'string' ? { constraint } : {}) };
    }
    e = cause;
  }
  return undefined;
}

/** `o` without its undefined and null fields: a partial body names only what it changes. */
function definedOnly<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined && v !== null),
  ) as Partial<T>;
}

/**
 * A PUT body over the saved content. An absent (undefined) key keeps the saved value; `null` clears it, so a
 * person can remove a discount or blank a text once saved. The result is parsed with the content contract, which
 * has no null: a cleared key is left out, the same as one that was never set.
 */
export function mergeDraftPatch(
  saved: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const cleared = new Set(Object.keys(patch).filter((k) => patch[k] === null));
  return Object.fromEntries(
    Object.entries({ ...saved, ...definedOnly(patch) }).filter(([k]) => !cleared.has(k)),
  );
}

/**
 * The saved content of a version in the body's shape, read off its DTO (whose discount is already trimmed to
 * the contract's decimals), so a partial update can be merged over it and parsed with the contract.
 */
function contentOf(v: QuotationVersionDto): Record<string, unknown> {
  return definedOnly({
    contactId: v.contactId,
    templateId: v.templateId,
    currency: v.currency,
    issueDate: v.issueDate,
    validUntil: v.validUntil,
    scope: v.scope,
    assumptions: v.assumptions,
    exclusions: v.exclusions,
    termsAndConditions: v.termsAndConditions,
    deliveryTimeline: v.deliveryTimeline,
    paymentTermId: v.paymentTermId,
    // The DTO rows carry a computed `amount` (D36); the draft input contract is strict and has none.
    paymentSchedule: v.paymentSchedule.map(({ amount: _amount, ...milestone }) => milestone),
    discount: v.discount,
    lines: v.lines.map((l) =>
      definedOnly({
        catalogItemId: l.catalogItemId,
        description: l.description,
        uom: l.uom,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        unitCost: l.unitCost,
        taxCodeId: l.taxCodeId,
      }),
    ),
  });
}

/** The pricing input of a version's content: lines numbered from 1 in the order the client sent them. */
export function pricingInputOf(
  content: Pick<CreateQuotationBody, 'currency' | 'issueDate' | 'lines' | 'discount'>,
): PricingInput {
  return {
    currency: content.currency,
    issueDate: content.issueDate,
    lines: content.lines.map((line, i) => ({
      lineNo: i + 1,
      catalogItemId: line.catalogItemId ?? null,
      description: line.description,
      uom: line.uom,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      taxCodeId: line.taxCodeId,
      unitCost: line.unitCost ?? null,
    })),
    discount: content.discount ?? null,
  };
}

/**
 * The record updateDraft() checks `quotation.draft` against: the stored owner and the department stamped from the
 * opportunity (migration 0088), so under `own` scope a colleague's quotation is read-only and under `department`
 * one of the caller's department is editable. No creator or assignees: writes never reach through a follow-up
 * (D55-3). One function, so the capability and the command cannot drift.
 */
export function draftRefOf(q: {
  tenantId: string;
  organizationId: string;
  ownerUserId: string | null;
  customerPartyId: string | null;
  departmentId?: string | null;
}): ResourceRef {
  return {
    tenantId: q.tenantId,
    organizationId: q.organizationId,
    ownerUserId: q.ownerUserId,
    departmentId: q.departmentId ?? null,
    customerPartyId: q.customerPartyId,
  };
}

/**
 * What `p` may do with a quotation whose current version has `status`, by the same rules the commands
 * enforce: updateDraft() (Draft or Returned, `quotation.draft` on the record), ReviseService.revise()
 * (a revisable status, `quotation.revise` on quotationRef()), QuotationSendService (`quotation.send` on
 * approved/expired), RecordOutcomeService (`quotation.record_acceptance` on sent) and CancelService (`quotation.draft`
 * on draft, returned or submitted). Pure, so a screen
 * can trust it and a test can check it without a database.
 */
export function capabilitiesOf(
  p: Principal,
  q: Parameters<typeof draftRefOf>[0],
  status: QuotationStatus,
): QuotationCapabilities {
  const ref = quotationRef(q);
  return {
    canEdit: isQuotationEditable(status) && can(p, 'quotation.draft', draftRefOf(q)).allowed,
    canRevise: canReviseQuotation(status) && can(p, 'quotation.revise', ref).allowed,
    canSend:
      (status === 'approved' || status === 'expired') && can(p, 'quotation.send', ref).allowed,
    canRecordOutcome: status === 'sent' && can(p, 'quotation.record_acceptance', ref).allowed,
    canCancel: canCancelQuotation(status) && can(p, 'quotation.draft', draftRefOf(q)).allowed,
  };
}

@Injectable()
export class DraftingService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly numbering: NumberingService,
    private readonly pricing: PricingService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly caller: DraftingCaller,
    private readonly currencies: CurrencyEnabledService,
    @Optional() @Inject(DRAFTING_CLOCK) private readonly clock: () => Date = () => new Date(),
  ) {}

  // ------------------------------------------------------------------------------------------------- create

  /**
   * A quotation on an opportunity of the acting entity, with revision 1 as a priced Draft. The customer is the
   * opportunity's. 404 for an opportunity outside the acting entity or the caller's draft reach (`findOpportunity`);
   * 400 for a contact of another customer, an unknown payment term or tax code, or a discount above the subtotal.
   */
  async create(body: CreateQuotationBody, idempotencyKey: string): Promise<QuotationDto> {
    const { scope, actor, principal } = this.caller.current();
    // Decided before any read: a caller who may not draft learns nothing about the opportunity.
    this.assertMayDraft(principal, scope);
    const now = this.clock();
    const mayCost = canReadCost(principal);
    return withTx(this.db, scope, actor, async (tx) => {
      const done = await withIdempotency(
        tx,
        { command: 'quotation.create', key: idempotencyKey, body },
        async () => ({
          status: 201,
          response: await this.createInTx(tx, scope, actor, principal, body, now, mayCost),
        }),
      );
      return done.response;
    });
  }

  private async createInTx(
    tx: DbTransaction,
    scope: TxScope,
    actor: Actor,
    /** The caller, who becomes the owner: the user the quotation.draft check above approved as owner. */
    principal: Principal,
    body: CreateQuotationBody,
    now: Date,
    mayCost: boolean,
  ): Promise<QuotationDto> {
    const ownerUserId = principal.userId;
    const opportunity = await this.findOpportunity(tx, scope, principal, body.opportunityId);
    const customerPartyId = opportunity.customerId;
    await this.assertCustomer(tx, scope.tenantId, customerPartyId);
    if (body.contactId !== undefined) {
      await this.assertContactOf(tx, scope.tenantId, body.contactId, customerPartyId);
    }
    if (body.paymentTermId !== undefined) {
      await this.assertPaymentTerm(tx, scope.tenantId, body.paymentTermId);
    }
    if (body.attachmentDocumentIds !== undefined && body.attachmentDocumentIds.length > 0) {
      // Refused rather than silently dropped until attachments are stored.
      throw badRequest('attachmentDocumentIds are not supported yet');
    }
    // D44: only a currency the company switched on (422 CURRENCY_NOT_ENABLED), checked before any write.
    await this.currencies.assertEnabled(scope, body.currency);

    // A drafter who may not read costs cannot set them either: a new quotation has no stored cost to keep.
    const priced = await this.pricing.priceVersion(
      tx,
      scope,
      pricingWithAllowedCosts(pricingInputOf(body), mayCost, []),
    );
    const { number } = await this.numbering.issue(tx, QUOTATION_SERIES, now);
    const owned = { tenantId: scope.tenantId, organizationId: scope.organizationId };

    // The parent first, without a current version: the version's foreign key needs the parent.
    const [quotation] = await tx
      .insert(quotations)
      .values({
        ...owned,
        number,
        customerPartyId,
        opportunityId: opportunity.id,
        currentVersionId: null,
        ownerUserId,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: quotations.id });
    const quotationId = quotation!.id;

    const [version] = await tx
      .insert(quotationVersions)
      .values({
        ...owned,
        quotationId,
        revisionNo: 1,
        status: 'draft',
        contactId: body.contactId ?? null,
        templateId: body.templateId ?? null,
        currency: body.currency,
        issueDate: body.issueDate,
        validUntil: body.validUntil,
        scope: body.scope ?? null,
        assumptions: body.assumptions ?? null,
        exclusions: body.exclusions ?? null,
        termsAndConditions: body.termsAndConditions ?? null,
        deliveryTimeline: body.deliveryTimeline ?? null,
        paymentTermId: body.paymentTermId ?? null,
        paymentSchedule: body.paymentSchedule ?? [],
        discountMode: body.discount?.mode ?? null,
        discountInput: body.discount?.value ?? null,
        ...priced.columns,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: quotationVersions.id });
    const versionId = version!.id;

    await tx
      .insert(quotationLines)
      .values(priced.lines.map((line) => ({ ...owned, versionId, ...line })));
    if (priced.taxSummary.length > 0) {
      await tx
        .insert(quotationTaxSummary)
        .values(priced.taxSummary.map((row) => ({ ...owned, versionId, ...row })));
    }

    const [row] = await tx
      .update(quotations)
      .set({ currentVersionId: versionId })
      .where(and(eq(quotations.tenantId, scope.tenantId), eq(quotations.id, quotationId)))
      .returning();

    await tx.insert(quotationStatusHistory).values({
      ...owned,
      versionId,
      fromStatus: null,
      toStatus: 'draft',
      actorId: actor.kind === 'user' ? actor.id : null,
      at: now,
    });
    await this.audit.record(tx, {
      action: 'quotation.created',
      entityType: AUDIT_ENTITY,
      entityId: quotationId,
      after: {
        number,
        opportunityId: opportunity.id,
        customerPartyId,
        versionId,
        status: 'draft',
        currency: body.currency,
        total: priced.columns.total,
      },
    });
    return toQuotationDto(row!, 'draft');
  }

  // -------------------------------------------------------------------------------------------------- reads

  /**
   * The quotations of the acting entity the caller may read, newest first, one page of them and the total.
   * `status` is the current version's; `customerId` and `opportunityId` are filters on top of the read scope,
   * never a widening. `q` searches number, customer name and owner name (close matches when few match exactly).
   * Without `limit` every match is returned (the pickers never page).
   */
  async list(
    query: Partial<ListQuotationsQuery> = {},
  ): Promise<{ rows: QuotationListItem[]; total: number }> {
    const { scope, actor, principal } = this.caller.current();
    this.assertStaff(principal);
    const { status, limit = NO_LIMIT, offset = 0 } = query;
    const where = and(
      scopeWhereFor(principal, quotations, 'quotation.read'),
      status?.length ? inArray(quotationVersions.status, status) : undefined,
      this.sharedFilters(query),
    );
    return withTx(
      this.db,
      scope,
      actor,
      async (tx) => {
        const { rows, total } = await searchPage(tx, {
          q: query.q,
          columns: LIST_SEARCH_COLUMNS,
          where,
          orderBy: [desc(quotations.createdAt), desc(quotations.id)],
          limit,
          offset,
          rows: (r, p) =>
            r
              .select({
                quotation: quotations,
                // The four figures the list shows, not the whole version: its document style can hold a logo.
                current: {
                  status: quotationVersions.status,
                  currency: quotationVersions.currency,
                  total: quotationVersions.total,
                  validUntil: quotationVersions.validUntil,
                },
                customerName: customers.legalName,
                ownerName: users.displayName,
                ownerAvatarDocumentId: users.avatarDocumentId,
              })
              .from(quotations)
              .innerJoin(quotationVersions, onCurrentVersion)
              .innerJoin(customers, onCustomer)
              .leftJoin(users, onOwner)
              .where(p.where)
              .orderBy(...p.orderBy)
              .limit(p.limit)
              .offset(p.offset),
          count: countMatching,
        });
        return {
          total,
          rows: rows.map((r) =>
            toQuotationListItem(r.quotation, r.current, {
              customerName: r.customerName,
              ownerName: r.ownerName,
              ownerAvatarDocumentId: r.ownerAvatarDocumentId,
              canEdit: capabilitiesOf(principal, r.quotation, r.current.status).canEdit,
            }),
          ),
        };
      },
      READ_ONLY,
    );
  }

  /**
   * How many quotations match the list's filters other than `status`, in total and per current status, for the
   * KPI cards. Same read scope, joins and search as `list`, so the cards add up to the list's total.
   */
  async summary(query: QuotationSummaryQuery = {}): Promise<QuotationSummary> {
    const { scope, actor, principal } = this.caller.current();
    this.assertStaff(principal);
    const where = and(
      scopeWhereFor(principal, quotations, 'quotation.read'),
      this.sharedFilters(query),
    );
    return withTx(
      this.db,
      scope,
      actor,
      async (tx) => {
        // One page of one row: searchPage settles exact or close matches from the total and hands the final
        // predicate to `rows`, which counts per status over exactly that predicate.
        const { rows, total } = await searchPage(tx, {
          q: query.q,
          columns: LIST_SEARCH_COLUMNS,
          where,
          orderBy: [desc(quotations.id)],
          limit: 1,
          offset: 0,
          rows: (r, p) =>
            r
              .select({
                status: quotationVersions.status,
                currency: quotationVersions.currency,
                n: sql<number>`count(*)::int`,
                // numeric(18,2) summed in the database and read as text: exact, never a float.
                worth: sql<string>`sum(${quotationVersions.total})::text`,
              })
              .from(quotations)
              .innerJoin(quotationVersions, onCurrentVersion)
              .innerJoin(customers, onCustomer)
              .leftJoin(users, onOwner)
              .where(p.where)
              .groupBy(quotationVersions.status, quotationVersions.currency),
          count: countMatching,
        });
        const byStatus = Object.fromEntries(QUOTATION_STATUSES.map((st) => [st, 0])) as Record<
          QuotationStatus,
          number
        >;
        const amounts = Object.fromEntries(
          QUOTATION_STATUSES.map((st) => [st, []]),
        ) as unknown as Record<QuotationStatus, QuotationAmount[]>;
        for (const r of rows) {
          byStatus[r.status] += r.n;
          amounts[r.status].push({
            currency: r.currency as QuotationAmount['currency'],
            total: r.worth,
          });
        }
        for (const st of QUOTATION_STATUSES)
          amounts[st].sort((a, b) => a.currency.localeCompare(b.currency));
        return { total, byStatus, amounts };
      },
      READ_ONLY,
    );
  }

  /** The customer and opportunity filters of `list` and `summary`; `status` is not one of them. */
  private sharedFilters(query: {
    customerId?: string[] | undefined;
    opportunityId?: string | undefined;
  }): SQL | undefined {
    return and(
      query.customerId?.length ? inArray(quotations.customerPartyId, query.customerId) : undefined,
      query.opportunityId === undefined
        ? undefined
        : eq(quotations.opportunityId, query.opportunityId),
    );
  }

  /** Every version (Superseded included) with lines, tax summary and scan status, the history and the contacts. */
  async detail(id: string): Promise<QuotationDetail> {
    const { scope, actor, principal } = this.caller.current();
    this.assertStaff(principal);
    return withTx(
      this.db,
      scope,
      actor,
      async (tx) => {
        const quotation = await this.findVisible(tx, principal, id);
        const versionRows = await tx
          .select(QUOTATION_VERSION_BODY_COLUMNS)
          .from(quotationVersions)
          .where(
            and(
              eq(quotationVersions.tenantId, quotation.tenantId),
              eq(quotationVersions.organizationId, quotation.organizationId),
              eq(quotationVersions.quotationId, quotation.id),
            ),
          );
        const versions = await this.withParts(tx, quotation.tenantId, versionRows);
        const statusHistory = await tx
          .select()
          .from(quotationStatusHistory)
          .where(
            and(
              eq(quotationStatusHistory.tenantId, quotation.tenantId),
              inArray(
                quotationStatusHistory.versionId,
                versionRows.map((v) => v.id),
              ),
            ),
          )
          .orderBy(asc(quotationStatusHistory.at), asc(quotationStatusHistory.id));
        const customerPartyId = quotation.customerPartyId;
        if (customerPartyId === null) {
          throw new Error(`quotation ${quotation.number} has no customer`);
        }
        const [customer] = await tx
          .select({ legalName: customers.legalName })
          .from(customers)
          .where(and(eq(customers.tenantId, quotation.tenantId), eq(customers.id, customerPartyId)))
          .limit(1);
        if (customer === undefined) {
          throw new Error(`quotation ${quotation.number} has no customer record`);
        }
        const contacts = await tx
          .select({
            id: customerContacts.id,
            fullName: customerContacts.fullName,
            emailNorm: customerContacts.emailNorm,
          })
          .from(customerContacts)
          .where(
            and(
              eq(customerContacts.tenantId, quotation.tenantId),
              eq(customerContacts.customerId, customerPartyId),
            ),
          )
          .orderBy(asc(customerContacts.fullName), asc(customerContacts.id));
        const current = versionRows.find((v) => v.id === quotation.currentVersionId);
        // The owner and every history actor by name, so the page needs no admin directory (403 for most staff).
        const people = await personNames(tx, quotation.tenantId, [
          quotation.ownerUserId,
          ...statusHistory.map((h) => h.actorId),
        ]);
        const lead = await this.leadOf(tx, scope, principal, quotation.opportunityId);
        const answer = toQuotationDetail({
          quotation,
          versions,
          statusHistory,
          customerName: customer.legalName,
          contacts,
          // No current version: toQuotationDetail refuses the answer anyway, so nothing is offered.
          capabilities:
            current === undefined
              ? {
                  canEdit: false,
                  canRevise: false,
                  canSend: false,
                  canRecordOutcome: false,
                  canCancel: false,
                }
              : capabilitiesOf(principal, quotation, current.status),
          people,
          ...(lead === undefined ? {} : { lead }),
        });
        return detailVisibleTo(principal, answer);
      },
      READ_ONLY,
    );
  }

  /**
   * The lead behind a quotation (D35): its opportunity's parent lead, only when the caller may read it. undefined,
   * so the key is left out, when there is no lead (or the opportunity is gone) AND when the caller may not read it:
   * "none" and "hidden" must look the same, or the difference would disclose a hidden lead. The lead is read through
   * scoped() and the same rule as the lead page (`crm.lead.read` with its scope on the lead's record, as
   * scopeWhereFor), so another owner's lead under `own` scope, and any lead of another entity, never appears.
   */
  private async leadOf(
    tx: DbTransaction,
    scope: TxScope,
    principal: Principal,
    opportunityId: string,
  ): Promise<QuotationLead | undefined> {
    const [opportunity] = await tx
      .select({ leadId: opportunities.leadId })
      .from(opportunities)
      .where(scoped(scope).where(opportunities, eq(opportunities.id, opportunityId)))
      .limit(1);
    if (opportunity === undefined || opportunity.leadId === null) return undefined;
    const [lead] = await tx
      .select({ id: leads.id, name: leads.title })
      .from(leads)
      .where(
        scoped(scope).where(
          leads,
          and(eq(leads.id, opportunity.leadId), scopeWhereFor(principal, leads, 'crm.lead.read')),
        ),
      )
      .limit(1);
    return lead;
  }

  /** One version of a visible quotation; a version of another quotation is a 404 like a missing one. */
  async getVersion(id: string, versionId: string): Promise<QuotationVersionDto> {
    const { scope, actor, principal } = this.caller.current();
    this.assertStaff(principal);
    return withTx(
      this.db,
      scope,
      actor,
      async (tx) => {
        const quotation = await this.findVisible(tx, principal, id);
        const version = await this.findVersion(tx, quotation, versionId);
        const [parts] = await this.withParts(tx, quotation.tenantId, [version]);
        return versionVisibleTo(principal, toQuotationVersionDto({ ...parts!, quotation }));
      },
      READ_ONLY,
    );
  }

  // ------------------------------------------------------------------------------------------- update draft

  /**
   * Saves draft content onto a Draft or Returned version: the body's fields over the saved content, re-priced in
   * full (a new issue date or currency changes rates even when the lines stay), the lines and tax summary
   * replaced, and the version row bumped through updateVersioned(), all in one transaction. 404 outside the
   * caller's read scope, 403 without quotation.draft on this quotation, 409 for any other status or a stale
   * expectedVersion, 400 for merged content the contract refuses.
   */
  async updateDraft(
    id: string,
    versionId: string,
    body: UpdateQuotationDraftBody,
  ): Promise<{ version: number }> {
    const { scope, actor, principal } = this.caller.current();
    this.assertStaff(principal);
    try {
      return await withTx(this.db, scope, actor, (tx) =>
        this.updateDraftInTx(tx, scope, principal, id, versionId, body),
      );
    } catch (error) {
      // The freeze triggers refuse what slipped past the status check (a submit committed in between).
      const pg = pgError(error);
      if (
        pg?.code === '23514' &&
        pg.constraint !== undefined &&
        (pg.constraint.endsWith('_frozen_check') || pg.constraint.endsWith('_transition_check'))
      ) {
        throw notEditable();
      }
      throw error;
    }
  }

  private async updateDraftInTx(
    tx: DbTransaction,
    scope: TxScope,
    principal: Principal,
    id: string,
    versionId: string,
    body: UpdateQuotationDraftBody,
  ): Promise<{ version: number }> {
    const quotation = await this.findVisible(tx, principal, id);
    // The record check uses the stored owner: under `own`, a colleague's quotation is read-only.
    const action: Permission = 'quotation.draft';
    this.authz.assert(action, draftRefOf(quotation));
    const version = await this.findVersion(tx, quotation, versionId, true);
    if (version.status !== 'draft' && version.status !== 'returned') throw notEditable();

    const { expectedVersion, ...patch } = body;
    // D44: a changed currency must be switched on; the saved one stays editable even if since switched off.
    if (patch.currency !== undefined && patch.currency !== version.currency) {
      await this.currencies.assertEnabled(scope, patch.currency);
    }
    if (patch.attachmentDocumentIds !== undefined && patch.attachmentDocumentIds.length > 0) {
      throw badRequest('attachmentDocumentIds are not supported yet');
    }
    const [parts] = await this.withParts(tx, scope.tenantId, [version]);
    const saved = toQuotationVersionDto({ ...parts!, quotation });
    const parsed = QuotationVersionContentSchema.safeParse(
      mergeDraftPatch(contentOf(saved), patch),
    );
    if (!parsed.success) {
      throw badRequest(parsed.error.issues.map((i) => i.message).join('; '));
    }
    const content = parsed.data;
    // A null clears the field, so only a sent id is checked.
    if (typeof patch.contactId === 'string' && quotation.customerPartyId !== null) {
      await this.assertContactOf(tx, scope.tenantId, patch.contactId, quotation.customerPartyId);
    }
    if (typeof patch.paymentTermId === 'string') {
      await this.assertPaymentTerm(tx, scope.tenantId, patch.paymentTermId);
    }

    // A drafter who may not read costs keeps the stored cost of each line (the DTO the content was merged from is
    // full, so a body that omits a line's cost must not wipe it) and cannot set one, but only while the lines are
    // structurally the stored ones: any add, remove, reorder or identity edit is refused (409) before a write. The
    // margin and the internal cost total are recomputed from those costs. `saved.lines` is in line order.
    const priced = await this.pricing.priceVersion(
      tx,
      scope,
      pricingWithAllowedCosts(pricingInputOf(content), canReadCost(principal), saved.lines),
    );
    const owned = { tenantId: quotation.tenantId, organizationId: quotation.organizationId };
    await tx
      .delete(quotationLines)
      .where(
        and(eq(quotationLines.tenantId, scope.tenantId), eq(quotationLines.versionId, versionId)),
      );
    await tx
      .delete(quotationTaxSummary)
      .where(
        and(
          eq(quotationTaxSummary.tenantId, scope.tenantId),
          eq(quotationTaxSummary.versionId, versionId),
        ),
      );
    await tx
      .insert(quotationLines)
      .values(priced.lines.map((line) => ({ ...owned, versionId, ...line })));
    if (priced.taxSummary.length > 0) {
      await tx
        .insert(quotationTaxSummary)
        .values(priced.taxSummary.map((row) => ({ ...owned, versionId, ...row })));
    }
    const updated = await updateVersioned(tx, quotationVersions, versionId, expectedVersion, {
      contactId: content.contactId ?? null,
      templateId: content.templateId ?? null,
      currency: content.currency,
      issueDate: content.issueDate,
      validUntil: content.validUntil,
      scope: content.scope ?? null,
      assumptions: content.assumptions ?? null,
      exclusions: content.exclusions ?? null,
      termsAndConditions: content.termsAndConditions ?? null,
      deliveryTimeline: content.deliveryTimeline ?? null,
      paymentTermId: content.paymentTermId ?? null,
      paymentSchedule: content.paymentSchedule ?? [],
      discountMode: content.discount?.mode ?? null,
      discountInput: content.discount?.value ?? null,
      ...priced.columns,
      updatedAt: this.clock(),
    });

    await this.audit.record(tx, {
      action: 'quotation.draft_updated',
      entityType: AUDIT_ENTITY,
      entityId: quotation.id,
      before: { versionId, version: version.version, total: version.total },
      after: {
        versionId,
        version: updated.version,
        currency: updated.currency,
        total: updated.total,
        // Cleared (null) fields count as changed too.
        fields: Object.keys(patch).filter((k) => patch[k as keyof typeof patch] !== undefined),
      },
    });
    return { version: updated.version };
  }

  // ----------------------------------------------------------------------------------------------- helpers

  /**
   * The workspace routes are for staff: a version carries the internal cost and margin, so a portal user holding
   * quotation.read by mistake is refused here and reads through the portal routes instead.
   */
  private assertStaff(p: Principal): void {
    if (p.orgKind !== 'staff') throw forbidden();
  }

  /**
   * The quotation, when the caller may read it: the same scopeWhereFor() rule as the list, so another entity's
   * quotation, or another owner's under `own` scope, is a 404 rather than a 403 that would confirm it exists.
   */
  private async findVisible(tx: DbTransaction, p: Principal, id: string): Promise<QuotationRow> {
    const [row] = await tx
      .select()
      .from(quotations)
      .where(and(scopeWhereFor(p, quotations, 'quotation.read'), eq(quotations.id, id)))
      .limit(1);
    if (row === undefined) throw quotationNotFound();
    return row;
  }

  /**
   * A version of `quotation`; one of another quotation is a 404. `forUpdate` locks the row, so a submit cannot
   * commit between the status check and the write.
   */
  private async findVersion(
    tx: DbTransaction,
    quotation: QuotationRow,
    versionId: string,
    forUpdate = false,
  ): Promise<QuotationVersionBody> {
    const query = tx
      .select(QUOTATION_VERSION_BODY_COLUMNS)
      .from(quotationVersions)
      .where(
        and(
          eq(quotationVersions.tenantId, quotation.tenantId),
          eq(quotationVersions.organizationId, quotation.organizationId),
          eq(quotationVersions.quotationId, quotation.id),
          eq(quotationVersions.id, versionId),
        ),
      )
      .limit(1);
    const [row] = forUpdate ? await query.for('update') : await query;
    if (row === undefined) {
      throw new NotFoundException({ code: 'not_found', message: 'Quotation version not found' });
    }
    return row;
  }

  /** The lines, tax summary and rendered-PDF scan status of each version, read in three queries. */
  private async withParts(
    tx: DbTransaction,
    tenantId: string,
    versions: readonly QuotationVersionBody[],
  ): Promise<VersionWithParts[]> {
    const ids = versions.map((v) => v.id);
    if (ids.length === 0) return [];
    const lines = await tx
      .select()
      .from(quotationLines)
      .where(and(eq(quotationLines.tenantId, tenantId), inArray(quotationLines.versionId, ids)));
    const taxSummary = await tx
      .select()
      .from(quotationTaxSummary)
      .where(
        and(
          eq(quotationTaxSummary.tenantId, tenantId),
          inArray(quotationTaxSummary.versionId, ids),
        ),
      );
    const documentIds = versions.flatMap((v) =>
      v.renderedDocumentId === null ? [] : [v.renderedDocumentId],
    );
    // The newest upload of each rendered document, whatever its scan status: documents.current_version_id is the
    // newest *clean* one, so reading through it would show a pending or infected scan as "no PDF".
    const scanStatus = new Map<string, DocumentVersionStatus>();
    if (documentIds.length > 0) {
      const docVersions = await tx
        .select({ documentId: documentVersions.documentId, status: documentVersions.status })
        .from(documentVersions)
        .where(
          and(
            eq(documentVersions.tenantId, tenantId),
            inArray(documentVersions.documentId, documentIds),
          ),
        )
        .orderBy(desc(documentVersions.version));
      for (const d of docVersions) {
        if (!scanStatus.has(d.documentId)) scanStatus.set(d.documentId, d.status);
      }
    }
    return versions.map((version) => ({
      version,
      lines: lines.filter((l) => l.versionId === version.id),
      taxSummary: taxSummary.filter((t) => t.versionId === version.id),
      renderedScanStatus:
        version.renderedDocumentId === null
          ? null
          : (scanStatus.get(version.renderedDocumentId) ?? null),
    }));
  }

  /**
   * Quotations are drafted by staff only (a portal user holding the key by mistake is still refused), and the
   * caller becomes the owner, so the record checked is "a quotation of the acting entity owned by the caller".
   */
  private assertMayDraft(p: Principal, scope: TxScope): void {
    this.assertStaff(p);
    const action: Permission = 'quotation.draft';
    this.authz.assert(action, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      ownerUserId: p.userId,
    });
  }

  /**
   * The opportunity of the acting entity the caller may draft on, locked so its stage cannot move under the
   * create: `crm.opportunity.read` reaching it as owner, department or lead creator (FX-Q1, R4a Q4 a). Reading
   * every deal does not count (`draftReachPrincipal` caps it at department), nor does a follow-up assigned to the
   * caller (FX-Q2): that lets them read and complete the follow-up, not start a quotation whose sending moves
   * someone else's deal. The record-check twin is `mayStartQuotationOn` (OpportunityDto.canDraftQuotation). An
   * opportunity out of that reach is a 404 like a missing one.
   */
  private async findOpportunity(
    tx: DbTransaction,
    scope: TxScope,
    principal: Principal,
    id: string,
  ) {
    const [row] = await tx
      .select({
        id: opportunities.id,
        customerId: opportunities.customerId,
        stage: opportunities.stage,
      })
      .from(opportunities)
      .where(
        scoped(scope).where(
          opportunities,
          and(
            eq(opportunities.id, id),
            scopeWhereFor(draftReachPrincipal(principal), opportunities, 'crm.opportunity.read', {
              assignees: false,
            }),
          ),
        ),
      )
      .for('update');
    if (row === undefined) throw opportunityNotFound();
    // Read under the row lock: a draft queued behind Mark Lost sees the committed stage, not the one it started with.
    if (row.stage === 'lost') {
      throw new ConflictException({
        code: 'conflict',
        message: 'This deal is Lost; a quotation cannot be drafted on it',
      });
    }
    return row;
  }

  /** A quotation needs a customers row, not just a party (quotations_customer_fk would answer with a 500). */
  private async assertCustomer(tx: DbTransaction, tenantId: string, id: string): Promise<void> {
    const [row] = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.tenantId, tenantId), eq(customers.id, id)))
      .limit(1);
    if (row === undefined) throw badRequest('The opportunity has no customer record');
  }

  /** The contact must be one of the quotation's customer's; the database checks the tenant only. */
  private async assertContactOf(
    tx: DbTransaction,
    tenantId: string,
    contactId: string,
    customerPartyId: string,
  ): Promise<void> {
    const [row] = await tx
      .select({ customerId: customerContacts.customerId })
      .from(customerContacts)
      .where(and(eq(customerContacts.tenantId, tenantId), eq(customerContacts.id, contactId)))
      .limit(1);
    if (row === undefined || row.customerId !== customerPartyId) {
      throw badRequest("contactId is not a contact of the opportunity's customer");
    }
  }

  private async assertPaymentTerm(tx: DbTransaction, tenantId: string, id: string): Promise<void> {
    const [row] = await tx
      .select({ id: paymentTerms.id })
      .from(paymentTerms)
      .where(and(eq(paymentTerms.tenantId, tenantId), eq(paymentTerms.id, id)))
      .limit(1);
    if (row === undefined) throw badRequest('paymentTermId is not a payment term of this tenant');
  }
}
