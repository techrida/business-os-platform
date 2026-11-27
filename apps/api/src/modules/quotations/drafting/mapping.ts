// Maps quotation rows (packages/db/src/schema/quotations.ts) to the contract DTOs of @bos/contracts. Pure functions:
// no database, no clock. Serves the NFR "amounts are exact": money, quantities, rates and percentages stay the
// strings the database returned (never Number), and a bytea hash leaves as lower-case hex.
// The status of a quotation is never stored; the caller passes the status of its current version.
// The scan status of the rendered PDF lives on document_versions, so the caller reads it and passes it in
// (`renderedScanStatus`); this file never guesses it.
import {
  PaymentMilestoneSchema,
  type DocumentVersionStatus,
  type Discount,
  type NprSnapshot,
  type PersonName,
  type QuotationContact,
  type QuotationDetail,
  type QuotationDto,
  type QuotationLead,
  type QuotationLineDto,
  type QuotationCapabilities,
  type QuotationListItem,
  type QuotationStatus,
  type QuotationStatusHistoryDto,
  type QuotationTaxSummaryItem,
  type QuotationVersionDto,
} from '@bos/contracts';
import type {
  customerContacts,
  quotationLines,
  quotations,
  quotationStatusHistory,
  quotationTaxSummary,
} from '@bos/db';
import { quotationVersions } from '@bos/db';
import { getTableColumns } from 'drizzle-orm';

import { quotationRenderGivenUp } from '../render/render-retry';
import { paymentScheduleAmounts } from './payment-schedule';

export type QuotationRow = typeof quotations.$inferSelect;
export type QuotationVersionRow = typeof quotationVersions.$inferSelect;
/**
 * A version without its document style: the snapshot a render job captures, which can hold a company logo of
 * tens of kilobytes. No DTO of this module reads it, so the reads leave it in the database.
 */
export type QuotationVersionBody = Omit<QuotationVersionRow, 'documentStyle'>;
const { documentStyle: _documentStyle, ...versionBodyColumns } = getTableColumns(quotationVersions);
/** The select list of a `QuotationVersionBody`: every version column except `document_style`. */
export const QUOTATION_VERSION_BODY_COLUMNS = versionBodyColumns;
/** The four figures of the current version the list shows (plus the status behind `status`). */
export type QuotationListVersion = Pick<
  QuotationVersionRow,
  'status' | 'currency' | 'total' | 'validUntil'
>;
export type QuotationLineRow = typeof quotationLines.$inferSelect;
export type QuotationTaxSummaryRow = typeof quotationTaxSummary.$inferSelect;
export type QuotationStatusHistoryRow = typeof quotationStatusHistory.$inferSelect;
export type QuotationContactRow = Pick<
  typeof customerContacts.$inferSelect,
  'id' | 'fullName' | 'emailNorm'
>;

/** A version with the rows that belong to it, as a service reads them. */
export interface QuotationVersionParts {
  /** The parent: the number and the customer are the parent's, not the version's. */
  quotation: Pick<QuotationRow, 'number' | 'customerPartyId'>;
  version: QuotationVersionBody;
  lines: readonly QuotationLineRow[];
  taxSummary: readonly QuotationTaxSummaryRow[];
  /** The scan status of the rendered PDF's document version; null when no PDF is rendered. */
  renderedScanStatus: DocumentVersionStatus | null;
}

const iso = (d: Date): string => d.toISOString();
const isoOrNull = (d: Date | null): string | null => (d === null ? null : d.toISOString());
const hex = (b: Uint8Array | null): string | null =>
  b === null ? null : Buffer.from(b).toString('hex');

/**
 * Drops trailing zeros of a decimal string but keeps at least `minFraction` decimals: "12.5000" is "12.5" at 0
 * and "50.0000" is "50.00" at 2. Text only, never through a number, so no digit can be lost.
 */
function trimFraction(value: string, minFraction: number): string {
  const [whole = '0', fraction = ''] = value.split('.');
  let kept = fraction.replace(/0+$/, '');
  if (kept.length < minFraction) kept = kept.padEnd(minFraction, '0');
  return kept === '' ? whole : `${whole}.${kept}`;
}

function customerOf(quotation: Pick<QuotationRow, 'number' | 'customerPartyId'>): string {
  if (quotation.customerPartyId === null) {
    throw new Error(`quotation ${quotation.number} has no customer`);
  }
  return quotation.customerPartyId;
}

function currentVersionOf(quotation: Pick<QuotationRow, 'number' | 'currentVersionId'>): string {
  if (quotation.currentVersionId === null) {
    throw new Error(`quotation ${quotation.number} has no current version`);
  }
  return quotation.currentVersionId;
}

function discountOf(v: QuotationVersionBody): Discount | null {
  if (v.discountMode === null || v.discountInput === null) return null;
  // A percentage is typed as a bare number; an amount is money, which the contract holds to two decimals.
  return v.discountMode === 'pct'
    ? { mode: 'pct', value: trimFraction(v.discountInput, 0) }
    : { mode: 'amount', value: trimFraction(v.discountInput, 2) };
}

/** Only a foreign-currency version with a frozen rate has one; an NPR document is its own NPR value. */
function nprSnapshotOf(v: QuotationVersionBody): NprSnapshot | null {
  if (
    v.currency === 'NPR' ||
    v.fxRate === null ||
    v.fxSource === null ||
    v.fxDate === null ||
    v.amountNpr === null
  ) {
    return null;
  }
  return { amountNpr: v.amountNpr, rate: v.fxRate, rateSource: v.fxSource, rateDate: v.fxDate };
}

function toLineDto(l: QuotationLineRow): QuotationLineDto {
  return {
    lineNo: l.lineNo,
    catalogItemId: l.catalogItemId,
    description: l.description,
    uom: l.uom,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    unitCost: l.unitCost,
    taxCodeId: l.taxCodeId,
    gross: l.gross,
    discountAlloc: l.discountAlloc,
    taxable: l.taxable,
  };
}

function toTaxSummaryItem(t: QuotationTaxSummaryRow): QuotationTaxSummaryItem {
  return { taxCodeId: t.taxCodeId, label: t.label, rate: t.rate, base: t.base, tax: t.tax };
}

export function toQuotationVersionDto(parts: QuotationVersionParts): QuotationVersionDto {
  const { quotation, version: v } = parts;
  return {
    id: v.id,
    quotationId: v.quotationId,
    number: quotation.number,
    revisionNo: v.revisionNo,
    status: v.status,
    rejectionSource: v.rejectionSource,
    customerId: customerOf(quotation),
    contactId: v.contactId,
    templateId: v.templateId,
    currency: v.currency as QuotationVersionDto['currency'],
    issueDate: v.issueDate,
    validUntil: v.validUntil,
    scope: v.scope,
    assumptions: v.assumptions,
    exclusions: v.exclusions,
    termsAndConditions: v.termsAndConditions,
    deliveryTimeline: v.deliveryTimeline,
    paymentTermId: v.paymentTermId,
    // jsonb is untyped: check it against the contract instead of casting. It holds no amounts (D36): the API
    // splits the stored total over the milestones, so every screen, the PDF and the portal read the same figures.
    paymentSchedule: paymentScheduleAmounts(
      v.total,
      PaymentMilestoneSchema.array().parse(v.paymentSchedule),
    ),
    discount: discountOf(v),
    lines: [...parts.lines].sort((a, b) => a.lineNo - b.lineNo).map(toLineDto),
    taxSummary: parts.taxSummary.map(toTaxSummaryItem),
    totals: {
      subtotal: v.subtotal,
      discountAmount: v.discountAmount,
      taxableAmount: v.taxableAmount,
      taxAmount: v.taxAmount,
      total: v.total,
      effectiveDiscountPct: v.effectiveDiscountPct,
    },
    internalCostTotal: v.internalCostTotal,
    marginPct: v.marginPct,
    nprSnapshot: nprSnapshotOf(v),
    approvalRequestId: v.approvalRequestId,
    snapshotSha256: hex(v.snapshotSha256),
    renderedDocumentId: v.renderedDocumentId,
    renderedSha256: hex(v.renderedSha256),
    renderedScanStatus: parts.renderedScanStatus,
    // Only an approved version is rendered (and retried); any other status never offers a Retry.
    renderFailed: v.status === 'approved' && quotationRenderGivenUp(v),
    supersedesVersionId: v.supersedesVersionId,
    supersededByVersionId: v.supersededByVersionId,
    revisionReason: v.revisionReason,
    cancelReason: v.cancelReason,
    submittedAt: isoOrNull(v.submittedAt),
    approvedAt: isoOrNull(v.approvedAt),
    sentAt: isoOrNull(v.sentAt),
    acceptedAt: isoOrNull(v.acceptedAt),
    rejectedAt: isoOrNull(v.rejectedAt),
    expiredAt: isoOrNull(v.expiredAt),
    cancelledAt: isoOrNull(v.cancelledAt),
    version: v.version,
    createdAt: iso(v.createdAt),
    updatedAt: iso(v.updatedAt),
  };
}

/** The parent. `currentStatus` is the status of its current version (never stored twice). */
export function toQuotationDto(q: QuotationRow, currentStatus: QuotationStatus): QuotationDto {
  return {
    id: q.id,
    number: q.number,
    customerId: customerOf(q),
    opportunityId: q.opportunityId,
    currentVersionId: currentVersionOf(q),
    ownerUserId: q.ownerUserId,
    status: currentStatus,
    version: q.version,
    createdAt: iso(q.createdAt),
    updatedAt: iso(q.updatedAt),
  };
}

/**
 * One row of the list: the parent plus its current version's figures, the two names the list shows
 * and whether the caller may edit it now (decided by the service).
 */
export function toQuotationListItem(
  q: QuotationRow,
  current: QuotationListVersion,
  names: {
    customerName: string;
    ownerName: string | null;
    ownerAvatarDocumentId?: string | null;
    canEdit: boolean;
  },
): QuotationListItem {
  return {
    ...toQuotationDto(q, current.status),
    customerName: names.customerName,
    currency: current.currency as QuotationListItem['currency'],
    total: current.total,
    validUntil: current.validUntil,
    ownerName: names.ownerName,
    ownerAvatarDocumentId: names.ownerAvatarDocumentId ?? null,
    canEdit: names.canEdit,
  };
}

function toStatusHistoryDto(h: QuotationStatusHistoryRow): QuotationStatusHistoryDto {
  return {
    versionId: h.versionId,
    fromStatus: h.fromStatus,
    toStatus: h.toStatus,
    actorId: h.actorId,
    reason: h.reason,
    at: iso(h.at),
  };
}

/** A contact the send dialog can offer; one without an email is shown there as unusable. */
function toContact(c: QuotationContactRow): QuotationContact {
  return { id: c.id, name: c.fullName, email: c.emailNorm };
}

export interface QuotationDetailParts {
  quotation: QuotationRow;
  /** Every version, Superseded included, each with its own lines, tax summary and scan status. */
  versions: readonly Omit<QuotationVersionParts, 'quotation'>[];
  statusHistory: readonly QuotationStatusHistoryRow[];
  customerName: string;
  contacts: readonly QuotationContactRow[];
  /** What the caller may do now, decided by the service from the current version and its grants. */
  capabilities: QuotationCapabilities;
  /** The people the quotation names, by display name (owner, history actors). */
  people?: readonly PersonName[];
  /** The lead behind the opportunity (D35), only when the caller may read it; undefined = none or hidden (key omitted). */
  lead?: QuotationLead;
}

/** `GET /v1/quotations/:id`. Versions run oldest first, history in the order it happened. */
export function toQuotationDetail(parts: QuotationDetailParts): QuotationDetail {
  const { quotation } = parts;
  const versions = [...parts.versions].sort((a, b) => a.version.revisionNo - b.version.revisionNo);
  const currentId = currentVersionOf(quotation);
  const current = versions.find((p) => p.version.id === currentId);
  if (current === undefined) {
    throw new Error(
      `quotation ${quotation.number}: current version ${currentId} is not among its versions`,
    );
  }
  return {
    quotation: toQuotationDto(quotation, current.version.status),
    versions: versions.map((p) => toQuotationVersionDto({ ...p, quotation })),
    statusHistory: [...parts.statusHistory]
      .sort((a, b) => a.at.getTime() - b.at.getTime())
      .map(toStatusHistoryDto),
    customerName: parts.customerName,
    contacts: parts.contacts.map(toContact),
    capabilities: { ...parts.capabilities },
    ...(parts.people === undefined ? {} : { people: [...parts.people] }),
    ...(parts.lead === undefined ? {} : { lead: parts.lead }),
  };
}
