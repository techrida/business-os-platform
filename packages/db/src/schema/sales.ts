// Drizzle tables for migration 0020_sales_orders: the sales order (the confirmed sale), its frozen lines, tax
// summary and evidence, and its billing schedule (P3 unit U1). Money is numeric(18,2), quantities numeric(18,4)
// and FX rates numeric(18,6), all read as strings; wrap them in decimal.js, never Number().
// The SQL in migrations/0020_sales_orders.sql is the source of truth; this file only types the queries, so keep
// the two in step. sales-schema.test.ts compares them. Every table is entity-owned (ADR 0027).
// Not modelled here: the deferred schedule-sum triggers, and billing_schedule_lines_invoice_fk, which 0021 adds in
// SQL only (invoices is created there; keeping it out of this file avoids an import cycle with invoicing.ts).
import { sql } from 'drizzle-orm';
import {
  bigint,
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
} from 'drizzle-orm/pg-core';

import { customers } from './crm.js';
import { documents } from './documents.js';
import { users } from './identity.js';
import { appSchema, organizations, parties, tenants } from './platform.js';
import { quotationVersions, taxCodes } from './quotations.js';

export const SALES_ORDER_STATUSES = ['draft', 'confirmed', 'completed', 'cancelled'] as const;
/** The statuses of sales_orders_one_live_per_quotation: at most one order per quotation is in one of these. */
export const SALES_ORDER_LIVE_STATUSES = ['draft', 'confirmed', 'completed'] as const;
export const SALES_CURRENCIES = ['NPR', 'INR', 'USD'] as const;
export const SALES_ORDER_EVIDENCE_KINDS = ['contract', 'purchase_order', 'signed_quote'] as const;
export const BILLING_TRIGGERS = [
  'advance',
  'milestone',
  'uat',
  'delivery',
  'date',
  'manual',
] as const;
export const BILLING_SCHEDULE_STATUSES = [
  'planned',
  'billable',
  'drafted',
  'invoiced',
  'cancelled',
] as const;

const money = (name: string) => numeric(name, { precision: 18, scale: 2 });
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/**
 * The confirmed sale of one quotation version. `number`, `seq` and `fiscalYear` are set together at confirm (SO
 * series) and never on a draft. One live (not cancelled) order per quotation. `customerPartyId` is nullable in the
 * type (ADR 0027 counterparty rule) but required by sales_orders_customer_check.
 */
export const salesOrders = appSchema.table(
  'sales_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id').notNull(),
    number: text('number'),
    seq: bigint('seq', { mode: 'number' }),
    /** BS fiscal year, e.g. '2083/84'. */
    fiscalYear: text('fiscal_year'),
    customerPartyId: uuid('customer_party_id'),
    /** Always 'customer' (stored generated), so sales_orders_customer_party_fk refuses a vendor. Not inserted. */
    customerPartyKind: text('customer_party_kind').generatedAlwaysAs(sql`'customer'`),
    quotationId: uuid('quotation_id').notNull(),
    quotationVersionId: uuid('quotation_version_id').notNull(),
    status: text('status', { enum: SALES_ORDER_STATUSES }).notNull().default('draft'),
    currency: char('currency', { length: 3, enum: SALES_CURRENCIES }).notNull(),
    subtotal: money('subtotal').notNull(),
    discountAmount: money('discount_amount').notNull().default('0'),
    taxableAmount: money('taxable_amount').notNull(),
    taxAmount: money('tax_amount').notNull(),
    total: money('total').notNull(),
    /** NPR per unit of `currency` (1 for NPR). */
    fxRate: numeric('fx_rate', { precision: 18, scale: 6 }).notNull(),
    fxSource: text('fx_source'),
    fxDate: date('fx_date', { mode: 'string' }),
    /** NPR snapshot of `total`. */
    amountNpr: money('amount_npr').notNull(),
    calcVersion: integer('calc_version').notNull().default(1),
    creditDays: integer('credit_days').notNull().default(0),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    confirmedBy: uuid('confirmed_by'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),
    createdBy: uuid('created_by'),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('sales_orders_tenant_id_unique').on(t.tenantId, t.id),
    unique('sales_orders_tenant_org_id_unique').on(t.tenantId, t.organizationId, t.id),
    unique('sales_orders_tenant_org_number_unique').on(t.tenantId, t.organizationId, t.number),
    unique('sales_orders_tenant_org_fy_seq_unique').on(
      t.tenantId,
      t.organizationId,
      t.fiscalYear,
      t.seq,
    ),
    foreignKey({
      name: 'sales_orders_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'sales_orders_customer_party_fk',
      columns: [t.tenantId, t.customerPartyId, t.customerPartyKind],
      foreignColumns: [parties.tenantId, parties.id, parties.kind],
    }),
    foreignKey({
      name: 'sales_orders_customer_fk',
      columns: [t.tenantId, t.customerPartyId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
    foreignKey({
      name: 'sales_orders_quotation_version_fk',
      columns: [t.tenantId, t.organizationId, t.quotationId, t.quotationVersionId],
      foreignColumns: [
        quotationVersions.tenantId,
        quotationVersions.organizationId,
        quotationVersions.quotationId,
        quotationVersions.id,
      ],
    }),
    foreignKey({
      name: 'sales_orders_confirmed_by_user_fk',
      columns: [t.tenantId, t.confirmedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'sales_orders_created_by_user_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    uniqueIndex('sales_orders_one_live_per_quotation')
      .on(t.tenantId, t.organizationId, t.quotationId)
      .where(sql`${t.status} <> 'cancelled'`),
    index('sales_orders_tenant_customer_party_idx').on(t.tenantId, t.customerPartyId),
    index('sales_orders_tenant_org_status_idx').on(t.tenantId, t.organizationId, t.status),
    check(
      'sales_orders_status_check',
      sql`${t.status} in ('draft', 'confirmed', 'completed', 'cancelled')`,
    ),
    check('sales_orders_customer_check', sql`${t.customerPartyId} IS NOT NULL`),
    check('sales_orders_currency_check', sql`${t.currency} in ('NPR', 'INR', 'USD')`),
    check(
      'sales_orders_amounts_check',
      sql`${t.subtotal} >= 0 AND ${t.discountAmount} >= 0 AND ${t.discountAmount} <= ${t.subtotal} AND ${t.taxAmount} >= 0 AND ${t.total} > 0`,
    ),
    check(
      'sales_orders_taxable_check',
      sql`${t.taxableAmount} = ${t.subtotal} - ${t.discountAmount}`,
    ),
    check('sales_orders_total_check', sql`${t.total} = ${t.taxableAmount} + ${t.taxAmount}`),
    check('sales_orders_fx_rate_check', sql`${t.fxRate} > 0`),
    check('sales_orders_amount_npr_check', sql`${t.amountNpr} > 0`),
    check(
      'sales_orders_npr_snapshot_check',
      sql`${t.currency} <> 'NPR' OR (${t.fxRate} = 1 AND ${t.amountNpr} = ${t.total})`,
    ),
    check(
      'sales_orders_fx_source_check',
      sql`${t.currency} = 'NPR' OR (${t.fxSource} IS NOT NULL AND ${t.fxDate} IS NOT NULL)`,
    ),
    check('sales_orders_calc_version_check', sql`${t.calcVersion} >= 1`),
    check('sales_orders_credit_days_check', sql`${t.creditDays} BETWEEN 0 AND 365`),
    check(
      'sales_orders_number_parts_check',
      sql`(${t.number} IS NULL) = (${t.seq} IS NULL) AND (${t.number} IS NULL) = (${t.fiscalYear} IS NULL) AND ${t.seq} >= 1 AND ${t.fiscalYear} ~ '^[0-9]{4}/[0-9]{2}$'`,
    ),
    check(
      'sales_orders_number_status_check',
      sql`(${t.status} <> 'draft' OR ${t.number} IS NULL) AND (${t.status} NOT IN ('confirmed', 'completed') OR (${t.number} IS NOT NULL AND ${t.confirmedAt} IS NOT NULL))`,
    ),
    check(
      'sales_orders_cancel_check',
      sql`(${t.status} = 'cancelled') = (${t.cancelledAt} IS NOT NULL) AND (${t.status} <> 'cancelled' OR ${t.cancelReason} IS NOT NULL)`,
    ),
    check('sales_orders_version_check', sql`${t.version} >= 1`),
  ],
);

/** A frozen copy of one accepted-version line. gross = round(quantity * unitPrice, 2); taxable = gross - discount. */
export const salesOrderLines = appSchema.table(
  'sales_order_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id').notNull(),
    salesOrderId: uuid('sales_order_id').notNull(),
    lineNo: integer('line_no').notNull(),
    description: text('description').notNull(),
    uom: text('uom').notNull(),
    quantity: numeric('quantity', { precision: 18, scale: 4 }).notNull(),
    unitPrice: money('unit_price').notNull(),
    taxCodeId: uuid('tax_code_id').notNull(),
    gross: money('gross').notNull(),
    discountAlloc: money('discount_alloc').notNull().default('0'),
    taxable: money('taxable').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('sales_order_lines_tenant_id_unique').on(t.tenantId, t.id),
    unique('sales_order_lines_tenant_org_order_line_no_unique').on(
      t.tenantId,
      t.organizationId,
      t.salesOrderId,
      t.lineNo,
    ),
    foreignKey({
      name: 'sales_order_lines_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'sales_order_lines_sales_order_fk',
      columns: [t.tenantId, t.organizationId, t.salesOrderId],
      foreignColumns: [salesOrders.tenantId, salesOrders.organizationId, salesOrders.id],
    }),
    foreignKey({
      name: 'sales_order_lines_tax_code_fk',
      columns: [t.tenantId, t.taxCodeId],
      foreignColumns: [taxCodes.tenantId, taxCodes.id],
    }),
    index('sales_order_lines_tenant_tax_code_idx').on(t.tenantId, t.taxCodeId),
    check('sales_order_lines_line_no_check', sql`${t.lineNo} >= 1`),
    check('sales_order_lines_quantity_check', sql`${t.quantity} > 0`),
    check('sales_order_lines_unit_price_check', sql`${t.unitPrice} >= 0`),
    check(
      'sales_order_lines_gross_check',
      sql`${t.gross} = round(${t.quantity} * ${t.unitPrice}, 2)`,
    ),
    check(
      'sales_order_lines_discount_alloc_check',
      sql`${t.discountAlloc} >= 0 AND ${t.discountAlloc} <= ${t.gross}`,
    ),
    check('sales_order_lines_taxable_check', sql`${t.taxable} = ${t.gross} - ${t.discountAlloc}`),
  ],
);

/** Tax per tax code of an order, copied from the version. `rate` is percent, numeric(7,4). */
export const salesOrderTaxSummary = appSchema.table(
  'sales_order_tax_summary',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id').notNull(),
    salesOrderId: uuid('sales_order_id').notNull(),
    taxCodeId: uuid('tax_code_id').notNull(),
    label: text('label').notNull(),
    rate: numeric('rate', { precision: 7, scale: 4 }).notNull(),
    base: money('base').notNull(),
    tax: money('tax').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('sales_order_tax_summary_tenant_id_unique').on(t.tenantId, t.id),
    unique('sales_order_tax_summary_tenant_org_order_tax_code_unique').on(
      t.tenantId,
      t.organizationId,
      t.salesOrderId,
      t.taxCodeId,
    ),
    foreignKey({
      name: 'sales_order_tax_summary_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'sales_order_tax_summary_sales_order_fk',
      columns: [t.tenantId, t.organizationId, t.salesOrderId],
      foreignColumns: [salesOrders.tenantId, salesOrders.organizationId, salesOrders.id],
    }),
    foreignKey({
      name: 'sales_order_tax_summary_tax_code_fk',
      columns: [t.tenantId, t.taxCodeId],
      foreignColumns: [taxCodes.tenantId, taxCodes.id],
    }),
    check('sales_order_tax_summary_rate_check', sql`${t.rate} BETWEEN 0 AND 100`),
    check('sales_order_tax_summary_amounts_check', sql`${t.base} >= 0 AND ${t.tax} >= 0`),
  ],
);

/** A kernel document the order was confirmed on (contract, purchase order, signed quotation). */
export const salesOrderEvidence = appSchema.table(
  'sales_order_evidence',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id').notNull(),
    salesOrderId: uuid('sales_order_id').notNull(),
    evidenceKind: text('evidence_kind', { enum: SALES_ORDER_EVIDENCE_KINDS }).notNull(),
    documentId: uuid('document_id').notNull(),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('sales_order_evidence_tenant_id_unique').on(t.tenantId, t.id),
    unique('sales_order_evidence_tenant_org_order_document_unique').on(
      t.tenantId,
      t.organizationId,
      t.salesOrderId,
      t.documentId,
    ),
    foreignKey({
      name: 'sales_order_evidence_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'sales_order_evidence_sales_order_fk',
      columns: [t.tenantId, t.organizationId, t.salesOrderId],
      foreignColumns: [salesOrders.tenantId, salesOrders.organizationId, salesOrders.id],
    }),
    foreignKey({
      name: 'sales_order_evidence_document_fk',
      columns: [t.tenantId, t.organizationId, t.documentId],
      foreignColumns: [documents.tenantId, documents.organizationId, documents.id],
    }),
    foreignKey({
      name: 'sales_order_evidence_created_by_user_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    check(
      'sales_order_evidence_kind_check',
      sql`${t.evidenceKind} in ('contract', 'purchase_order', 'signed_quote')`,
    ),
  ],
);

/**
 * Migration 0155: a manual release of an order's delivery hold (F1-Q32). One per order and final (a SQL-only guard
 * trigger refuses UPDATE and DELETE). `orderAmountNpr` and `thresholdNpr` snapshot the amount and the
 * `sales.delivery_hold.management_npr` setting the release rule was decided with.
 */
export const salesOrderDeliveryReleases = appSchema.table(
  'sales_order_delivery_releases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id').notNull(),
    salesOrderId: uuid('sales_order_id').notNull(),
    releasedByUserId: uuid('released_by_user_id').notNull(),
    reason: text('reason').notNull(),
    orderAmountNpr: money('order_amount_npr').notNull(),
    thresholdNpr: money('threshold_npr').notNull(),
    releasedAt: timestamp('released_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('sales_order_delivery_releases_tenant_org_id_unique').on(
      t.tenantId,
      t.organizationId,
      t.id,
    ),
    unique('sales_order_delivery_releases_order_unique').on(
      t.tenantId,
      t.organizationId,
      t.salesOrderId,
    ),
    foreignKey({
      name: 'sales_order_delivery_releases_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'sales_order_delivery_releases_sales_order_fk',
      columns: [t.tenantId, t.organizationId, t.salesOrderId],
      foreignColumns: [salesOrders.tenantId, salesOrders.organizationId, salesOrders.id],
    }),
    foreignKey({
      name: 'sales_order_delivery_releases_released_by_fk',
      columns: [t.tenantId, t.releasedByUserId],
      foreignColumns: [users.tenantId, users.id],
    }),
    check(
      'sales_order_delivery_releases_reason_check',
      sql`btrim(${t.reason}) <> '' AND length(${t.reason}) <= 1000`,
    ),
    check(
      'sales_order_delivery_releases_amount_check',
      sql`${t.orderAmountNpr} > 0 AND ${t.thresholdNpr} >= 0`,
    ),
  ],
);

/**
 * One VAT-inclusive slice of an order's total. At commit, the live (not cancelled) lines of an order sum to its
 * total (SQL-only deferred trigger). `invoiceId` is set exactly while drafted or invoiced.
 */
export const billingScheduleLines = appSchema.table(
  'billing_schedule_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id').notNull(),
    salesOrderId: uuid('sales_order_id').notNull(),
    seq: integer('seq').notNull(),
    label: text('label').notNull(),
    trigger: text('trigger', { enum: BILLING_TRIGGERS }).notNull(),
    /** Informational exact share in percent, numeric(7,4): 33.3334 = 33.3334%. Null for a line added by amount. */
    percent: numeric('percent', { precision: 7, scale: 4 }),
    amount: money('amount').notNull(),
    /** NPR value of `amount` at the order's rate. */
    amountNpr: money('amount_npr').notNull(),
    plannedDate: date('planned_date', { mode: 'string' }),
    status: text('status', { enum: BILLING_SCHEDULE_STATUSES }).notNull().default('planned'),
    billableEvidenceDocumentId: uuid('billable_evidence_document_id'),
    billableMarkedBy: uuid('billable_marked_by'),
    billableMarkedAt: timestamp('billable_marked_at', { withTimezone: true }),
    invoiceId: uuid('invoice_id'),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('billing_schedule_lines_tenant_id_unique').on(t.tenantId, t.id),
    unique('billing_schedule_lines_tenant_org_id_unique').on(t.tenantId, t.organizationId, t.id),
    unique('billing_schedule_lines_tenant_org_order_id_unique').on(
      t.tenantId,
      t.organizationId,
      t.salesOrderId,
      t.id,
    ),
    unique('billing_schedule_lines_tenant_org_order_seq_unique').on(
      t.tenantId,
      t.organizationId,
      t.salesOrderId,
      t.seq,
    ),
    foreignKey({
      name: 'billing_schedule_lines_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'billing_schedule_lines_sales_order_fk',
      columns: [t.tenantId, t.organizationId, t.salesOrderId],
      foreignColumns: [salesOrders.tenantId, salesOrders.organizationId, salesOrders.id],
    }),
    foreignKey({
      name: 'billing_schedule_lines_evidence_document_fk',
      columns: [t.tenantId, t.organizationId, t.billableEvidenceDocumentId],
      foreignColumns: [documents.tenantId, documents.organizationId, documents.id],
    }),
    foreignKey({
      name: 'billing_schedule_lines_billable_marked_by_user_fk',
      columns: [t.tenantId, t.billableMarkedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    index('billing_schedule_lines_tenant_org_invoice_idx').on(
      t.tenantId,
      t.organizationId,
      t.invoiceId,
    ),
    check('billing_schedule_lines_seq_check', sql`${t.seq} >= 1`),
    check(
      'billing_schedule_lines_trigger_check',
      sql`${t.trigger} in ('advance', 'milestone', 'uat', 'delivery', 'date', 'manual')`,
    ),
    check(
      'billing_schedule_lines_status_check',
      sql`${t.status} in ('planned', 'billable', 'drafted', 'invoiced', 'cancelled')`,
    ),
    check('billing_schedule_lines_percent_check', sql`${t.percent} BETWEEN 0.0001 AND 100`),
    check('billing_schedule_lines_amount_check', sql`${t.amount} > 0 AND ${t.amountNpr} > 0`),
    check(
      'billing_schedule_lines_invoice_check',
      sql`(${t.status} IN ('drafted', 'invoiced')) = (${t.invoiceId} IS NOT NULL)`,
    ),
    check('billing_schedule_lines_version_check', sql`${t.version} >= 1`),
  ],
);
