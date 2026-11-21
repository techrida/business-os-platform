// Drizzle tables for migration 0021_invoices: tax invoices, proformas, credit and debit notes, their lines, tax
// summary and print log (P3 unit U1). Money is numeric(18,2), quantities numeric(18,4) and FX rates numeric(18,6),
// all read as strings; wrap them in decimal.js, never Number().
// The SQL in migrations/0021_invoices.sql and 0023_invoice_credit_release.sql is the source of truth; this file only
// types the queries, so keep them in step. invoicing-schema.test.ts compares them. Every table is entity-owned
// (ADR 0027).
// Not modelled here: the guard triggers (G3: an issued invoice is immutable; lines change only in draft or returned),
// the deferred credit/debit-note trigger, the print log's append-only trigger and privileges, and
// billing_schedule_lines_invoice_fk (SQL only, so sales.ts does not import this file).
import { sql } from 'drizzle-orm';
import {
  bigint,
  char,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { approvalRequests } from './approvals.js';
import { customers } from './crm.js';
import { documents } from './documents.js';
import { users } from './identity.js';
import { appSchema, organizations, parties, tenants } from './platform.js';
import { taxCodes } from './quotations.js';
import { billingScheduleLines, salesOrders } from './sales.js';

/** Postgres bytea as a Node Buffer (drizzle-orm 0.45 has no built-in bytea column). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

export const INVOICE_KINDS = ['tax_invoice', 'proforma', 'credit_note', 'debit_note'] as const;
export const INVOICE_STATUSES = [
  'draft',
  'submitted',
  'returned',
  'approved',
  'issued',
  'discarded',
] as const;
/** The statuses in which an invoice's lines and tax summary may change (invoice_children_guard). */
export const INVOICE_EDITABLE_STATUSES = ['draft', 'returned'] as const;
export const INVOICE_CURRENCIES = ['NPR', 'INR', 'USD'] as const;

const money = (name: string) => numeric(name, { precision: 18, scale: 2 });
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/**
 * A tax invoice, proforma, credit note or debit note. Inserted as draft; issued exactly when numbered; immutable once
 * issued (SQL guard). One live tax invoice per schedule line. `customerPartyId` is nullable in the type (ADR 0027
 * counterparty rule) but required by invoices_customer_check. No paid column: settlement is derived (A8).
 */
export const invoices = appSchema.table(
  'invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id').notNull(),
    kind: text('kind', { enum: INVOICE_KINDS }).notNull(),
    status: text('status', { enum: INVOICE_STATUSES }).notNull().default('draft'),
    customerPartyId: uuid('customer_party_id'),
    /** Always 'customer' (stored generated), so invoices_customer_party_fk refuses a vendor. Not inserted. */
    customerPartyKind: text('customer_party_kind').generatedAlwaysAs(sql`'customer'`),
    salesOrderId: uuid('sales_order_id'),
    scheduleLineId: uuid('schedule_line_id'),
    /** Credit and debit notes only: the issued tax invoice they correct. */
    originalInvoiceId: uuid('original_invoice_id'),
    manualReason: text('manual_reason'),
    noteReason: text('note_reason'),
    number: text('number'),
    seq: bigint('seq', { mode: 'number' }),
    /** BS fiscal year, e.g. '2083/84'. */
    fiscalYear: text('fiscal_year'),
    issueDate: date('issue_date', { mode: 'string' }),
    /** BS issue date 'YYYY-MM-DD', on an issued document only. */
    issueDateBs: text('issue_date_bs'),
    dueDate: date('due_date', { mode: 'string' }),
    currency: char('currency', { length: 3, enum: INVOICE_CURRENCIES }).notNull(),
    subtotal: money('subtotal').notNull().default('0'),
    discountAmount: money('discount_amount').notNull().default('0'),
    taxableVatAmount: money('taxable_vat_amount').notNull().default('0'),
    exemptAmount: money('exempt_amount').notNull().default('0'),
    zeroRatedAmount: money('zero_rated_amount').notNull().default('0'),
    taxAmount: money('tax_amount').notNull().default('0'),
    total: money('total').notNull().default('0'),
    /** NPR per unit of `currency`, frozen at issue. */
    fxRate: numeric('fx_rate', { precision: 18, scale: 6 }),
    fxSource: text('fx_source'),
    fxDate: date('fx_date', { mode: 'string' }),
    /** NPR snapshot of `total`, frozen at issue. */
    amountNpr: money('amount_npr'),
    sellerSnapshot: jsonb('seller_snapshot'),
    buyerSnapshot: jsonb('buyer_snapshot'),
    calcVersion: integer('calc_version').notNull().default(1),
    contentHash: bytea('content_hash'),
    approvalRequestId: uuid('approval_request_id'),
    issuedAt: timestamp('issued_at', { withTimezone: true }),
    issuedBy: uuid('issued_by'),
    discardedAt: timestamp('discarded_at', { withTimezone: true }),
    /**
     * Credit-release marker (0023): set once, on an issued invoice, when credit notes cancel it in full. It is the one
     * change the issued-row freeze allows, and it frees the invoice's schedule line for a new tax invoice (G4).
     */
    creditedInFullAt: timestamp('credited_in_full_at', { withTimezone: true }),
    createdBy: uuid('created_by'),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('invoices_tenant_id_unique').on(t.tenantId, t.id),
    unique('invoices_tenant_org_id_unique').on(t.tenantId, t.organizationId, t.id),
    unique('invoices_tenant_org_order_id_unique').on(
      t.tenantId,
      t.organizationId,
      t.salesOrderId,
      t.id,
    ),
    unique('invoices_tenant_org_number_unique').on(t.tenantId, t.organizationId, t.number),
    unique('invoices_tenant_org_kind_fy_seq_unique').on(
      t.tenantId,
      t.organizationId,
      t.kind,
      t.fiscalYear,
      t.seq,
    ),
    foreignKey({
      name: 'invoices_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'invoices_customer_party_fk',
      columns: [t.tenantId, t.customerPartyId, t.customerPartyKind],
      foreignColumns: [parties.tenantId, parties.id, parties.kind],
    }),
    foreignKey({
      name: 'invoices_customer_fk',
      columns: [t.tenantId, t.customerPartyId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
    foreignKey({
      name: 'invoices_sales_order_fk',
      columns: [t.tenantId, t.organizationId, t.salesOrderId],
      foreignColumns: [salesOrders.tenantId, salesOrders.organizationId, salesOrders.id],
    }),
    foreignKey({
      name: 'invoices_schedule_line_fk',
      columns: [t.tenantId, t.organizationId, t.salesOrderId, t.scheduleLineId],
      foreignColumns: [
        billingScheduleLines.tenantId,
        billingScheduleLines.organizationId,
        billingScheduleLines.salesOrderId,
        billingScheduleLines.id,
      ],
    }),
    foreignKey({
      name: 'invoices_original_invoice_fk',
      columns: [t.tenantId, t.organizationId, t.originalInvoiceId],
      foreignColumns: [t.tenantId, t.organizationId, t.id],
    }),
    foreignKey({
      name: 'invoices_approval_request_fk',
      columns: [t.tenantId, t.organizationId, t.approvalRequestId],
      foreignColumns: [
        approvalRequests.tenantId,
        approvalRequests.organizationId,
        approvalRequests.id,
      ],
    }),
    foreignKey({
      name: 'invoices_issued_by_user_fk',
      columns: [t.tenantId, t.issuedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'invoices_created_by_user_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    uniqueIndex('invoices_one_live_tax_invoice_per_schedule_line')
      .on(t.tenantId, t.organizationId, t.scheduleLineId)
      .where(
        sql`${t.kind} = 'tax_invoice' AND ${t.status} <> 'discarded' AND ${t.scheduleLineId} IS NOT NULL AND ${t.creditedInFullAt} IS NULL`,
      ),
    index('invoices_tenant_customer_party_idx').on(t.tenantId, t.customerPartyId),
    index('invoices_tenant_org_status_idx').on(t.tenantId, t.organizationId, t.status),
    index('invoices_tenant_org_original_idx').on(t.tenantId, t.organizationId, t.originalInvoiceId),
    /** The sales VAT register (0177): issued documents of one entity by issue date. */
    index('invoices_issued_date_idx')
      .on(t.tenantId, t.organizationId, t.issueDate)
      .where(sql`${t.status} = 'issued'`),
    check(
      'invoices_kind_check',
      sql`${t.kind} in ('tax_invoice', 'proforma', 'credit_note', 'debit_note')`,
    ),
    check(
      'invoices_status_check',
      sql`${t.status} in ('draft', 'submitted', 'returned', 'approved', 'issued', 'discarded')`,
    ),
    check('invoices_customer_check', sql`${t.customerPartyId} IS NOT NULL`),
    check('invoices_currency_check', sql`${t.currency} in ('NPR', 'INR', 'USD')`),
    check(
      'invoices_amounts_check',
      sql`${t.subtotal} >= 0 AND ${t.discountAmount} >= 0 AND ${t.discountAmount} <= ${t.subtotal} AND ${t.taxableVatAmount} >= 0 AND ${t.exemptAmount} >= 0 AND ${t.zeroRatedAmount} >= 0 AND ${t.taxAmount} >= 0`,
    ),
    check(
      'invoices_taxable_check',
      sql`${t.subtotal} - ${t.discountAmount} = ${t.taxableVatAmount} + ${t.exemptAmount} + ${t.zeroRatedAmount}`,
    ),
    check(
      'invoices_total_check',
      sql`${t.total} = ${t.taxableVatAmount} + ${t.exemptAmount} + ${t.zeroRatedAmount} + ${t.taxAmount}`,
    ),
    check(
      'invoices_note_original_check',
      sql`(${t.kind} IN ('credit_note', 'debit_note')) = (${t.originalInvoiceId} IS NOT NULL) AND ${t.originalInvoiceId} <> ${t.id}`,
    ),
    check(
      'invoices_note_reason_check',
      sql`${t.kind} NOT IN ('credit_note', 'debit_note') OR ${t.noteReason} IS NOT NULL`,
    ),
    check(
      'invoices_source_check',
      sql`${t.kind} <> 'tax_invoice' OR ${t.salesOrderId} IS NOT NULL OR ${t.manualReason} IS NOT NULL`,
    ),
    check(
      'invoices_schedule_line_check',
      sql`${t.scheduleLineId} IS NULL OR (${t.salesOrderId} IS NOT NULL AND ${t.kind} IN ('tax_invoice', 'proforma'))`,
    ),
    check(
      'invoices_number_parts_check',
      sql`(${t.number} IS NULL) = (${t.seq} IS NULL) AND (${t.number} IS NULL) = (${t.fiscalYear} IS NULL) AND ${t.seq} >= 1 AND ${t.fiscalYear} ~ '^[0-9]{4}/[0-9]{2}$'`,
    ),
    check('invoices_issued_check', sql`(${t.status} = 'issued') = (${t.number} IS NOT NULL)`),
    check(
      'invoices_issue_date_bs_check',
      sql`(${t.status} = 'issued') = (${t.issueDateBs} IS NOT NULL) AND ${t.issueDateBs} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`,
    ),
    check(
      'invoices_issued_snapshot_check',
      sql`${t.status} <> 'issued' OR (${t.issueDate} IS NOT NULL AND ${t.issuedAt} IS NOT NULL AND ${t.fxRate} IS NOT NULL AND ${t.amountNpr} IS NOT NULL AND ${t.sellerSnapshot} IS NOT NULL AND ${t.buyerSnapshot} IS NOT NULL AND ${t.contentHash} IS NOT NULL)`,
    ),
    check('invoices_due_date_check', sql`${t.dueDate} >= ${t.issueDate}`),
    check('invoices_fx_rate_check', sql`${t.fxRate} > 0 AND ${t.amountNpr} >= 0`),
    check(
      'invoices_npr_snapshot_check',
      sql`${t.currency} <> 'NPR' OR ${t.fxRate} IS NULL OR (${t.fxRate} = 1 AND ${t.amountNpr} = ${t.total})`,
    ),
    check(
      'invoices_fx_source_check',
      sql`${t.currency} = 'NPR' OR ${t.fxRate} IS NULL OR (${t.fxSource} IS NOT NULL AND ${t.fxDate} IS NOT NULL)`,
    ),
    check(
      'invoices_snapshots_check',
      sql`jsonb_typeof(${t.sellerSnapshot}) = 'object' AND jsonb_typeof(${t.buyerSnapshot}) = 'object'`,
    ),
    check('invoices_content_hash_check', sql`octet_length(${t.contentHash}) = 32`),
    check('invoices_calc_version_check', sql`${t.calcVersion} >= 1`),
    check(
      'invoices_discarded_check',
      sql`(${t.status} = 'discarded') = (${t.discardedAt} IS NOT NULL)`,
    ),
    check('invoices_version_check', sql`${t.version} >= 1`),
  ],
);

/** One invoice line. gross = round(quantity * unitPrice, 2); taxable = gross - discountAlloc. */
export const invoiceLines = appSchema.table(
  'invoice_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id').notNull(),
    invoiceId: uuid('invoice_id').notNull(),
    lineNo: integer('line_no').notNull(),
    description: text('description').notNull(),
    uom: text('uom').notNull(),
    quantity: numeric('quantity', { precision: 18, scale: 4 }).notNull(),
    unitPrice: money('unit_price').notNull(),
    taxCodeId: uuid('tax_code_id').notNull(),
    gross: money('gross').notNull(),
    discountAlloc: money('discount_alloc').notNull().default('0'),
    taxable: money('taxable').notNull(),
    /** The original invoice line a credit-note line credits (0024); NULL on every other kind of line. */
    originalLineId: uuid('original_line_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('invoice_lines_tenant_id_unique').on(t.tenantId, t.id),
    unique('invoice_lines_tenant_org_id_unique').on(t.tenantId, t.organizationId, t.id),
    unique('invoice_lines_tenant_org_invoice_line_no_unique').on(
      t.tenantId,
      t.organizationId,
      t.invoiceId,
      t.lineNo,
    ),
    foreignKey({
      name: 'invoice_lines_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'invoice_lines_invoice_fk',
      columns: [t.tenantId, t.organizationId, t.invoiceId],
      foreignColumns: [invoices.tenantId, invoices.organizationId, invoices.id],
    }),
    foreignKey({
      name: 'invoice_lines_tax_code_fk',
      columns: [t.tenantId, t.taxCodeId],
      foreignColumns: [taxCodes.tenantId, taxCodes.id],
    }),
    foreignKey({
      name: 'invoice_lines_original_line_fk',
      columns: [t.tenantId, t.organizationId, t.originalLineId],
      foreignColumns: [t.tenantId, t.organizationId, t.id],
    }),
    index('invoice_lines_tenant_tax_code_idx').on(t.tenantId, t.taxCodeId),
    index('invoice_lines_tenant_original_line_idx').on(t.tenantId, t.originalLineId),
    check('invoice_lines_line_no_check', sql`${t.lineNo} >= 1`),
    check('invoice_lines_quantity_check', sql`${t.quantity} > 0`),
    check('invoice_lines_unit_price_check', sql`${t.unitPrice} >= 0`),
    check('invoice_lines_gross_check', sql`${t.gross} = round(${t.quantity} * ${t.unitPrice}, 2)`),
    check(
      'invoice_lines_discount_alloc_check',
      sql`${t.discountAlloc} >= 0 AND ${t.discountAlloc} <= ${t.gross}`,
    ),
    check('invoice_lines_taxable_check', sql`${t.taxable} = ${t.gross} - ${t.discountAlloc}`),
  ],
);

/** Tax per tax code of an invoice. `rate` is percent, numeric(7,4). */
export const invoiceTaxSummary = appSchema.table(
  'invoice_tax_summary',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id').notNull(),
    invoiceId: uuid('invoice_id').notNull(),
    taxCodeId: uuid('tax_code_id').notNull(),
    label: text('label').notNull(),
    rate: numeric('rate', { precision: 7, scale: 4 }).notNull(),
    base: money('base').notNull(),
    tax: money('tax').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('invoice_tax_summary_tenant_id_unique').on(t.tenantId, t.id),
    unique('invoice_tax_summary_tenant_org_invoice_tax_code_unique').on(
      t.tenantId,
      t.organizationId,
      t.invoiceId,
      t.taxCodeId,
    ),
    foreignKey({
      name: 'invoice_tax_summary_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'invoice_tax_summary_invoice_fk',
      columns: [t.tenantId, t.organizationId, t.invoiceId],
      foreignColumns: [invoices.tenantId, invoices.organizationId, invoices.id],
    }),
    foreignKey({
      name: 'invoice_tax_summary_tax_code_fk',
      columns: [t.tenantId, t.taxCodeId],
      foreignColumns: [taxCodes.tenantId, taxCodes.id],
    }),
    check('invoice_tax_summary_rate_check', sql`${t.rate} BETWEEN 0 AND 100`),
    check('invoice_tax_summary_amounts_check', sql`${t.base} >= 0 AND ${t.tax} >= 0`),
  ],
);

/** One print of an invoice (append-only). printNo 1 is the original; later prints are copies. */
export const invoicePrintLog = appSchema.table(
  'invoice_print_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id').notNull(),
    invoiceId: uuid('invoice_id').notNull(),
    printNo: integer('print_no').notNull(),
    printedBy: uuid('printed_by'),
    printedAt: timestamp('printed_at', { withTimezone: true }).notNull().defaultNow(),
    /** Number grouping and date pattern of this print (DocumentFormatSnapshot). NULL on prints before 0051. */
    renderFormat: jsonb('render_format'),
  },
  (t) => [
    unique('invoice_print_log_tenant_id_unique').on(t.tenantId, t.id),
    unique('invoice_print_log_tenant_org_invoice_print_no_unique').on(
      t.tenantId,
      t.organizationId,
      t.invoiceId,
      t.printNo,
    ),
    foreignKey({
      name: 'invoice_print_log_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'invoice_print_log_invoice_fk',
      columns: [t.tenantId, t.organizationId, t.invoiceId],
      foreignColumns: [invoices.tenantId, invoices.organizationId, invoices.id],
    }),
    foreignKey({
      name: 'invoice_print_log_printed_by_user_fk',
      columns: [t.tenantId, t.printedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    check('invoice_print_log_print_no_check', sql`${t.printNo} >= 1`),
  ],
);

/**
 * The print a stored invoice PDF is, kept until its print row is written (0157). The render sweeper inserts it with
 * the generated document and deletes it with the print row's insert; a row whose document is live and clean is a
 * print row still owed, which the next sweep writes from here.
 */
export const invoicePendingPrints = appSchema.table(
  'invoice_pending_prints',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id').notNull(),
    invoiceId: uuid('invoice_id').notNull(),
    documentId: uuid('document_id').notNull(),
    printNo: integer('print_no').notNull(),
    /** The DocumentFormatSnapshot the PDF printed with. */
    renderFormat: jsonb('render_format').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('invoice_pending_prints_tenant_id_unique').on(t.tenantId, t.id),
    unique('invoice_pending_prints_document_unique').on(t.tenantId, t.organizationId, t.documentId),
    foreignKey({
      name: 'invoice_pending_prints_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'invoice_pending_prints_invoice_fk',
      columns: [t.tenantId, t.organizationId, t.invoiceId],
      foreignColumns: [invoices.tenantId, invoices.organizationId, invoices.id],
    }),
    foreignKey({
      name: 'invoice_pending_prints_document_fk',
      columns: [t.tenantId, t.organizationId, t.documentId],
      foreignColumns: [documents.tenantId, documents.organizationId, documents.id],
    }),
    check('invoice_pending_prints_print_no_check', sql`${t.printNo} >= 1`),
  ],
);
