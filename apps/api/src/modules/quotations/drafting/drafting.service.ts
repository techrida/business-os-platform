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
// list, detail and getVersion arrive in Part 2, updateDraft in Part 3.
import {
  type CreateQuotationBody,
  type Permission,
  type QuotationDetail,
  type QuotationDto,
  type QuotationListItem,
  type QuotationStatus,
  type QuotationVersionDto,
  type UpdateQuotationDraftBody,
} from '@bos/contracts';
import {
  customerContacts,
  customers,
  opportunities,
  paymentTerms,
  quotationLines,
  quotations,
  quotationStatusHistory,
  quotationTaxSummary,
  quotationVersions,
  scoped,
} from '@bos/db';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  NotImplementedException,
  Optional,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { AuditService } from '../../../platform/audit/audit.service';
import { AuthzService } from '../../../platform/authz/authz.service';
import { type Principal } from '../../../platform/authz/can';
import { DB, type Db, type DbTransaction } from '../../../platform/db/db.module';
import { withIdempotency } from '../../../platform/db/idempotency';
import { withTx, type Actor, type TxScope } from '../../../platform/db/tx';
import { NumberingService } from '../../../platform/settings/numbering.service';
import { PricingService } from '../pricing/pricing.service';
import type { PricingInput } from '../pricing/pricing.types';
import { DraftingCaller } from './drafting.caller';
import { toQuotationDto } from './mapping';

/** Injection token for a test clock; production falls back to the system time. */
export const DRAFTING_CLOCK = Symbol('DRAFTING_CLOCK');

/** The numbering series key; its prefix is `QT`, as in QT-2082/83-00001. */
export const QUOTATION_SERIES = 'QT';

const AUDIT_ENTITY = 'quotations';

const opportunityNotFound = () =>
  new NotFoundException({ code: 'not_found', message: 'Opportunity not found' });

const badRequest = (message: string) => new BadRequestException({ code: 'bad_request', message });

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
    return withTx(this.db, scope, actor, async (tx) => {
      const done = await withIdempotency(
        tx,
        { command: 'quotation.create', key: idempotencyKey, body },
        async () => ({ status: 201, response: await this.createInTx(tx, scope, actor, body, now) }),
      );
      return done.response;
    });
  }

  private async createInTx(
    tx: DbTransaction,
    scope: TxScope,
    actor: Actor,
    body: CreateQuotationBody,
    now: Date,
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

    const priced = await this.pricing.priceVersion(tx, scope, pricingInputOf(body));
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
        ownerUserId: actor.kind === 'user' ? actor.id : null,
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

  // ------------------------------------------------------------------------------------- later parts (stubs)

  list(status?: QuotationStatus): Promise<QuotationListItem[]> {
    void status;
    return Promise.reject(new NotImplementedException('DraftingService.list (Q1b-B part 2)'));
  }

  detail(id: string): Promise<QuotationDetail> {
    void id;
    return Promise.reject(new NotImplementedException('DraftingService.detail (Q1b-B part 2)'));
  }

  getVersion(id: string, versionId: string): Promise<QuotationVersionDto> {
    void id;
    void versionId;
    return Promise.reject(new NotImplementedException('DraftingService.getVersion (Q1b-B part 2)'));
  }

  updateDraft(
    id: string,
    versionId: string,
    body: UpdateQuotationDraftBody,
  ): Promise<{ version: number }> {
    void id;
    void versionId;
    void body;
    return Promise.reject(
      new NotImplementedException('DraftingService.updateDraft (Q1b-B part 3)'),
    );
  }

  // ----------------------------------------------------------------------------------------------- helpers

  /**
   * Quotations are drafted by staff only (a portal user holding the key by mistake is still refused), and the
   * caller becomes the owner, so the record checked is "a quotation of the acting entity owned by the caller".
   */
  private assertMayDraft(p: Principal, scope: TxScope): void {
    if (p.orgKind !== 'staff') {
      throw new ForbiddenException({
        code: 'forbidden',
        message: 'Forbidden',
        reason: 'no_permission',
      });
    }
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
