// The quotation approval snapshot and the two hashes of a version (Q2). Pure: no database, no clock.
// Serves the NFR "approvals are auditable": the approver sees one frozen snapshot, its hash is stored on the
// approval request and on the version, and the hash of the material fields proves the version was not edited
// after submit. Money stays text; the percentage the approver reads is the stored 4 dp column, never a re-rounded
// fact. The version columns are the freeze list of the database (QUOTATION_VERSION_MATERIAL_COLUMNS), so the hash
// covers exactly what the quotation_versions_guard trigger refuses to change.
import { QuotationApprovalSnapshotSchema, type QuotationApprovalSnapshot } from '@bos/contracts';
import { QUOTATION_VERSION_MATERIAL_COLUMNS, type quotationVersions } from '@bos/db';

import { canonicalSha256 } from '../../../platform/hashing/canonical-json';
import type { PricedLineRow, PricedVersion, TaxSummaryRow } from '../pricing/pricing.types';

type Camel<S extends string> = S extends `${infer Head}_${infer Tail}`
  ? `${Head}${Capitalize<Camel<Tail>>}`
  : S;
/** The two hash columns are outputs of hashing, so they are never part of what is hashed. */
type HashColumn = 'content_sha256' | 'snapshot_sha256';
type MaterialColumn = Exclude<(typeof QUOTATION_VERSION_MATERIAL_COLUMNS)[number], HashColumn>;
type VersionRow = typeof quotationVersions.$inferSelect;

/** The material columns of a version row (camelCase). A full row, or the priced columns merged into one, fits. */
export type MaterialVersionFields = Pick<VersionRow, Camel<MaterialColumn>>;

/** Everything S2 freezes on a version, as one plain object ready for hashing. */
export interface MaterialFields {
  version: MaterialVersionFields;
  lines: PricedLineRow[];
  taxSummary: TaxSummaryRow[];
}

const MATERIAL_KEYS: readonly (keyof MaterialVersionFields)[] =
  QUOTATION_VERSION_MATERIAL_COLUMNS.filter(
    (column): column is MaterialColumn =>
      column !== 'content_sha256' && column !== 'snapshot_sha256',
  ).map(
    (column) =>
      column.replace(/_([a-z0-9])/g, (_match, ch: string) =>
        ch.toUpperCase(),
      ) as keyof MaterialVersionFields,
  );

/**
 * Material columns that were added after versions were already hashed. A NULL one is left out of the hashed
 * object, so a version that never had it hashes to the same bytes as before the column existed; only a value
 * enters the hash. Adding a column here is only safe if NULL means "never set" (nullable, no default).
 */
const OMIT_WHEN_NULL: ReadonlySet<keyof MaterialVersionFields> = new Set(['termsAndConditions']);

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface BuildApprovalSnapshotInput {
  priced: PricedVersion;
  currency: QuotationApprovalSnapshot['currency'];
  customerName: string;
  quotationNumber: string;
  revisionNo: number;
}

/**
 * The snapshot an approver sees, parsed with QuotationApprovalSnapshotSchema (throws ZodError if a field does
 * not fit). The NPR total, the discount percentage (4 dp), the margin and the FX rate come from the priced
 * columns, which are what the version stores; `facts.effectiveDiscountPct` is full precision and is never used.
 * The NPR discount amount and the strict-12% verdict come from the facts, which the columns do not hold.
 */
export function buildApprovalSnapshot(
  input: BuildApprovalSnapshotInput,
): QuotationApprovalSnapshot {
  const { columns, facts } = input.priced;
  return QuotationApprovalSnapshotSchema.parse({
    nprTotal: columns.amountNpr,
    effectiveDiscountPct: columns.effectiveDiscountPct,
    marginPct: facts.marginOutOfRange ? null : columns.marginPct,
    nprDiscountAmount: facts.nprDiscountAmount,
    currency: input.currency,
    fxRate: columns.fxRate,
    customerName: input.customerName,
    quotationNumber: input.quotationNumber,
    revisionNo: input.revisionNo,
    discountApprovalRequired: facts.discountApprovalRequired,
  });
}

/**
 * The material fields of a version: the frozen version columns (without the two hashes), its lines and its tax
 * summary rows. Only the listed fields are copied, so row keys, tenant ids and timestamps cannot leak in, and a
 * non-material column (status, render_state, links, timestamps) cannot change the hash. Lines are ordered by
 * line number and tax rows by tax code id, so the order a query returned them in does not matter.
 */
export function materialFieldsOf(
  version: MaterialVersionFields,
  lines: readonly PricedLineRow[],
  taxSummary: readonly TaxSummaryRow[],
): MaterialFields {
  const picked: Record<string, unknown> = {};
  for (const key of MATERIAL_KEYS) {
    const value = version[key];
    if ((value === null || value === undefined) && OMIT_WHEN_NULL.has(key)) continue;
    picked[key] = value;
  }
  return {
    version: picked as unknown as MaterialVersionFields,
    lines: lines
      .map((l): PricedLineRow => ({
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
      }))
      .sort((a, b) => a.lineNo - b.lineNo),
    taxSummary: taxSummary
      .map((t): TaxSummaryRow => ({
        taxCodeId: t.taxCodeId,
        label: t.label,
        rate: t.rate,
        base: t.base,
        tax: t.tax,
      }))
      .sort((a, b) => compare(a.taxCodeId, b.taxCodeId)),
  };
}

/** quotation_versions.content_sha256: SHA-256 (32 bytes) of the canonical JSON of the material fields. */
export function contentSha256(material: MaterialFields): Buffer {
  return canonicalSha256(material);
}

/** quotation_versions.snapshot_sha256 and approval_requests.snapshot_sha256: SHA-256 (32 bytes) of the snapshot. */
export function snapshotSha256(snapshot: QuotationApprovalSnapshot): Buffer {
  return canonicalSha256(snapshot);
}
