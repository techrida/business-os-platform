// Drizzle tables for migration 0035_payables: the payables half of P4 (vendor bills and their lines, the portal
// bill inbox, three-way match results and match exceptions, payment requests and their lines) and the view
// v_po_line_progress. Money is numeric(18,2), quantities numeric(18,4) and FX rates numeric(18,6), read as strings;
// wrap them in decimal.js, never Number().
// The SQL in migrations/0035_payables.sql is the source of truth; this file only types the queries, so keep the two
// in step (a change is a new migration, never an edit of an old one). payables-schema.test.ts compares their names.
// All seven tables are entity-owned: a FK into another entity-owned table is (tenant_id, organization_id, x), a FK
// into a tenant-level table (users, parties, tax_codes, withholding_codes, vendor_bank_accounts) is (tenant_id, x).
// No paid or balance column anywhere (P4 done check 10): what is owed is open_item_balances (ledger.ts).
// Not modelled here: the FK 0035 adds to vendor_accounts.default_withholding_code_id (vendors.ts mirrors 0032).
// No FK (no table yet): vendor_bill_lines.account_id, cost_center_id, project_id; payment_requests.from_bank_account_id.
import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type PgTableExtraConfigValue,
} from 'drizzle-orm/pg-core';

import { approvalRequests } from './approvals.js';
import { documents } from './documents.js';
import { users } from './identity.js';
import { openItems, withholdingCodes } from './ledger.js';
import { appSchema, organizations, parties, tenants } from './platform.js';
import { purchaseOrderLines, purchaseOrders, receiptLines } from './procurement-orders.js';
import { taxCodes } from './quotations.js';
import { vendorAccounts, vendorBankAccounts } from './vendors.js';

// These mirror the catalogues in @bos/contracts (payables.ts); the db package does not depend on contracts.
export const BILL_STATUSES = [
  'draft',
  'matching',
  'variance',
  'exception_pending',
  'pending_approval',
  'approved',
  'partially_paid',
  'paid',
  'voided',
  'rejected',
  'discarded',
] as const;
export const BILL_KINDS = ['bill', 'vendor_credit_note'] as const;
export const MATCH_STATUSES = [
  'not_required',
  'pending',
  'matched',
  'variance',
  'exception_approved',
] as const;
export const BILL_SUBMISSION_STATUSES = ['received', 'converted', 'rejected', 'withdrawn'] as const;
export const MATCH_RESULT_STATUSES = ['matched', 'variance'] as const;
export const MATCH_EXCEPTION_STATUSES = ['pending', 'approved', 'rejected'] as const;
export const PAYMENT_REQUEST_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'rejected',
  'cancelled',
] as const;
export const PAYMENT_TYPES = ['settlement', 'advance'] as const;
const CURRENCIES = ['NPR', 'INR', 'USD'] as const;

const money = (name: string) => numeric(name, { precision: 18, scale: 2 });
const quantity = (name: string) => numeric(name, { precision: 18, scale: 4 });
const fxRate = (name: string) => numeric(name, { precision: 18, scale: 6 });

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

const tenantColumn = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id);

// ---------------------------------------------------------------------------------------------------------------
// Vendor bills
// ---------------------------------------------------------------------------------------------------------------

/**
 * A vendor bill (or vendor credit note) of a vendor with an account in this entity. `invoiceNoNorm` is generated
 * (upper case, no spaces, hyphens or slashes) and unique per (entity, vendor, fiscalYear), so INV-001 and inv 001
 * collide (23505). `fiscalYear` is the invoice date's. payable_total = net_total + vat_total - tds_total (CHECK).
 * `purchaseOrderId` is optional (non-PO bills) and, when set, the vendor's own PO in this entity.
 */
export const vendorBills = appSchema.table(
  'vendor_bills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    organizationId: uuid('organization_id').notNull(),
    kind: text('kind', { enum: BILL_KINDS }).notNull().default('bill'),
    /** The BILL series number, once numbered. */
    number: text('number'),
    vendorId: uuid('vendor_id').notNull(),
    vendorInvoiceNo: text('vendor_invoice_no').notNull(),
    /** Stored generated; never inserted. */
    invoiceNoNorm: text('invoice_no_norm').generatedAlwaysAs(
      sql`upper(regexp_replace("vendor_invoice_no", '[[:space:]/-]', '', 'g'))`,
    ),
    invoiceDate: date('invoice_date', { mode: 'string' }).notNull(),
    dueDate: date('due_date', { mode: 'string' }),
    fiscalYear: text('fiscal_year').notNull(),
    currency: char('currency', { length: 3, enum: CURRENCIES }).notNull(),
    purchaseOrderId: uuid('purchase_order_id'),
    documentId: uuid('document_id').notNull(),
    status: text('status', { enum: BILL_STATUSES }).notNull().default('draft'),
    matchStatus: text('match_status', { enum: MATCH_STATUSES }).notNull().default('pending'),
    netTotal: money('net_total').notNull().default('0'),
    vatTotal: money('vat_total').notNull().default('0'),
    tdsTotal: money('tds_total').notNull().default('0'),
    payableTotal: money('payable_total').notNull().default('0'),
    withholdingCodeId: uuid('withholding_code_id'),
    /** NPR per unit (1 for NPR), with its source and date for a foreign currency. */
    fxRate: fxRate('fx_rate').notNull(),
    fxSource: text('fx_source'),
    fxDate: date('fx_date', { mode: 'string' }),
    payableTotalNpr: money('payable_total_npr').notNull(),
    enteredBy: uuid('entered_by').notNull(),
    approvalRequestId: uuid('approval_request_id'),
    voidedBy: uuid('voided_by'),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidReason: text('void_reason'),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('vendor_bills_tenant_org_id_unique').on(t.tenantId, t.organizationId, t.id),
    // Parent key of vendor_bill_lines_bill_po_fk: a line's PO is the bill's own.
    unique('vendor_bills_tenant_org_id_po_unique').on(
      t.tenantId,
      t.organizationId,
      t.id,
      t.purchaseOrderId,
    ),
    unique('vendor_bills_tenant_org_vendor_id_unique').on(
      t.tenantId,
      t.organizationId,
      t.vendorId,
      t.id,
    ),
    unique('vendor_bills_tenant_org_number_unique').on(t.tenantId, t.organizationId, t.number),
    uniqueIndex('vendor_bills_tenant_org_vendor_invoice_fy_unique')
      .on(t.tenantId, t.organizationId, t.vendorId, t.invoiceNoNorm, t.fiscalYear)
      .where(sql`${t.status} <> 'discarded'`),
    foreignKey({
      name: 'vendor_bills_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'vendor_bills_vendor_account_fk',
      columns: [t.tenantId, t.organizationId, t.vendorId],
      foreignColumns: [
        vendorAccounts.tenantId,
        vendorAccounts.organizationId,
        vendorAccounts.vendorId,
      ],
    }),
    foreignKey({
      name: 'vendor_bills_purchase_order_fk',
      columns: [t.tenantId, t.organizationId, t.vendorId, t.purchaseOrderId],
      foreignColumns: [
        purchaseOrders.tenantId,
        purchaseOrders.organizationId,
        purchaseOrders.vendorId,
        purchaseOrders.id,
      ],
    }),
    foreignKey({
      name: 'vendor_bills_document_fk',
      columns: [t.tenantId, t.organizationId, t.documentId],
      foreignColumns: [documents.tenantId, documents.organizationId, documents.id],
    }),
    foreignKey({
      name: 'vendor_bills_withholding_code_fk',
      columns: [t.tenantId, t.withholdingCodeId],
      foreignColumns: [withholdingCodes.tenantId, withholdingCodes.id],
    }),
    foreignKey({
      name: 'vendor_bills_entered_by_fk',
      columns: [t.tenantId, t.enteredBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'vendor_bills_approval_request_fk',
      columns: [t.tenantId, t.organizationId, t.approvalRequestId],
      foreignColumns: [
        approvalRequests.tenantId,
        approvalRequests.organizationId,
        approvalRequests.id,
      ],
    }),
    foreignKey({
      name: 'vendor_bills_voided_by_fk',
      columns: [t.tenantId, t.voidedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    index('vendor_bills_tenant_org_status_idx').on(t.tenantId, t.organizationId, t.status),
    index('vendor_bills_tenant_org_po_idx').on(t.tenantId, t.organizationId, t.purchaseOrderId),
    check('vendor_bills_kind_check', sql`${t.kind} in ('bill', 'vendor_credit_note')`),
    check(
      'vendor_bills_status_check',
      sql`${t.status} in ('draft', 'matching', 'variance', 'exception_pending', 'pending_approval', 'approved', 'partially_paid', 'paid', 'voided', 'rejected', 'discarded')`,
    ),
    check(
      'vendor_bills_match_status_check',
      sql`${t.matchStatus} in ('not_required', 'pending', 'matched', 'variance', 'exception_approved')`,
    ),
    check('vendor_bills_currency_check', sql`${t.currency} in ('NPR', 'INR', 'USD')`),
    check('vendor_bills_invoice_no_check', sql`${t.invoiceNoNorm} <> ''`),
    check(
      'vendor_bills_totals_check',
      sql`${t.netTotal} >= 0 AND ${t.vatTotal} >= 0 AND ${t.tdsTotal} >= 0 AND ${t.payableTotal} >= 0 AND ${t.payableTotalNpr} >= 0`,
    ),
    check(
      'vendor_bills_payable_check',
      sql`${t.payableTotal} = ${t.netTotal} + ${t.vatTotal} - ${t.tdsTotal}`,
    ),
    check(
      'vendor_bills_tds_code_check',
      sql`${t.tdsTotal} = 0 OR ${t.withholdingCodeId} IS NOT NULL`,
    ),
    check('vendor_bills_fx_rate_check', sql`${t.fxRate} > 0`),
    check(
      'vendor_bills_npr_snapshot_check',
      sql`${t.currency} <> 'NPR' OR (${t.fxRate} = 1 AND ${t.payableTotalNpr} = ${t.payableTotal})`,
    ),
    check(
      'vendor_bills_fx_source_check',
      sql`${t.currency} = 'NPR' OR (${t.fxSource} IS NOT NULL AND ${t.fxDate} IS NOT NULL)`,
    ),
    check(
      'vendor_bills_due_date_check',
      sql`${t.dueDate} IS NULL OR ${t.dueDate} >= ${t.invoiceDate}`,
    ),
    check(
      'vendor_bills_voided_check',
      sql`${t.status} <> 'voided' OR (${t.voidedBy} IS NOT NULL AND ${t.voidedAt} IS NOT NULL AND ${t.voidReason} IS NOT NULL AND btrim(${t.voidReason}) <> '')`,
    ),
    check('vendor_bills_version_check', sql`${t.version} >= 1`),
  ],
);

/**
 * A bill a vendor uploaded through the portal (the inbox). `vendorPartyId` is the portal counterparty column:
 * nullable, FK to parties with the kind, and a vendor with an account in this entity. A converted submission names
 * the bill it became.
 */
export const vendorBillSubmissions = appSchema.table(
  'vendor_bill_submissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    organizationId: uuid('organization_id').notNull(),
    vendorPartyId: uuid('vendor_party_id'),
    /** Always 'vendor' (stored generated), so the parties FK refuses a customer. Not inserted. */
    vendorPartyKind: text('vendor_party_kind').generatedAlwaysAs(sql`'vendor'`),
    purchaseOrderId: uuid('purchase_order_id'),
    submittedBy: uuid('submitted_by').notNull(),
    documentId: uuid('document_id').notNull(),
    vendorInvoiceNo: text('vendor_invoice_no'),
    invoiceDate: date('invoice_date', { mode: 'string' }),
    note: text('note'),
    status: text('status', { enum: BILL_SUBMISSION_STATUSES }).notNull().default('received'),
    convertedBillId: uuid('converted_bill_id'),
    rejectionReason: text('rejection_reason'),
    reviewedBy: uuid('reviewed_by'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('vendor_bill_submissions_tenant_org_id_unique').on(t.tenantId, t.organizationId, t.id),
    foreignKey({
      name: 'vendor_bill_submissions_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'vendor_bill_submissions_vendor_party_fk',
      columns: [t.tenantId, t.vendorPartyId, t.vendorPartyKind],
      foreignColumns: [parties.tenantId, parties.id, parties.kind],
    }),
    foreignKey({
      name: 'vendor_bill_submissions_vendor_account_fk',
      columns: [t.tenantId, t.organizationId, t.vendorPartyId],
      foreignColumns: [
        vendorAccounts.tenantId,
        vendorAccounts.organizationId,
        vendorAccounts.vendorId,
      ],
    }),
    foreignKey({
      name: 'vendor_bill_submissions_purchase_order_fk',
      columns: [t.tenantId, t.organizationId, t.vendorPartyId, t.purchaseOrderId],
      foreignColumns: [
        purchaseOrders.tenantId,
        purchaseOrders.organizationId,
        purchaseOrders.vendorId,
        purchaseOrders.id,
      ],
    }),
    foreignKey({
      name: 'vendor_bill_submissions_submitted_by_fk',
      columns: [t.tenantId, t.submittedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'vendor_bill_submissions_document_fk',
      columns: [t.tenantId, t.organizationId, t.documentId],
      foreignColumns: [documents.tenantId, documents.organizationId, documents.id],
    }),
    foreignKey({
      name: 'vendor_bill_submissions_converted_bill_fk',
      columns: [t.tenantId, t.organizationId, t.convertedBillId],
      foreignColumns: [vendorBills.tenantId, vendorBills.organizationId, vendorBills.id],
    }),
    foreignKey({
      name: 'vendor_bill_submissions_converted_bill_vendor_fk',
      columns: [t.tenantId, t.organizationId, t.vendorPartyId, t.convertedBillId],
      foreignColumns: [
        vendorBills.tenantId,
        vendorBills.organizationId,
        vendorBills.vendorId,
        vendorBills.id,
      ],
    }),
    foreignKey({
      name: 'vendor_bill_submissions_reviewed_by_fk',
      columns: [t.tenantId, t.reviewedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    index('vendor_bill_submissions_tenant_vendor_party_idx').on(t.tenantId, t.vendorPartyId),
    index('vendor_bill_submissions_tenant_org_status_idx').on(
      t.tenantId,
      t.organizationId,
      t.status,
    ),
    check(
      'vendor_bill_submissions_status_check',
      sql`${t.status} in ('received', 'converted', 'rejected', 'withdrawn')`,
    ),
    check(
      'vendor_bill_submissions_converted_check',
      sql`(${t.status} = 'converted') = (${t.convertedBillId} IS NOT NULL)`,
    ),
    check(
      'vendor_bill_submissions_rejected_check',
      sql`${t.status} <> 'rejected' OR (${t.rejectionReason} IS NOT NULL AND btrim(${t.rejectionReason}) <> '')`,
    ),
    check(
      'vendor_bill_submissions_reviewed_check',
      sql`${t.status} NOT IN ('converted', 'rejected') OR ${t.reviewedBy} IS NOT NULL`,
    ),
    check('vendor_bill_submissions_version_check', sql`${t.version} >= 1`),
  ],
);

/**
 * One line of a bill. The bill FK is always checked; a PO link repeats the bill's own PO, a PO line of that PO in
 * this entity (another entity's line is a 23503) and a receipt line of that PO line. net_amount =
 * round(quantity * unit_price, 2).
 */
export const vendorBillLines = appSchema.table(
  'vendor_bill_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    organizationId: uuid('organization_id').notNull(),
    vendorBillId: uuid('vendor_bill_id').notNull(),
    purchaseOrderId: uuid('purchase_order_id'),
    poLineId: uuid('po_line_id'),
    receiptLineId: uuid('receipt_line_id'),
    lineNo: integer('line_no').notNull(),
    description: text('description').notNull(),
    /** No FK: there is no chart of accounts in P4 (AD1). */
    accountId: uuid('account_id').notNull(),
    costCenterId: uuid('cost_center_id'),
    projectId: uuid('project_id'),
    quantity: quantity('quantity').notNull(),
    unitPrice: money('unit_price').notNull(),
    netAmount: money('net_amount').notNull(),
    taxCodeId: uuid('tax_code_id').notNull(),
    vatAmount: money('vat_amount').notNull(),
    withholdingCodeId: uuid('withholding_code_id'),
    tdsAmount: money('tds_amount').notNull().default('0'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('vendor_bill_lines_tenant_org_id_unique').on(t.tenantId, t.organizationId, t.id),
    unique('vendor_bill_lines_tenant_org_bill_id_unique').on(
      t.tenantId,
      t.organizationId,
      t.vendorBillId,
      t.id,
    ),
    unique('vendor_bill_lines_tenant_bill_line_no_unique').on(t.tenantId, t.vendorBillId, t.lineNo),
    foreignKey({
      name: 'vendor_bill_lines_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'vendor_bill_lines_bill_fk',
      columns: [t.tenantId, t.organizationId, t.vendorBillId],
      foreignColumns: [vendorBills.tenantId, vendorBills.organizationId, vendorBills.id],
    }),
    foreignKey({
      name: 'vendor_bill_lines_bill_po_fk',
      columns: [t.tenantId, t.organizationId, t.vendorBillId, t.purchaseOrderId],
      foreignColumns: [
        vendorBills.tenantId,
        vendorBills.organizationId,
        vendorBills.id,
        vendorBills.purchaseOrderId,
      ],
    }),
    foreignKey({
      name: 'vendor_bill_lines_po_line_fk',
      columns: [t.tenantId, t.organizationId, t.purchaseOrderId, t.poLineId],
      foreignColumns: [
        purchaseOrderLines.tenantId,
        purchaseOrderLines.organizationId,
        purchaseOrderLines.purchaseOrderId,
        purchaseOrderLines.id,
      ],
    }),
    foreignKey({
      name: 'vendor_bill_lines_receipt_line_fk',
      columns: [t.tenantId, t.organizationId, t.poLineId, t.receiptLineId],
      foreignColumns: [
        receiptLines.tenantId,
        receiptLines.organizationId,
        receiptLines.poLineId,
        receiptLines.id,
      ],
    }),
    foreignKey({
      name: 'vendor_bill_lines_tax_code_fk',
      columns: [t.tenantId, t.taxCodeId],
      foreignColumns: [taxCodes.tenantId, taxCodes.id],
    }),
    foreignKey({
      name: 'vendor_bill_lines_withholding_code_fk',
      columns: [t.tenantId, t.withholdingCodeId],
      foreignColumns: [withholdingCodes.tenantId, withholdingCodes.id],
    }),
    index('vendor_bill_lines_tenant_org_po_line_idx').on(t.tenantId, t.organizationId, t.poLineId),
    index('vendor_bill_lines_tenant_tax_code_idx').on(t.tenantId, t.taxCodeId),
    check('vendor_bill_lines_line_no_check', sql`${t.lineNo} >= 1`),
    check('vendor_bill_lines_quantity_check', sql`${t.quantity} > 0`),
    check('vendor_bill_lines_unit_price_check', sql`${t.unitPrice} >= 0`),
    check(
      'vendor_bill_lines_net_amount_check',
      sql`${t.netAmount} = round(${t.quantity} * ${t.unitPrice}, 2)`,
    ),
    check('vendor_bill_lines_vat_amount_check', sql`${t.vatAmount} >= 0`),
    check(
      'vendor_bill_lines_tds_amount_check',
      sql`${t.tdsAmount} >= 0 AND (${t.tdsAmount} = 0 OR ${t.withholdingCodeId} IS NOT NULL)`,
    ),
    check(
      'vendor_bill_lines_po_link_check',
      sql`${t.poLineId} IS NULL OR ${t.purchaseOrderId} IS NOT NULL`,
    ),
    check(
      'vendor_bill_lines_receipt_link_check',
      sql`${t.receiptLineId} IS NULL OR ${t.poLineId} IS NOT NULL`,
    ),
  ],
);

// ---------------------------------------------------------------------------------------------------------------
// Matching (AD6)
// ---------------------------------------------------------------------------------------------------------------

/** The match of one bill line in one run; the latest run counts. status = matched exactly when within tolerance. */
export const matchResults = appSchema.table(
  'match_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    organizationId: uuid('organization_id').notNull(),
    vendorBillId: uuid('vendor_bill_id').notNull(),
    vendorBillLineId: uuid('vendor_bill_line_id').notNull(),
    poLineId: uuid('po_line_id'),
    runNo: integer('run_no').notNull(),
    status: text('status', { enum: MATCH_RESULT_STATUSES }).notNull(),
    orderedQuantity: quantity('ordered_quantity'),
    receivedQuantity: quantity('received_quantity'),
    billedQuantity: quantity('billed_quantity').notNull(),
    quantityVariance: quantity('quantity_variance').notNull().default('0'),
    priceVariance: money('price_variance').notNull().default('0'),
    taxVariance: money('tax_variance').notNull().default('0'),
    withinTolerance: boolean('within_tolerance').notNull(),
    /** The tolerances this run used (AD6, from settings). */
    priceToleranceBp: integer('price_tolerance_bp').notNull(),
    priceToleranceAmount: money('price_tolerance_amount').notNull(),
    matchedBy: uuid('matched_by'),
    createdAt: createdAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('match_results_tenant_line_run_unique').on(t.tenantId, t.vendorBillLineId, t.runNo),
    foreignKey({
      name: 'match_results_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'match_results_bill_line_fk',
      columns: [t.tenantId, t.organizationId, t.vendorBillId, t.vendorBillLineId],
      foreignColumns: [
        vendorBillLines.tenantId,
        vendorBillLines.organizationId,
        vendorBillLines.vendorBillId,
        vendorBillLines.id,
      ],
    }),
    foreignKey({
      name: 'match_results_po_line_fk',
      columns: [t.tenantId, t.organizationId, t.poLineId],
      foreignColumns: [
        purchaseOrderLines.tenantId,
        purchaseOrderLines.organizationId,
        purchaseOrderLines.id,
      ],
    }),
    foreignKey({
      name: 'match_results_matched_by_fk',
      columns: [t.tenantId, t.matchedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    index('match_results_tenant_org_bill_idx').on(t.tenantId, t.organizationId, t.vendorBillId),
    check('match_results_status_check', sql`${t.status} in ('matched', 'variance')`),
    check('match_results_run_no_check', sql`${t.runNo} >= 1`),
    check(
      'match_results_status_tolerance_check',
      sql`(${t.status} = 'matched') = ${t.withinTolerance}`,
    ),
    check(
      'match_results_tolerance_check',
      sql`${t.priceToleranceBp} BETWEEN 0 AND 10000 AND ${t.priceToleranceAmount} >= 0`,
    ),
  ],
);

/** A request to accept a bill outside tolerance; Finance decides (AD5), never the requester. */
export const matchExceptions = appSchema.table(
  'match_exceptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    organizationId: uuid('organization_id').notNull(),
    vendorBillId: uuid('vendor_bill_id').notNull(),
    reason: text('reason').notNull(),
    evidenceDocumentId: uuid('evidence_document_id'),
    status: text('status', { enum: MATCH_EXCEPTION_STATUSES }).notNull().default('pending'),
    requestedBy: uuid('requested_by').notNull(),
    decidedBy: uuid('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionNote: text('decision_note'),
    approvalRequestId: uuid('approval_request_id'),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('match_exceptions_tenant_org_id_unique').on(t.tenantId, t.organizationId, t.id),
    foreignKey({
      name: 'match_exceptions_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'match_exceptions_bill_fk',
      columns: [t.tenantId, t.organizationId, t.vendorBillId],
      foreignColumns: [vendorBills.tenantId, vendorBills.organizationId, vendorBills.id],
    }),
    foreignKey({
      name: 'match_exceptions_evidence_document_fk',
      columns: [t.tenantId, t.organizationId, t.evidenceDocumentId],
      foreignColumns: [documents.tenantId, documents.organizationId, documents.id],
    }),
    foreignKey({
      name: 'match_exceptions_requested_by_fk',
      columns: [t.tenantId, t.requestedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'match_exceptions_decided_by_fk',
      columns: [t.tenantId, t.decidedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'match_exceptions_approval_request_fk',
      columns: [t.tenantId, t.organizationId, t.approvalRequestId],
      foreignColumns: [
        approvalRequests.tenantId,
        approvalRequests.organizationId,
        approvalRequests.id,
      ],
    }),
    // PostgreSQL has no partial unique constraint, so this is a unique index.
    uniqueIndex('match_exceptions_tenant_bill_pending_unique')
      .on(t.tenantId, t.vendorBillId)
      .where(sql`${t.status} = 'pending'`),
    check('match_exceptions_status_check', sql`${t.status} in ('pending', 'approved', 'rejected')`),
    check('match_exceptions_reason_check', sql`btrim(${t.reason}) <> ''`),
    check(
      'match_exceptions_approver_check',
      sql`${t.decidedBy} IS NULL OR ${t.decidedBy} <> ${t.requestedBy}`,
    ),
    check(
      'match_exceptions_decided_check',
      sql`(${t.status} = 'pending' AND ${t.decidedBy} IS NULL AND ${t.decidedAt} IS NULL) OR (${t.status} <> 'pending' AND ${t.decidedBy} IS NOT NULL AND ${t.decidedAt} IS NOT NULL)`,
    ),
    check('match_exceptions_version_check', sql`${t.version} >= 1`),
  ],
);

// ---------------------------------------------------------------------------------------------------------------
// Payment requests (AD1: the request and its approval; no payout)
// ---------------------------------------------------------------------------------------------------------------

/**
 * A request to pay one vendor. number, numberSeq and fiscalYear: all three or none. The vendor's active verified bank
 * account is snapshotted as `vendorBankAccountId` + `bankLast4`; no account number is stored.
 */
export const paymentRequests = appSchema.table(
  'payment_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    organizationId: uuid('organization_id').notNull(),
    number: text('number'),
    numberSeq: integer('number_seq'),
    fiscalYear: text('fiscal_year'),
    vendorId: uuid('vendor_id').notNull(),
    paymentType: text('payment_type', { enum: PAYMENT_TYPES }).notNull(),
    purchaseOrderId: uuid('purchase_order_id'),
    currency: char('currency', { length: 3, enum: CURRENCIES }).notNull(),
    totalAmount: money('total_amount').notNull(),
    /** The paying entity's bank account. No FK: no entity bank accounts table yet. */
    fromBankAccountId: uuid('from_bank_account_id').notNull(),
    vendorBankAccountId: uuid('vendor_bank_account_id').notNull(),
    bankLast4: text('bank_last4').notNull(),
    status: text('status', { enum: PAYMENT_REQUEST_STATUSES }).notNull().default('draft'),
    requestedBy: uuid('requested_by').notNull(),
    approvalRequestId: uuid('approval_request_id'),
    cancelReason: text('cancel_reason'),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('payment_requests_tenant_org_id_unique').on(t.tenantId, t.organizationId, t.id),
    unique('payment_requests_tenant_org_number_unique').on(t.tenantId, t.organizationId, t.number),
    unique('payment_requests_tenant_org_fy_seq_unique').on(
      t.tenantId,
      t.organizationId,
      t.fiscalYear,
      t.numberSeq,
    ),
    foreignKey({
      name: 'payment_requests_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'payment_requests_vendor_account_fk',
      columns: [t.tenantId, t.organizationId, t.vendorId],
      foreignColumns: [
        vendorAccounts.tenantId,
        vendorAccounts.organizationId,
        vendorAccounts.vendorId,
      ],
    }),
    foreignKey({
      name: 'payment_requests_purchase_order_fk',
      columns: [t.tenantId, t.organizationId, t.vendorId, t.purchaseOrderId],
      foreignColumns: [
        purchaseOrders.tenantId,
        purchaseOrders.organizationId,
        purchaseOrders.vendorId,
        purchaseOrders.id,
      ],
    }),
    foreignKey({
      name: 'payment_requests_vendor_bank_account_fk',
      columns: [t.tenantId, t.vendorBankAccountId],
      foreignColumns: [vendorBankAccounts.tenantId, vendorBankAccounts.id],
    }),
    foreignKey({
      name: 'payment_requests_requested_by_fk',
      columns: [t.tenantId, t.requestedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'payment_requests_approval_request_fk',
      columns: [t.tenantId, t.organizationId, t.approvalRequestId],
      foreignColumns: [
        approvalRequests.tenantId,
        approvalRequests.organizationId,
        approvalRequests.id,
      ],
    }),
    index('payment_requests_tenant_org_status_idx').on(t.tenantId, t.organizationId, t.status),
    index('payment_requests_tenant_org_vendor_idx').on(t.tenantId, t.organizationId, t.vendorId),
    check(
      'payment_requests_status_check',
      sql`${t.status} in ('draft', 'pending_approval', 'approved', 'rejected', 'cancelled')`,
    ),
    check(
      'payment_requests_payment_type_check',
      sql`${t.paymentType} in ('settlement', 'advance')`,
    ),
    check('payment_requests_currency_check', sql`${t.currency} in ('NPR', 'INR', 'USD')`),
    check(
      'payment_requests_advance_check',
      sql`${t.paymentType} <> 'advance' OR ${t.purchaseOrderId} IS NOT NULL`,
    ),
    check('payment_requests_total_amount_check', sql`${t.totalAmount} > 0`),
    check('payment_requests_bank_last4_check', sql`${t.bankLast4} ~ '^[0-9]{4}$'`),
    check(
      'payment_requests_numbering_check',
      sql`(${t.number} IS NULL AND ${t.numberSeq} IS NULL AND ${t.fiscalYear} IS NULL) OR (${t.number} IS NOT NULL AND ${t.numberSeq} >= 1 AND ${t.fiscalYear} IS NOT NULL)`,
    ),
    check(
      'payment_requests_cancelled_check',
      sql`${t.status} <> 'cancelled' OR (${t.cancelReason} IS NOT NULL AND btrim(${t.cancelReason}) <> '')`,
    ),
    check('payment_requests_version_check', sql`${t.version} >= 1`),
  ],
);

/** One line of a payment request: an amount > 0 of one payable open item of this entity, once per request. */
export const paymentRequestLines = appSchema.table(
  'payment_request_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    organizationId: uuid('organization_id').notNull(),
    paymentRequestId: uuid('payment_request_id').notNull(),
    lineNo: integer('line_no').notNull(),
    openItemId: uuid('open_item_id').notNull(),
    amount: money('amount').notNull(),
    createdAt: createdAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('payment_request_lines_tenant_request_line_no_unique').on(
      t.tenantId,
      t.paymentRequestId,
      t.lineNo,
    ),
    unique('payment_request_lines_tenant_request_open_item_unique').on(
      t.tenantId,
      t.paymentRequestId,
      t.openItemId,
    ),
    foreignKey({
      name: 'payment_request_lines_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'payment_request_lines_payment_request_fk',
      columns: [t.tenantId, t.organizationId, t.paymentRequestId],
      foreignColumns: [
        paymentRequests.tenantId,
        paymentRequests.organizationId,
        paymentRequests.id,
      ],
    }),
    foreignKey({
      name: 'payment_request_lines_open_item_fk',
      columns: [t.tenantId, t.organizationId, t.openItemId],
      foreignColumns: [openItems.tenantId, openItems.organizationId, openItems.id],
    }),
    index('payment_request_lines_tenant_org_open_item_idx').on(
      t.tenantId,
      t.organizationId,
      t.openItemId,
    ),
    check('payment_request_lines_line_no_check', sql`${t.lineNo} >= 1`),
    check('payment_request_lines_amount_check', sql`${t.amount} > 0`),
  ],
);

// ---------------------------------------------------------------------------------------------------------------
// Progress per PO line
// ---------------------------------------------------------------------------------------------------------------

/**
 * Per PO line: ordered and cancelled (the line), received (confirmed receipts net of reversals; drafts left out)
 * and billed (bills not voided, rejected or discarded, credit notes negative). Derived, never stored.
 */
export const poLineProgress = appSchema
  .view('v_po_line_progress', {
    tenantId: uuid('tenant_id').notNull(),
    organizationId: uuid('organization_id').notNull(),
    purchaseOrderId: uuid('purchase_order_id').notNull(),
    poLineId: uuid('po_line_id').notNull(),
    orderedQuantity: quantity('ordered_quantity').notNull(),
    cancelledQuantity: quantity('cancelled_quantity').notNull(),
    receivedQuantity: quantity('received_quantity').notNull(),
    billedQuantity: quantity('billed_quantity').notNull(),
  })
  .existing();
