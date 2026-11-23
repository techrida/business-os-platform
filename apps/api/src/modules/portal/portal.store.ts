// The portal's reads on the real tables. Every query is limited by `scopeWhereFor(p, quotations,
// 'portal.quotation.read')`, the SQL twin of `can()`: for a customer at `customer_org` that is the tenant, the
// acting entity and `quotations.customer_party_id = p.partyId` (ADR 0027 §5), and for anyone else it matches nothing.
// No hand-written party filter: the kernel helper recognises `customerPartyId` as the counterparty column.
// Versions are joined to their quotation on tenant, entity and id, so a version is reachable only through a
// quotation the caller may read. Which version a customer may see is the service's rule; the status filter in the
// list query is only a narrowing, never the authority.
import { CUSTOMER_VISIBLE_STATUSES, type EvidenceKind } from '@bos/contracts';
import {
  customerContacts,
  customers,
  organizations,
  paymentTerms,
  quotationAcceptances,
  quotationEvidenceConfirmations,
  quotationLines,
  quotations,
  quotationTaxSummary,
  quotationVersions,
  salesOrders,
} from '@bos/db';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, exists, inArray, isNotNull } from 'drizzle-orm';

import { scopeWhereFor } from '../../platform/authz/authz.service';
import type { Principal } from '../../platform/authz/principal';
import { DB, type Db, type DbTransaction } from '../../platform/db/db.module';
import type { CustomerViewInput } from '../quotations/render/customer-view';

type VersionRow = typeof quotationVersions.$inferSelect;

/** One version of a quotation the caller may read: what the list shows and what decides visibility. */
export type PortalVersionHead = Pick<
  VersionRow,
  'revisionNo' | 'status' | 'rejectionSource' | 'issueDate' | 'validUntil' | 'currency' | 'total'
> & {
  versionId: string;
  quotationId: string;
  number: string;
  /** When the version was sent to the customer; null if never. Read by the respond path only. */
  sentAt?: Date | null;
};

/**
 * Everything the customer view is built from, except the issuer block (read from settings), the PDF state flags and the
 * display (built by the service from `documentStyle`, else from settings).
 */
export type PortalViewSource = Omit<
  CustomerViewInput,
  'issuer' | 'renderedScanClean' | 'renderFailed' | 'display'
> & {
  issuerLegalName: string;
  /** The version's stored `document_style` as read (unchecked); null until its first render froze it. */
  documentStyle: unknown;
  /** Failed render tries since the last success or Retry: with render_state, tells a given-up render apart. */
  renderAttempts: number;
  /** When the version was sent to the customer; null if never. A cancelled version that was sent shows "no longer open". */
  sentAt: Date | null;
  /**
   * True when the quotation's newest version is cancelled (a Lost deal or a cancel). A mailed link to an older, sent
   * version of such a quotation shows "no longer open", not "not found" (R6D).
   */
  quotationCancelled: boolean;
};

/**
 * What the PDF link needs of one version: whether the customer may see it, which rendered document it holds, and the
 * tenant and entity the QUOTATION lives in. The link is scoped by these two ids, read from the row, never taken from
 * the caller.
 */
export type PortalDocumentHead = Pick<
  VersionRow,
  'status' | 'rejectionSource' | 'renderState' | 'renderAttempts'
> & {
  tenantId: string;
  organizationId: string;
  renderedDocumentId: string | null;
};

export interface PortalQuotationStore {
  /** Every version, in a customer-visible status, of every quotation `p` may read. */
  listVersions(p: Principal): Promise<PortalVersionHead[]>;
  /** One version of a quotation `p` may read, whatever its status; undefined when out of reach or unknown. */
  loadView(p: Principal, versionId: string): Promise<PortalViewSource | undefined>;
  /** The document head of one version of a quotation `p` may read, whatever its status; undefined when out of reach. */
  loadDocumentHead(p: Principal, versionId: string): Promise<PortalDocumentHead | undefined>;
  /**
   * The acceptance of one version of a quotation `p` may read and whether staff confirmed its evidence (F1-Q28), by
   * a confirmation row or by confirming an order of the version; undefined when out of reach or not accepted.
   */
  loadAcceptance(p: Principal, versionId: string): Promise<PortalAcceptance | undefined>;
}

export interface PortalAcceptance {
  actorKind: 'staff' | 'customer_user';
  evidenceKinds: EvidenceKind[];
  /**
   * Staff confirmed the evidence: a quotation_evidence_confirmations row exists, or an order of the version was
   * confirmed (confirmed_at set, even if later cancelled). Orders confirmed before confirmations existed stand on
   * acceptances with no confirmation row; confirm now refuses until the row exists, so new orders never rely on this.
   */
  confirmed: boolean;
}

export const PORTAL_QUOTATION_STORE = Symbol('PORTAL_QUOTATION_STORE');

const ACTION = 'portal.quotation.read' as const;

/**
 * The read behind accept and reject (P2 unit PA-3): one version head of a quotation `p` may answer, scoped by
 * `portal.quotation.respond` the same way the reads are scoped by `portal.quotation.read`. It runs on the caller's
 * transaction, so the check and the answer see the same rows; QuotationOutcomeService then locks and re-checks.
 */
export interface PortalRespondStore {
  /** The head of one version of a quotation `p` may answer, whatever its status; undefined when out of reach. */
  findHead(
    tx: DbTransaction,
    p: Principal,
    versionId: string,
  ): Promise<PortalVersionHead | undefined>;
}

export const PORTAL_RESPOND_STORE = Symbol('PORTAL_RESPOND_STORE');

const RESPOND_ACTION = 'portal.quotation.respond' as const;

/** Versions joined to the quotation they belong to, in the same tenant and entity. */
const versionOfQuotation = and(
  eq(quotations.tenantId, quotationVersions.tenantId),
  eq(quotations.organizationId, quotationVersions.organizationId),
  eq(quotations.id, quotationVersions.quotationId),
);

/** Versions of a quotation `p` may read, as heads; shared by the list and the respond read. */
const headColumns = {
  versionId: quotationVersions.id,
  quotationId: quotationVersions.quotationId,
  number: quotations.number,
  revisionNo: quotationVersions.revisionNo,
  status: quotationVersions.status,
  rejectionSource: quotationVersions.rejectionSource,
  issueDate: quotationVersions.issueDate,
  validUntil: quotationVersions.validUntil,
  currency: quotationVersions.currency,
  total: quotationVersions.total,
  sentAt: quotationVersions.sentAt,
};

@Injectable()
export class DrizzlePortalRespondStore implements PortalRespondStore {
  async findHead(
    tx: DbTransaction,
    p: Principal,
    versionId: string,
  ): Promise<PortalVersionHead | undefined> {
    const [head] = await tx
      .select(headColumns)
      .from(quotationVersions)
      .innerJoin(quotations, versionOfQuotation)
      .where(and(scopeWhereFor(p, quotations, RESPOND_ACTION), eq(quotationVersions.id, versionId)))
      .limit(1);
    return head;
  }
}

@Injectable()
export class DrizzlePortalQuotationStore implements PortalQuotationStore {
  constructor(@Inject(DB) private readonly db: Db) {}

  async listVersions(p: Principal): Promise<PortalVersionHead[]> {
    return this.db
      .select(headColumns)
      .from(quotationVersions)
      .innerJoin(quotations, versionOfQuotation)
      .where(
        and(
          scopeWhereFor(p, quotations, ACTION),
          inArray(quotationVersions.status, [...CUSTOMER_VISIBLE_STATUSES]),
        ),
      );
  }

  async loadDocumentHead(p: Principal, versionId: string): Promise<PortalDocumentHead | undefined> {
    const [head] = await this.db
      .select({
        tenantId: quotationVersions.tenantId,
        organizationId: quotationVersions.organizationId,
        status: quotationVersions.status,
        rejectionSource: quotationVersions.rejectionSource,
        renderState: quotationVersions.renderState,
        renderAttempts: quotationVersions.renderAttempts,
        renderedDocumentId: quotationVersions.renderedDocumentId,
      })
      .from(quotationVersions)
      .innerJoin(quotations, versionOfQuotation)
      .where(and(scopeWhereFor(p, quotations, ACTION), eq(quotationVersions.id, versionId)))
      .limit(1);
    return head;
  }

  async loadAcceptance(p: Principal, versionId: string): Promise<PortalAcceptance | undefined> {
    const [row] = await this.db
      .select({
        actorKind: quotationAcceptances.actorKind,
        evidenceKinds: quotationAcceptances.evidenceKinds,
        confirmationId: quotationEvidenceConfirmations.id,
        orderConfirmed: exists(
          this.db
            .select({ id: salesOrders.id })
            .from(salesOrders)
            .where(
              and(
                eq(salesOrders.tenantId, quotationAcceptances.tenantId),
                eq(salesOrders.organizationId, quotationVersions.organizationId),
                eq(salesOrders.quotationVersionId, quotationAcceptances.versionId),
                isNotNull(salesOrders.confirmedAt),
              ),
            ),
        ).mapWith(Boolean),
      })
      .from(quotationAcceptances)
      .innerJoin(
        quotationVersions,
        and(
          eq(quotationVersions.tenantId, quotationAcceptances.tenantId),
          eq(quotationVersions.id, quotationAcceptances.versionId),
        ),
      )
      .innerJoin(quotations, versionOfQuotation)
      .leftJoin(
        quotationEvidenceConfirmations,
        and(
          eq(quotationEvidenceConfirmations.tenantId, quotationAcceptances.tenantId),
          eq(quotationEvidenceConfirmations.versionId, quotationAcceptances.versionId),
        ),
      )
      .where(
        and(
          scopeWhereFor(p, quotations, ACTION),
          eq(quotationAcceptances.versionId, versionId),
          eq(quotationAcceptances.outcome, 'accepted'),
        ),
      )
      .limit(1);
    if (row === undefined) return undefined;
    return {
      actorKind: row.actorKind,
      evidenceKinds: row.evidenceKinds,
      confirmed: row.confirmationId !== null || row.orderConfirmed,
    };
  }

  async loadView(p: Principal, versionId: string): Promise<PortalViewSource | undefined> {
    const [head] = await this.db
      .select({
        version: {
          id: quotationVersions.id,
          revisionNo: quotationVersions.revisionNo,
          status: quotationVersions.status,
          rejectionSource: quotationVersions.rejectionSource,
          currency: quotationVersions.currency,
          issueDate: quotationVersions.issueDate,
          validUntil: quotationVersions.validUntil,
          scope: quotationVersions.scope,
          assumptions: quotationVersions.assumptions,
          exclusions: quotationVersions.exclusions,
          termsAndConditions: quotationVersions.termsAndConditions,
          deliveryTimeline: quotationVersions.deliveryTimeline,
          paymentSchedule: quotationVersions.paymentSchedule,
          subtotal: quotationVersions.subtotal,
          discountAmount: quotationVersions.discountAmount,
          taxableAmount: quotationVersions.taxableAmount,
          taxAmount: quotationVersions.taxAmount,
          total: quotationVersions.total,
          renderState: quotationVersions.renderState,
          renderedDocumentId: quotationVersions.renderedDocumentId,
          renderedSha256: quotationVersions.renderedSha256,
        },
        documentStyle: quotationVersions.documentStyle,
        renderAttempts: quotationVersions.renderAttempts,
        sentAt: quotationVersions.sentAt,
        contactId: quotationVersions.contactId,
        paymentTermId: quotationVersions.paymentTermId,
        tenantId: quotationVersions.tenantId,
        organizationId: quotationVersions.organizationId,
        number: quotations.number,
        customerPartyId: quotations.customerPartyId,
        currentVersionId: quotations.currentVersionId,
      })
      .from(quotationVersions)
      .innerJoin(quotations, versionOfQuotation)
      .where(and(scopeWhereFor(p, quotations, ACTION), eq(quotationVersions.id, versionId)))
      .limit(1);
    if (head === undefined || head.customerPartyId === null) return undefined;
    const { tenantId, organizationId, customerPartyId } = head;

    // Only an older version needs this: the newest version's own status already says it.
    let quotationCancelled = false;
    if (head.currentVersionId !== null && head.currentVersionId !== versionId) {
      const [current] = await this.db
        .select({ status: quotationVersions.status })
        .from(quotationVersions)
        .where(
          and(
            eq(quotationVersions.tenantId, tenantId),
            eq(quotationVersions.id, head.currentVersionId),
          ),
        )
        .limit(1);
      quotationCancelled = current?.status === 'cancelled';
    }

    const [customer] = await this.db
      .select({
        legalName: customers.legalName,
        panVatNo: customers.panVatNo,
        // FX9: the party's country and the address's street lines and city; the view maps them to its party block.
        country: customers.country,
        addressLine: customers.addressLine,
        addressCity: customers.addressCity,
      })
      .from(customers)
      .where(and(eq(customers.tenantId, tenantId), eq(customers.id, customerPartyId)))
      .limit(1);
    if (customer === undefined) return undefined;

    let contact: PortalViewSource['contact'] = null;
    if (head.contactId !== null) {
      [contact = null] = await this.db
        .select({ fullName: customerContacts.fullName, emailNorm: customerContacts.emailNorm })
        .from(customerContacts)
        .where(
          and(eq(customerContacts.tenantId, tenantId), eq(customerContacts.id, head.contactId)),
        )
        .limit(1);
    }
    let paymentTerm: PortalViewSource['paymentTerm'] = null;
    if (head.paymentTermId !== null) {
      [paymentTerm = null] = await this.db
        .select({ name: paymentTerms.name })
        .from(paymentTerms)
        .where(and(eq(paymentTerms.tenantId, tenantId), eq(paymentTerms.id, head.paymentTermId)))
        .limit(1);
    }

    const lines = await this.db
      .select({
        lineNo: quotationLines.lineNo,
        description: quotationLines.description,
        uom: quotationLines.uom,
        quantity: quotationLines.quantity,
        unitPrice: quotationLines.unitPrice,
        gross: quotationLines.gross,
      })
      .from(quotationLines)
      .where(
        and(
          eq(quotationLines.tenantId, tenantId),
          eq(quotationLines.organizationId, organizationId),
          eq(quotationLines.versionId, versionId),
        ),
      )
      .orderBy(asc(quotationLines.lineNo));
    const taxSummary = await this.db
      .select({
        label: quotationTaxSummary.label,
        rate: quotationTaxSummary.rate,
        base: quotationTaxSummary.base,
        tax: quotationTaxSummary.tax,
      })
      .from(quotationTaxSummary)
      .where(
        and(
          eq(quotationTaxSummary.tenantId, tenantId),
          eq(quotationTaxSummary.organizationId, organizationId),
          eq(quotationTaxSummary.versionId, versionId),
        ),
      );

    const [issuer] = await this.db
      .select({ legalName: organizations.legalName })
      .from(organizations)
      .where(and(eq(organizations.tenantId, tenantId), eq(organizations.id, organizationId)))
      .limit(1);
    if (issuer === undefined) return undefined;

    return {
      version: head.version,
      quotation: { number: head.number },
      customer,
      contact,
      paymentTerm,
      lines,
      taxSummary,
      issuerLegalName: issuer.legalName,
      documentStyle: head.documentStyle,
      renderAttempts: head.renderAttempts,
      sentAt: head.sentAt,
      quotationCancelled,
    };
  }
}
