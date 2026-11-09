// Drizzle tables for migration 0019_open_items: the AR/AP subledger (P3 unit U0-A; P4 reuses it for payables) and
// the tenant-level withholding codes. Money is numeric(18,2) and FX rates numeric(18,6), read as strings; wrap them
// in decimal.js, never Number(). The SQL in migrations/0019_open_items.sql is the source of truth; this file only
// types the queries, so keep the two in step. ledger-schema.test.ts compares them.
// withholding_codes is tenant-level (ADR 0027 section 6); the three ledger tables are entity-owned and append-only.
// Only LedgerService (apps/api modules/ledger) writes them.
// Not modelled here: the EXCLUDE constraint withholding_codes_no_overlap (Drizzle 0.45 has no EXCLUDE), the
// append-only, match and cap triggers, and the privileges. open_item_balances is declared as an existing view.
import { sql } from 'drizzle-orm';
import {
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { users } from './identity.js';
import { appSchema, organizations, parties, tenants } from './platform.js';

export const LEDGER_SIDES = ['receivable', 'payable'] as const;
export const LEDGER_DIRECTIONS = ['debit', 'credit'] as const;
export const LEDGER_CURRENCIES = ['NPR', 'INR', 'USD'] as const;
/** Source documents of a receivable item (open_items_source_side_check). */
export const RECEIVABLE_SOURCE_TYPES = [
  'tax_invoice',
  'debit_note',
  'credit_note',
  'payment',
] as const;
/** Source documents of a payable item (P4). */
export const PAYABLE_SOURCE_TYPES = ['vendor_bill', 'vendor_payment', 'vendor_debit_note'] as const;
export const OPEN_ITEM_SOURCE_TYPES = [
  ...RECEIVABLE_SOURCE_TYPES,
  ...PAYABLE_SOURCE_TYPES,
] as const;
/** posting_events also keys allocation events by the allocation row. */
export const POSTING_EVENT_SOURCE_TYPES = [...OPEN_ITEM_SOURCE_TYPES, 'allocation'] as const;
/** The PostingEvent union of LedgerService: P3's seven and P4's three. */
export const POSTING_EVENTS = [
  'invoice_issued',
  'debit_note_issued',
  'credit_note_issued',
  'payment_verified',
  'payment_reversed',
  'allocation',
  'allocation_reversed',
  'vendor_bill_posted',
  'vendor_payment_made',
  'vendor_debit_note_issued',
] as const;
export const WITHHOLDING_APPLIES_TO = ['receivable', 'payable', 'both'] as const;

const money = (name: string) => numeric(name, { precision: 18, scale: 2 });
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

// ---------------------------------------------------------------------------------------------------------------
// Tenant-level table
// ---------------------------------------------------------------------------------------------------------------

/**
 * A withholding (TDS) code period, effective [effectiveFrom, effectiveTo). Periods of one code never overlap in a
 * tenant (the SQL-only EXCLUDE constraint withholding_codes_no_overlap). `rateBp` is basis points.
 */
export const withholdingCodes = appSchema.table(
  'withholding_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    appliesTo: text('applies_to', { enum: WITHHOLDING_APPLIES_TO }).notNull(),
    rateBp: integer('rate_bp').notNull(),
    effectiveFrom: date('effective_from', { mode: 'string' }).notNull(),
    /** Exclusive. */
    effectiveTo: date('effective_to', { mode: 'string' }),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('withholding_codes_tenant_id_unique').on(t.tenantId, t.id),
    check(
      'withholding_codes_applies_to_check',
      sql`${t.appliesTo} in ('receivable', 'payable', 'both')`,
    ),
    check('withholding_codes_rate_bp_check', sql`${t.rateBp} BETWEEN 0 AND 10000`),
    check(
      'withholding_codes_period_check',
      sql`${t.effectiveTo} IS NULL OR ${t.effectiveTo} > ${t.effectiveFrom}`,
    ),
    check('withholding_codes_version_check', sql`${t.version} >= 1`),
  ],
);

// ---------------------------------------------------------------------------------------------------------------
// Entity-owned, append-only tables
// ---------------------------------------------------------------------------------------------------------------

/**
 * One amount a source document leaves owed. One per (entity, sourceType, sourceId). The counterparty is
 * `customerPartyId` on the receivable side and `vendorPartyId` on the payable side, never both. `amount` is
 * positive; `direction` says which way it counts. `createdBy` is null for a system actor.
 */
export const openItems = appSchema.table(
  'open_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id').notNull(),
    side: text('side', { enum: LEDGER_SIDES }).notNull(),
    direction: text('direction', { enum: LEDGER_DIRECTIONS }).notNull(),
    customerPartyId: uuid('customer_party_id'),
    /** Always 'customer' (stored generated), so open_items_customer_party_fk refuses a vendor. Not inserted. */
    customerPartyKind: text('customer_party_kind').generatedAlwaysAs(sql`'customer'`),
    vendorPartyId: uuid('vendor_party_id'),
    /** Always 'vendor' (stored generated), so open_items_vendor_party_fk refuses a customer. Not inserted. */
    vendorPartyKind: text('vendor_party_kind').generatedAlwaysAs(sql`'vendor'`),
    sourceType: text('source_type', { enum: OPEN_ITEM_SOURCE_TYPES }).notNull(),
    sourceId: uuid('source_id').notNull(),
    currency: char('currency', { length: 3, enum: LEDGER_CURRENCIES }).notNull(),
    amount: money('amount').notNull(),
    /** NPR snapshot: equal to `amount` (with fxRate 1) for an NPR item. */
    amountNpr: money('amount_npr').notNull(),
    /** NPR per unit of `currency`. */
    fxRate: numeric('fx_rate', { precision: 18, scale: 6 }).notNull(),
    fxSource: text('fx_source'),
    fxDate: date('fx_date', { mode: 'string' }),
    documentDate: date('document_date', { mode: 'string' }).notNull(),
    dueDate: date('due_date', { mode: 'string' }),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('open_items_tenant_id_unique').on(t.tenantId, t.id),
    unique('open_items_tenant_org_id_unique').on(t.tenantId, t.organizationId, t.id),
    unique('open_items_tenant_org_source_unique').on(
      t.tenantId,
      t.organizationId,
      t.sourceType,
      t.sourceId,
    ),
    foreignKey({
      name: 'open_items_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'open_items_customer_party_fk',
      columns: [t.tenantId, t.customerPartyId, t.customerPartyKind],
      foreignColumns: [parties.tenantId, parties.id, parties.kind],
    }),
    foreignKey({
      name: 'open_items_vendor_party_fk',
      columns: [t.tenantId, t.vendorPartyId, t.vendorPartyKind],
      foreignColumns: [parties.tenantId, parties.id, parties.kind],
    }),
    foreignKey({
      name: 'open_items_created_by_user_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    index('open_items_tenant_customer_party_idx').on(t.tenantId, t.customerPartyId),
    index('open_items_tenant_vendor_party_idx').on(t.tenantId, t.vendorPartyId),
    check('open_items_side_check', sql`${t.side} in ('receivable', 'payable')`),
    check('open_items_direction_check', sql`${t.direction} in ('debit', 'credit')`),
    check(
      'open_items_party_side_check',
      sql`(${t.side} = 'receivable' AND ${t.customerPartyId} IS NOT NULL AND ${t.vendorPartyId} IS NULL) OR (${t.side} = 'payable' AND ${t.vendorPartyId} IS NOT NULL AND ${t.customerPartyId} IS NULL)`,
    ),
    check(
      'open_items_source_type_check',
      sql`${t.sourceType} in ('tax_invoice', 'debit_note', 'credit_note', 'payment', 'vendor_bill', 'vendor_payment', 'vendor_debit_note')`,
    ),
    check(
      'open_items_source_side_check',
      sql`(${t.side} = 'receivable') = (${t.sourceType} in ('tax_invoice', 'debit_note', 'credit_note', 'payment'))`,
    ),
    check('open_items_currency_check', sql`${t.currency} in ('NPR', 'INR', 'USD')`),
    check('open_items_amount_check', sql`${t.amount} > 0`),
    check('open_items_amount_npr_check', sql`${t.amountNpr} > 0`),
    check('open_items_fx_rate_check', sql`${t.fxRate} > 0`),
    check(
      'open_items_npr_snapshot_check',
      sql`${t.currency} <> 'NPR' OR (${t.fxRate} = 1 AND ${t.amountNpr} = ${t.amount})`,
    ),
    check(
      'open_items_fx_source_check',
      sql`${t.currency} = 'NPR' OR (${t.fxSource} IS NOT NULL AND ${t.fxDate} IS NOT NULL)`,
    ),
    check(
      'open_items_due_date_check',
      sql`${t.dueDate} IS NULL OR ${t.dueDate} >= ${t.documentDate}`,
    ),
  ],
);

/**
 * One allocation of a credit item against a debit item of the same side, party and currency. A reversal has the
 * negative amount, names the allocation it undoes (once) and its two items, and needs a reason.
 */
export const openItemAllocations = appSchema.table(
  'open_item_allocations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id').notNull(),
    debitItemId: uuid('debit_item_id').notNull(),
    creditItemId: uuid('credit_item_id').notNull(),
    /** Positive to allocate, negative (exactly minus the original) on a reversal. */
    amount: money('amount').notNull(),
    reversesAllocationId: uuid('reverses_allocation_id'),
    reason: text('reason'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('open_item_allocations_tenant_id_unique').on(t.tenantId, t.id),
    unique('open_item_allocations_tenant_org_id_unique').on(t.tenantId, t.organizationId, t.id),
    unique('open_item_allocations_tenant_reverses_unique').on(t.tenantId, t.reversesAllocationId),
    foreignKey({
      name: 'open_item_allocations_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'open_item_allocations_debit_item_fk',
      columns: [t.tenantId, t.organizationId, t.debitItemId],
      foreignColumns: [openItems.tenantId, openItems.organizationId, openItems.id],
    }),
    foreignKey({
      name: 'open_item_allocations_credit_item_fk',
      columns: [t.tenantId, t.organizationId, t.creditItemId],
      foreignColumns: [openItems.tenantId, openItems.organizationId, openItems.id],
    }),
    foreignKey({
      name: 'open_item_allocations_reverses_fk',
      columns: [t.tenantId, t.organizationId, t.reversesAllocationId],
      foreignColumns: [t.tenantId, t.organizationId, t.id],
    }),
    foreignKey({
      name: 'open_item_allocations_created_by_user_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    index('open_item_allocations_tenant_org_debit_idx').on(
      t.tenantId,
      t.organizationId,
      t.debitItemId,
    ),
    index('open_item_allocations_tenant_org_credit_idx').on(
      t.tenantId,
      t.organizationId,
      t.creditItemId,
    ),
    check('open_item_allocations_amount_check', sql`${t.amount} <> 0`),
    check(
      'open_item_allocations_reversal_sign_check',
      sql`(${t.amount} < 0) = (${t.reversesAllocationId} IS NOT NULL)`,
    ),
    check(
      'open_item_allocations_reversal_reason_check',
      sql`${t.reversesAllocationId} IS NULL OR ${t.reason} IS NOT NULL`,
    ),
    check('open_item_allocations_items_check', sql`${t.debitItemId} <> ${t.creditItemId}`),
  ],
);

/** One business event per (entity, sourceType, sourceId, event); allocation events use sourceType 'allocation'. */
export const postingEvents = appSchema.table(
  'posting_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id').notNull(),
    sourceType: text('source_type', { enum: POSTING_EVENT_SOURCE_TYPES }).notNull(),
    sourceId: uuid('source_id').notNull(),
    event: text('event', { enum: POSTING_EVENTS }).notNull(),
    payload: jsonb('payload')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('posting_events_tenant_id_unique').on(t.tenantId, t.id),
    unique('posting_events_tenant_org_source_event_unique').on(
      t.tenantId,
      t.organizationId,
      t.sourceType,
      t.sourceId,
      t.event,
    ),
    foreignKey({
      name: 'posting_events_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'posting_events_created_by_user_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    check(
      'posting_events_source_type_check',
      sql`${t.sourceType} in ('tax_invoice', 'debit_note', 'credit_note', 'payment', 'vendor_bill', 'vendor_payment', 'vendor_debit_note', 'allocation')`,
    ),
    check(
      'posting_events_event_check',
      sql`${t.event} in ('invoice_issued', 'debit_note_issued', 'credit_note_issued', 'payment_verified', 'payment_reversed', 'allocation', 'allocation_reversed', 'vendor_bill_posted', 'vendor_payment_made', 'vendor_debit_note_issued')`,
    ),
    check('posting_events_payload_check', sql`jsonb_typeof(${t.payload}) = 'object'`),
  ],
);

/**
 * Derived balance of every open item (A8: paid is never stored). `allocatedAmount` is the net of its allocations
 * and reversals; `openAmount` = amount - allocatedAmount, always within [0, amount] after commit.
 */
export const openItemBalances = appSchema
  .view('open_item_balances', {
    openItemId: uuid('open_item_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    organizationId: uuid('organization_id').notNull(),
    side: text('side', { enum: LEDGER_SIDES }).notNull(),
    direction: text('direction', { enum: LEDGER_DIRECTIONS }).notNull(),
    customerPartyId: uuid('customer_party_id'),
    vendorPartyId: uuid('vendor_party_id'),
    sourceType: text('source_type', { enum: OPEN_ITEM_SOURCE_TYPES }).notNull(),
    sourceId: uuid('source_id').notNull(),
    currency: char('currency', { length: 3, enum: LEDGER_CURRENCIES }).notNull(),
    amount: money('amount').notNull(),
    allocatedAmount: money('allocated_amount').notNull(),
    openAmount: money('open_amount').notNull(),
    documentDate: date('document_date', { mode: 'string' }).notNull(),
    dueDate: date('due_date', { mode: 'string' }),
  })
  .existing();
