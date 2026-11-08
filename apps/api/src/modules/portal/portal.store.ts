// The portal's reads on the real tables. Every query is limited by `scopeWhereFor(p, quotations,
// 'portal.quotation.read')`, the SQL twin of `can()`: for a customer at `customer_org` that is the tenant, the
// acting entity and `quotations.customer_party_id = p.partyId` (ADR 0027 §5), and for anyone else it matches nothing.
// No hand-written party filter: the kernel helper recognises `customerPartyId` as the counterparty column.
// Versions are joined to their quotation on tenant, entity and id, so a version is reachable only through a
// quotation the caller may read. Which version a customer may see is the service's rule; the status filter in the
// list query is only a narrowing, never the authority.
import { CUSTOMER_VISIBLE_STATUSES } from '@bos/contracts';
import {
  customerContacts,
  customers,
  organizations,
  paymentTerms,
  quotationLines,
  quotations,
  quotationTaxSummary,
  quotationVersions,
} from '@bos/db';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';

import { scopeWhereFor } from '../../platform/authz/authz.service';
import type { Principal } from '../../platform/authz/principal';
import { DB, type Db } from '../../platform/db/db.module';
import type { CustomerViewInput } from '../quotations/render/customer-view';

type VersionRow = typeof quotationVersions.$inferSelect;

/** One version of a quotation the caller may read: what the list shows and what decides visibility. */
export type PortalVersionHead = Pick<
  VersionRow,
  'revisionNo' | 'status' | 'rejectionSource' | 'issueDate' | 'validUntil' | 'currency' | 'total'
> & { versionId: string; quotationId: string; number: string };

/** Everything the customer view is built from, except the issuer block (read from settings) and the scan flag. */
export type PortalViewSource = Omit<CustomerViewInput, 'issuer' | 'renderedScanClean'> & {
  issuerLegalName: string;
};

export interface PortalQuotationStore {
  /** Every version, in a customer-visible status, of every quotation `p` may read. */
  listVersions(p: Principal): Promise<PortalVersionHead[]>;
  /** One version of a quotation `p` may read, whatever its status; undefined when out of reach or unknown. */
  loadView(p: Principal, versionId: string): Promise<PortalViewSource | undefined>;
}

export const PORTAL_QUOTATION_STORE = Symbol('PORTAL_QUOTATION_STORE');

const ACTION = 'portal.quotation.read' as const;

/** Versions joined to the quotation they belong to, in the same tenant and entity. */
const versionOfQuotation = and(
  eq(quotations.tenantId, quotationVersions.tenantId),
  eq(quotations.organizationId, quotationVersions.organizationId),
  eq(quotations.id, quotationVersions.quotationId),
);

@Injectable()
export class DrizzlePortalQuotationStore implements PortalQuotationStore {
  constructor(@Inject(DB) private readonly db: Db) {}

  async listVersions(p: Principal): Promise<PortalVersionHead[]> {
    return this.db
      .select({
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
      })
      .from(quotationVersions)
      .innerJoin(quotations, versionOfQuotation)
      .where(
        and(
          scopeWhereFor(p, quotations, ACTION),
          inArray(quotationVersions.status, [...CUSTOMER_VISIBLE_STATUSES]),
        ),
      );
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
        contactId: quotationVersions.contactId,
        paymentTermId: quotationVersions.paymentTermId,
        tenantId: quotationVersions.tenantId,
        organizationId: quotationVersions.organizationId,
        number: quotations.number,
        customerPartyId: quotations.customerPartyId,
      })
      .from(quotationVersions)
      .innerJoin(quotations, versionOfQuotation)
      .where(and(scopeWhereFor(p, quotations, ACTION), eq(quotationVersions.id, versionId)))
      .limit(1);
    if (head === undefined || head.customerPartyId === null) return undefined;
    const { tenantId, organizationId, customerPartyId } = head;

    const [customer] = await this.db
      .select({
        legalName: customers.legalName,
        panVatNo: customers.panVatNo,
        address: customers.address,
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
    };
  }
}
