// Drizzle tables for migration 0022_payments: customer receipts of P3 (unit U2). Money is numeric(18,2) and FX rates
// numeric(18,6), read as strings; wrap them in decimal.js, never Number(). The SQL in migrations/0022_payments.sql is
// the source of truth; this file only types the queries, so keep the two in step. payments-schema.test.ts compares
// them. Both tables are entity-owned (tenant_id + organization_id).
// Not modelled here: the payments_guard lifecycle trigger, the append-only trigger of payment_proofs, and the
// privileges (bos_app has no DELETE on payments and no UPDATE or DELETE on payment_proofs).
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
  uuid,
} from 'drizzle-orm/pg-core';

import { documents } from './documents.js';
import { users } from './identity.js';
import { withholdingCodes } from './ledger.js';
import { appSchema, organizations, parties, tenants } from './platform.js';

export const PAYMENT_STATUSES = [
  'submitted',
  'verified',
  'rejected',
  'withdrawn',
  'reversed',
] as const;
export const PAYMENT_METHODS = ['bank_transfer', 'qr', 'wire', 'cheque', 'cash'] as const;
export const PAYMENT_CHANNELS = ['staff', 'portal'] as const;
export const PAYMENT_CURRENCIES = ['NPR', 'INR', 'USD'] as const;

const money = (name: string) => numeric(name, { precision: 18, scale: 2 });

/**
 * A customer receipt. Mutable only while `submitted` (payments_guard); `verified` numbers it and freezes the NPR
 * snapshot; `settles` (= amount + tdsWithheld) is what it clears on the customer's account. Paid status of an
 * invoice is derived from allocations, never stored here. `customerPartyId` is nullable only because the tenancy
 * rule requires a nullable counterparty column; payments_customer_party_check makes it required.
 */
export const payments = appSchema.table(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id').notNull(),
    customerPartyId: uuid('customer_party_id'),
    /** Always 'customer' (stored generated), so payments_customer_party_fk refuses a vendor. Not inserted. */
    customerPartyKind: text('customer_party_kind').generatedAlwaysAs(sql`'customer'`),
    status: text('status', { enum: PAYMENT_STATUSES }).notNull().default('submitted'),
    method: text('method', { enum: PAYMENT_METHODS }).notNull(),
    currency: char('currency', { length: 3, enum: PAYMENT_CURRENCIES }).notNull(),
    /** Cash that arrived. */
    amount: money('amount').notNull(),
    /** Tax the customer withheld. */
    tdsWithheld: money('tds_withheld').notNull().default('0'),
    withholdingCodeId: uuid('withholding_code_id'),
    /** amount + tds_withheld (stored generated). Not inserted. */
    settles: money('settles').generatedAlwaysAs(sql`"amount" + "tds_withheld"`),
    receivedOn: date('received_on', { mode: 'string' }).notNull(),
    bankReference: text('bank_reference'),
    /** NPR snapshot, empty while submitted and required once verified. NPR per unit of `currency`. */
    fxRate: numeric('fx_rate', { precision: 18, scale: 6 }),
    fxSource: text('fx_source'),
    fxDate: date('fx_date', { mode: 'string' }),
    amountNpr: money('amount_npr'),
    tdsNpr: money('tds_npr'),
    /** amount_npr + tds_npr (stored generated). Not inserted. */
    settlesNpr: money('settles_npr').generatedAlwaysAs(sql`"amount_npr" + "tds_npr"`),
    submittedBy: uuid('submitted_by').notNull(),
    channel: text('channel', { enum: PAYMENT_CHANNELS }).notNull(),
    verifiedBy: uuid('verified_by'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    rejectionReason: text('rejection_reason'),
    /** RCPT-{FY}-{seq:05}, set exactly when the payment is verified or reversed (with seq and fiscalYear). */
    number: text('number'),
    seq: bigint('seq', { mode: 'number' }),
    fiscalYear: text('fiscal_year'),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('payments_tenant_id_unique').on(t.tenantId, t.id),
    unique('payments_tenant_org_id_unique').on(t.tenantId, t.organizationId, t.id),
    unique('payments_tenant_org_number_unique').on(t.tenantId, t.organizationId, t.number),
    unique('payments_tenant_org_fy_seq_unique').on(
      t.tenantId,
      t.organizationId,
      t.fiscalYear,
      t.seq,
    ),
    foreignKey({
      name: 'payments_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'payments_customer_party_fk',
      columns: [t.tenantId, t.customerPartyId, t.customerPartyKind],
      foreignColumns: [parties.tenantId, parties.id, parties.kind],
    }),
    foreignKey({
      name: 'payments_withholding_code_fk',
      columns: [t.tenantId, t.withholdingCodeId],
      foreignColumns: [withholdingCodes.tenantId, withholdingCodes.id],
    }),
    foreignKey({
      name: 'payments_submitted_by_user_fk',
      columns: [t.tenantId, t.submittedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'payments_verified_by_user_fk',
      columns: [t.tenantId, t.verifiedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    index('payments_tenant_customer_party_idx').on(t.tenantId, t.customerPartyId),
    index('payments_tenant_org_status_idx').on(t.tenantId, t.organizationId, t.status),
    check('payments_customer_party_check', sql`${t.customerPartyId} IS NOT NULL`),
    check(
      'payments_status_check',
      sql`${t.status} in ('submitted', 'verified', 'rejected', 'withdrawn', 'reversed')`,
    ),
    check(
      'payments_method_check',
      sql`${t.method} in ('bank_transfer', 'qr', 'wire', 'cheque', 'cash')`,
    ),
    check('payments_channel_check', sql`${t.channel} in ('staff', 'portal')`),
    check('payments_currency_check', sql`${t.currency} in ('NPR', 'INR', 'USD')`),
    check('payments_amount_check', sql`${t.amount} > 0`),
    check('payments_tds_withheld_check', sql`${t.tdsWithheld} >= 0`),
    check(
      'payments_bank_reference_check',
      sql`${t.bankReference} IS NULL OR btrim(${t.bankReference}) <> ''`,
    ),
    check('payments_fx_rate_check', sql`${t.fxRate} IS NULL OR ${t.fxRate} > 0`),
    check(
      'payments_npr_amounts_check',
      sql`(${t.amountNpr} IS NULL OR ${t.amountNpr} > 0) AND (${t.tdsNpr} IS NULL OR ${t.tdsNpr} >= 0)`,
    ),
    check(
      'payments_snapshot_complete_check',
      sql`(${t.fxRate} IS NULL) = (${t.amountNpr} IS NULL) AND (${t.fxRate} IS NULL) = (${t.tdsNpr} IS NULL)`,
    ),
    check(
      'payments_npr_snapshot_check',
      sql`${t.fxRate} IS NULL OR ${t.currency} <> 'NPR' OR (${t.fxRate} = 1 AND ${t.amountNpr} = ${t.amount} AND ${t.tdsNpr} = ${t.tdsWithheld})`,
    ),
    check(
      'payments_fx_source_check',
      sql`${t.fxRate} IS NULL OR ${t.currency} = 'NPR' OR (${t.fxSource} IS NOT NULL AND ${t.fxDate} IS NOT NULL)`,
    ),
    check(
      'payments_snapshot_status_check',
      sql`${t.status} NOT IN ('verified', 'reversed') OR ${t.fxRate} IS NOT NULL`,
    ),
    check(
      'payments_verifier_check',
      sql`${t.verifiedBy} IS NULL OR ${t.verifiedBy} <> ${t.submittedBy}`,
    ),
    check(
      'payments_verification_status_check',
      sql`(${t.status} IN ('verified', 'reversed')) = (${t.verifiedBy} IS NOT NULL AND ${t.verifiedAt} IS NOT NULL) AND (${t.verifiedBy} IS NULL) = (${t.verifiedAt} IS NULL)`,
    ),
    check(
      'payments_rejection_reason_check',
      sql`${t.status} <> 'rejected' OR (${t.rejectionReason} IS NOT NULL AND btrim(${t.rejectionReason}) <> '')`,
    ),
    check(
      'payments_number_complete_check',
      sql`(${t.number} IS NULL) = (${t.seq} IS NULL) AND (${t.number} IS NULL) = (${t.fiscalYear} IS NULL)`,
    ),
    check(
      'payments_number_status_check',
      sql`(${t.status} IN ('verified', 'reversed')) = (${t.number} IS NOT NULL)`,
    ),
    check(
      'payments_number_format_check',
      sql`${t.number} IS NULL OR (${t.number} LIKE 'RCPT-%' AND ${t.seq} >= 1)`,
    ),
    check('payments_version_check', sql`${t.version} >= 1`),
  ],
);

/**
 * Evidence for a payment: one row per (payment, document), both in the payment's entity. Append-only: a proof is
 * never rewritten or removed.
 */
export const paymentProofs = appSchema.table(
  'payment_proofs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id').notNull(),
    paymentId: uuid('payment_id').notNull(),
    documentId: uuid('document_id').notNull(),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('payment_proofs_tenant_org_payment_document_unique').on(
      t.tenantId,
      t.organizationId,
      t.paymentId,
      t.documentId,
    ),
    foreignKey({
      name: 'payment_proofs_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'payment_proofs_payment_fk',
      columns: [t.tenantId, t.organizationId, t.paymentId],
      foreignColumns: [payments.tenantId, payments.organizationId, payments.id],
    }),
    foreignKey({
      name: 'payment_proofs_document_fk',
      columns: [t.tenantId, t.organizationId, t.documentId],
      foreignColumns: [documents.tenantId, documents.organizationId, documents.id],
    }),
    foreignKey({
      name: 'payment_proofs_created_by_user_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    index('payment_proofs_tenant_org_document_idx').on(t.tenantId, t.organizationId, t.documentId),
  ],
);
