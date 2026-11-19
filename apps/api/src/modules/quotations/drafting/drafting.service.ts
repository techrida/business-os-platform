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
  canReviseQuotation,
  type CreateQuotationBody,
  type DocumentVersionStatus,
  isQuotationEditable,
  type ListQuotationsQuery,
  type Permission,
  type QuotationCapabilities,
  type QuotationDetail,
  type QuotationDto,
  type QuotationListItem,
  type QuotationStatus,
  QuotationVersionContentSchema,
  type QuotationVersionDto,
  type UpdateQuotationDraftBody,
} from '@bos/contracts';
import {
  customerContacts,
  customers,
  documentVersions,
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
import { and, asc, desc, eq, inArray } from 'drizzle-orm';

import { AuditService } from '../../../platform/audit/audit.service';
import { AuthzService, scopeWhereFor } from '../../../platform/authz/authz.service';
import { can, type Principal, type ResourceRef } from '../../../platform/authz/can';
import { DB, type Db, type DbTransaction } from '../../../platform/db/db.module';
import { updateVersioned, withIdempotency } from '../../../platform/db/idempotency';
import { withTx, type Actor, type TxScope } from '../../../platform/db/tx';
import { NumberingService } from '../../../platform/settings/numbering.service';
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
  type QuotationVersionRow,
} from './mapping';

/** A version with its own rows; the parent quotation is added by the caller. */
type VersionWithParts = Omit<QuotationVersionParts, 'quotation'>;

/** Injection token for a test clock; production falls back to the system time. */
export const DRAFTING_CLOCK = Symbol('DRAFTING_CLOCK');

/** The numbering series key; its prefix is `QT`, as in QT-2082/83-00001. */
export const QUOTATION_SERIES = 'QT';

const AUDIT_ENTITY = 'quotations';

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
    paymentSchedule: v.paymentSchedule,
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
 * The record updateDraft() checks `quotation.draft` against: the stored owner, so under `own` scope a
 * colleague's quotation is read-only. One function, so the capability and the command cannot drift.
 */
export function draftRefOf(q: {
  tenantId: string;
  organizationId: string;
  ownerUserId: string | null;
  customerPartyId: string | null;
}): ResourceRef {
  return {
    tenantId: q.tenantId,
    organizationId: q.organizationId,
    ownerUserId: q.ownerUserId,
    customerPartyId: q.customerPartyId,
  };
}

/**
 * What `p` may do with a quotation whose current version has `status`, by the same rules the commands
 * enforce: updateDraft() (Draft or Returned, `quotation.draft` on the record) and ReviseService.revise()
 * (a revisable status, `quotation.revise` on quotationRef()). Pure, so a screen can trust it and a test
 * can check it without a database.
 */
export function capabilitiesOf(
  p: Principal,
  q: Parameters<typeof draftRefOf>[0],
  status: QuotationStatus,
): QuotationCapabilities {
  return {
    canEdit: isQuotationEditable(status) && can(p, 'quotation.draft', draftRefOf(q)).allowed,
    canRevise: canReviseQuotation(status) && can(p, 'quotation.revise', quotationRef(q)).allowed,
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
    @Optional() @Inject(DRAFTING_CLOCK) private readonly clock: () => Date = () => new Date(),
  ) {}

  // ------------------------------------------------------------------------------------------------- create

  /**
   * A quotation on an opportunity of the acting entity, with revision 1 as a priced Draft. The customer is the
   * opportunity's. 404 for an opportunity outside the acting entity; 400 for a contact of another customer, an
   * unknown payment term or tax code, or a discount above the subtotal.
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
          response: await this.createInTx(tx, scope, actor, principal.userId, body, now, mayCost),
        }),
      );
      return done.response;
    });
  }

  private async createInTx(
    tx: DbTransaction,
    scope: TxScope,
    actor: Actor,
    /** The owner: the user the quotation.draft check above approved as owner. */
    ownerUserId: string,
    body: CreateQuotationBody,
    now: Date,
    mayCost: boolean,
  ): Promise<QuotationDto> {
    const opportunity = await this.findOpportunity(tx, scope, body.opportunityId);
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

    // A drafter who may not read costs cannot set them either: a new quotation has no stored cost to keep.
    const priced = await this.pricing.priceVersion(
      tx,
      scope,
      pricingWithAllowedCosts(pricingInputOf(body), mayCost, new Map()),
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
   * The quotations of the acting entity the caller may read, newest first. `status` is the current version's;
   * `opportunityId` keeps one opportunity's quotations (a filter on top of the read scope, never a widening).
   */
  async list(query: ListQuotationsQuery = {}): Promise<QuotationListItem[]> {
    const { scope, actor, principal } = this.caller.current();
    this.assertStaff(principal);
    const { status, opportunityId } = query;
    const visible = scopeWhereFor(principal, quotations, 'quotation.read');
    const where = and(
      visible,
      status === undefined ? undefined : eq(quotationVersions.status, status),
      opportunityId === undefined ? undefined : eq(quotations.opportunityId, opportunityId),
    );
    return withTx(this.db, scope, actor, async (tx) => {
      const rows = await tx
        .select({
          quotation: quotations,
          current: quotationVersions,
          customerName: customers.legalName,
          ownerName: users.displayName,
        })
        .from(quotations)
        .innerJoin(
          quotationVersions,
          and(
            eq(quotationVersions.tenantId, quotations.tenantId),
            eq(quotationVersions.id, quotations.currentVersionId),
          ),
        )
        .innerJoin(
          customers,
          and(
            eq(customers.tenantId, quotations.tenantId),
            eq(customers.id, quotations.customerPartyId),
          ),
        )
        .leftJoin(
          users,
          and(eq(users.tenantId, quotations.tenantId), eq(users.id, quotations.ownerUserId)),
        )
        .where(where)
        .orderBy(desc(quotations.createdAt), desc(quotations.id));
      return rows.map((r) =>
        toQuotationListItem(r.quotation, r.current, {
          customerName: r.customerName,
          ownerName: r.ownerName,
          canEdit: capabilitiesOf(principal, r.quotation, r.current.status).canEdit,
        }),
      );
    });
  }

  /** Every version (Superseded included) with lines, tax summary and scan status, the history and the contacts. */
  async detail(id: string): Promise<QuotationDetail> {
    const { scope, actor, principal } = this.caller.current();
    this.assertStaff(principal);
    return withTx(this.db, scope, actor, async (tx) => {
      const quotation = await this.findVisible(tx, principal, id);
      const versionRows = await tx
        .select()
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
      const answer = toQuotationDetail({
        quotation,
        versions,
        statusHistory,
        customerName: customer.legalName,
        contacts,
        // No current version: toQuotationDetail refuses the answer anyway, so nothing is offered.
        capabilities:
          current === undefined
            ? { canEdit: false, canRevise: false }
            : capabilitiesOf(principal, quotation, current.status),
        people,
      });
      return detailVisibleTo(principal, answer);
    });
  }

  /** One version of a visible quotation; a version of another quotation is a 404 like a missing one. */
  async getVersion(id: string, versionId: string): Promise<QuotationVersionDto> {
    const { scope, actor, principal } = this.caller.current();
    this.assertStaff(principal);
    return withTx(this.db, scope, actor, async (tx) => {
      const quotation = await this.findVisible(tx, principal, id);
      const version = await this.findVersion(tx, quotation, versionId);
      const [parts] = await this.withParts(tx, quotation.tenantId, [version]);
      return versionVisibleTo(principal, toQuotationVersionDto({ ...parts!, quotation }));
    });
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

    // A drafter who may not read costs keeps the stored cost of each line number (the DTO the content was merged
    // from is full, so a body that omits a line's cost must not wipe it) and cannot set one; the margin and the
    // internal cost total are recomputed from those costs.
    const storedCosts = new Map(saved.lines.map((l) => [l.lineNo, l.unitCost ?? null] as const));
    const priced = await this.pricing.priceVersion(
      tx,
      scope,
      pricingWithAllowedCosts(pricingInputOf(content), canReadCost(principal), storedCosts),
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
  ): Promise<QuotationVersionRow> {
    const query = tx
      .select()
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
    versions: readonly QuotationVersionRow[],
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

  /** The opportunity of the acting entity, locked so its stage cannot move under the create. */
  private async findOpportunity(tx: DbTransaction, scope: TxScope, id: string) {
    const [row] = await tx
      .select({ id: opportunities.id, customerId: opportunities.customerId })
      .from(opportunities)
      .where(scoped(scope).where(opportunities, eq(opportunities.id, id)))
      .for('update');
    if (row === undefined) throw opportunityNotFound();
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
