// Drizzle tables for migration 0032_vendors: the vendors of P4 (the vendor record, its contacts, the per-entity vendor
// account and the maker-checker bank accounts). A vendor is a party (ADR 0027), the twin of 0015's customer.
// The SQL in migrations/0032_vendors.sql is the source of truth; this file only types the queries, so keep the two in
// step (a change is a new migration, never an edit of an old one). vendors-schema.test.ts compares their names.
// vendors, vendor_contacts and vendor_bank_accounts are tenant-level (no organization_id, ADR 0027 D17); vendor_accounts
// is entity-owned. A FK into a tenant-level table is (tenant_id, x).
import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  customType,
  foreignKey,
  index,
  integer,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type PgTableExtraConfigValue,
} from 'drizzle-orm/pg-core';

import { PHONE_LABELS } from './crm.js';
import { documents } from './documents.js';
import { users } from './identity.js';
import { appSchema, organizations, parties, tenants } from './platform.js';
import { paymentTerms } from './quotations.js';

// These mirror the catalogues the vendor services of P4 will put in @bos/contracts (the db package does not depend
// on contracts).
export const VENDOR_KINDS = ['company', 'proprietor', 'individual', 'foreign'] as const;
export const VENDOR_STATUSES = [
  'draft',
  'pending_kyc',
  'under_review',
  'approved',
  'suspended',
  'blocked',
  'archived',
] as const;
export const VENDOR_BANK_ACCOUNT_STATUSES = ['proposed', 'active', 'retired', 'rejected'] as const;
export const VENDOR_BANK_PROPOSED_VIA = ['staff', 'portal'] as const;

/** Postgres bytea as a Node Buffer (the encrypted account number). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

// ---------------------------------------------------------------------------------------------------------------
// Tenant-level tables
// ---------------------------------------------------------------------------------------------------------------

/**
 * A vendor: the procurement record of a vendor party. `id` is the party id (no default: the party row comes first).
 * Tenant-level, so one vendor for every legal entity of the tenant.
 */
export const vendors = appSchema.table(
  'vendors',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /**
     * Always 'vendor' (a stored generated column), so vendors_party_fk makes the database refuse a customer
     * party. Left out of inserts; the FK allows only NO ACTION.
     */
    partyKind: text('party_kind').generatedAlwaysAs(sql`'vendor'`),
    /** The name on the PAN certificate. */
    legalName: text('legal_name').notNull(),
    kind: text('kind', { enum: VENDOR_KINDS }).notNull().default('company'),
    /** Nine digits (CHECK), absent only for a foreign vendor; unique per tenant. */
    pan: text('pan'),
    vatRegistered: boolean('vat_registered').notNull().default(false),
    /** ISO 3166-1 alpha-2; not 'NP' exactly when kind is 'foreign' (CHECK). */
    country: char('country', { length: 2 }).notNull().default('NP'),
    /** The street lines of the address (0191); set together with addressCity or not at all (CHECK). */
    addressLine: text('address_line'),
    /** The address's city (0191); the address's country is `country`. */
    addressCity: text('address_city'),
    status: text('status', { enum: VENDOR_STATUSES }).notNull().default('draft'),
    ownerUserId: uuid('owner_user_id'),
    createdBy: uuid('created_by').notNull(),
    /** Never the creator (CHECK), and required once the vendor is approved. */
    approvedBy: uuid('approved_by'),
    /**
     * The logo, an `app.documents.id` (migration 0054). No foreign key: documents are owned per tenant and
     * entity. NULL shows the initials avatar.
     */
    logoDocumentId: uuid('logo_document_id'),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (t): PgTableExtraConfigValue[] => [
    unique('vendors_tenant_id_unique').on(t.tenantId, t.id),
    foreignKey({
      name: 'vendors_party_fk',
      columns: [t.tenantId, t.id, t.partyKind],
      foreignColumns: [parties.tenantId, parties.id, parties.kind],
    }),
    foreignKey({
      name: 'vendors_owner_user_fk',
      columns: [t.tenantId, t.ownerUserId],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'vendors_created_by_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'vendors_approved_by_fk',
      columns: [t.tenantId, t.approvedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    // PostgreSQL has no partial unique constraint, so this is a unique index.
    uniqueIndex('vendors_tenant_pan_unique')
      .on(t.tenantId, t.pan)
      .where(sql`${t.pan} IS NOT NULL`),
    index('vendors_tenant_status_idx').on(t.tenantId, t.status),
    check(
      'vendors_kind_check',
      sql`${t.kind} in ('company', 'proprietor', 'individual', 'foreign')`,
    ),
    check(
      'vendors_status_check',
      sql`${t.status} in ('draft', 'pending_kyc', 'under_review', 'approved', 'suspended', 'blocked', 'archived')`,
    ),
    check('vendors_country_check', sql`${t.country} ~ '^[A-Z]{2}$'`),
    check('vendors_foreign_country_check', sql`(${t.kind} = 'foreign') = (${t.country} <> 'NP')`),
    check(
      'vendors_address_check',
      sql`(${t.addressLine} IS NULL) = (${t.addressCity} IS NULL) AND btrim(${t.addressLine}) <> '' AND btrim(${t.addressCity}) <> ''`,
    ),
    check(
      'vendors_pan_check',
      sql`${t.kind} = 'foreign' OR (${t.pan} IS NOT NULL AND ${t.pan} ~ '^[0-9]{9}$')`,
    ),
    check('vendors_pan_format_check', sql`${t.pan} ~ '^[A-Z0-9-]{5,20}$'`),
    check('vendors_approved_by_check', sql`${t.approvedBy} <> ${t.createdBy}`),
    check('vendors_approval_check', sql`${t.status} <> 'approved' OR ${t.approvedBy} IS NOT NULL`),
    check('vendors_version_check', sql`${t.version} >= 1`),
  ],
);

/** A person at a vendor. Tenant-level, like the vendor. */
export const vendorContacts = appSchema.table(
  'vendor_contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    vendorId: uuid('vendor_id').notNull(),
    fullName: text('full_name').notNull(),
    /** Lower-cased and trimmed (CHECK). */
    emailNorm: text('email_norm'),
    /** ISO 3166-1 alpha-2 (0191, CHECK); may differ from the vendor's. Phones: vendorContactPhones. */
    country: char('country', { length: 2 }).notNull().default('NP'),
    title: text('title'),
    isPrimary: boolean('is_primary').notNull().default(false),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (t) => [
    unique('vendor_contacts_tenant_id_unique').on(t.tenantId, t.id),
    foreignKey({
      name: 'vendor_contacts_vendor_fk',
      columns: [t.tenantId, t.vendorId],
      foreignColumns: [vendors.tenantId, vendors.id],
    }),
    uniqueIndex('vendor_contacts_tenant_vendor_primary_unique')
      .on(t.tenantId, t.vendorId)
      .where(sql`${t.isPrimary}`),
    index('vendor_contacts_tenant_vendor_idx').on(t.tenantId, t.vendorId),
    index('vendor_contacts_tenant_email_norm_idx').on(t.tenantId, t.emailNorm),
    check('vendor_contacts_email_norm_check', sql`${t.emailNorm} = lower(btrim(${t.emailNorm}))`),
    check('vendor_contacts_country_check', sql`${t.country} ~ '^[A-Z]{2}$'`),
    check('vendor_contacts_version_check', sql`${t.version} >= 1`),
  ],
);

/**
 * A phone number of a vendor contact (0192). Tenant-level, like the contact; deleted with it. Same columns and
 * rules as customerContactPhones (crm.ts).
 */
export const vendorContactPhones = appSchema.table(
  'vendor_contact_phones',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    contactId: uuid('contact_id').notNull(),
    country: char('country', { length: 2 }).notNull(),
    e164: text('e164').notNull(),
    label: text('label', { enum: PHONE_LABELS }),
    sortOrder: smallint('sort_order').notNull().default(0),
    isPrimary: boolean('is_primary').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('vendor_contact_phones_owner_e164_unique').on(t.tenantId, t.contactId, t.e164),
    foreignKey({
      name: 'vendor_contact_phones_contact_fk',
      columns: [t.tenantId, t.contactId],
      foreignColumns: [vendorContacts.tenantId, vendorContacts.id],
    }).onDelete('cascade'),
    uniqueIndex('vendor_contact_phones_owner_primary_unique')
      .on(t.tenantId, t.contactId)
      .where(sql`${t.isPrimary}`),
    index('vendor_contact_phones_tenant_e164_idx').on(t.tenantId, t.e164),
    check('vendor_contact_phones_country_check', sql`${t.country} ~ '^[A-Z]{2}$'`),
    check('vendor_contact_phones_e164_check', sql`${t.e164} ~ '^\\+[1-9][0-9]{6,14}$'`),
    check(
      'vendor_contact_phones_label_check',
      sql`${t.label} in ('mobile', 'work', 'home', 'landline')`,
    ),
    check('vendor_contact_phones_sort_order_check', sql`${t.sortOrder} >= 0`),
  ],
);

/**
 * A bank account of a vendor, changed only through maker-checker (AD9): proposed by one user, verified by another
 * after a call-back, with the evidence document. Tenant-level: one active account per vendor. The account number is
 * field-encrypted (`accountNumberEnc`); DTOs show `last4` only, and the audit trail redacts the ciphertext.
 */
export const vendorBankAccounts = appSchema.table(
  'vendor_bank_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    vendorId: uuid('vendor_id').notNull(),
    bankName: text('bank_name').notNull(),
    accountName: text('account_name').notNull(),
    accountNumberEnc: bytea('account_number_enc').notNull(),
    /** The keyed hash of the account number, for the duplicate-account search. */
    accountFingerprint: text('account_fingerprint').notNull(),
    last4: text('last4').notNull(),
    currency: char('currency', { length: 3 }).notNull().default('NPR'),
    status: text('status', { enum: VENDOR_BANK_ACCOUNT_STATUSES }).notNull().default('proposed'),
    proposedBy: uuid('proposed_by').notNull(),
    proposedVia: text('proposed_via', { enum: VENDOR_BANK_PROPOSED_VIA }).notNull(),
    /** Never the proposer (CHECK), and required once the account is active. */
    verifiedBy: uuid('verified_by'),
    /** The kernel document of the call-back evidence; required once the account is active. */
    callbackEvidenceDocumentId: uuid('callback_evidence_document_id'),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (t) => [
    unique('vendor_bank_accounts_tenant_id_unique').on(t.tenantId, t.id),
    foreignKey({
      name: 'vendor_bank_accounts_vendor_fk',
      columns: [t.tenantId, t.vendorId],
      foreignColumns: [vendors.tenantId, vendors.id],
    }),
    foreignKey({
      name: 'vendor_bank_accounts_proposed_by_fk',
      columns: [t.tenantId, t.proposedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'vendor_bank_accounts_verified_by_fk',
      columns: [t.tenantId, t.verifiedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'vendor_bank_accounts_evidence_document_fk',
      columns: [t.tenantId, t.callbackEvidenceDocumentId],
      foreignColumns: [documents.tenantId, documents.id],
    }),
    uniqueIndex('vendor_bank_accounts_tenant_vendor_active_unique')
      .on(t.tenantId, t.vendorId)
      .where(sql`${t.status} = 'active'`),
    index('vendor_bank_accounts_tenant_vendor_idx').on(t.tenantId, t.vendorId),
    index('vendor_bank_accounts_tenant_fingerprint_idx').on(t.tenantId, t.accountFingerprint),
    check(
      'vendor_bank_accounts_status_check',
      sql`${t.status} in ('proposed', 'active', 'retired', 'rejected')`,
    ),
    check('vendor_bank_accounts_proposed_via_check', sql`${t.proposedVia} in ('staff', 'portal')`),
    check('vendor_bank_accounts_currency_check', sql`${t.currency} in ('NPR', 'INR', 'USD')`),
    check('vendor_bank_accounts_last4_check', sql`${t.last4} ~ '^[0-9]{4}$'`),
    check('vendor_bank_accounts_maker_checker_check', sql`${t.verifiedBy} <> ${t.proposedBy}`),
    check(
      'vendor_bank_accounts_active_check',
      sql`${t.status} <> 'active' OR (${t.verifiedBy} IS NOT NULL AND ${t.callbackEvidenceDocumentId} IS NOT NULL)`,
    ),
    check('vendor_bank_accounts_version_check', sql`${t.version} >= 1`),
  ],
);

// ---------------------------------------------------------------------------------------------------------------
// Entity-owned table
// ---------------------------------------------------------------------------------------------------------------

/**
 * A vendor's terms with one legal entity (AD15, the vendor twin of party_accounts). `defaultWithholdingCodeId`
 * has no FK yet: withholding_codes comes from P3 U0-A and S-AP adds the constraint.
 */
export const vendorAccounts = appSchema.table(
  'vendor_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id').notNull(),
    vendorId: uuid('vendor_id').notNull(),
    defaultCurrency: char('default_currency', { length: 3 }),
    paymentTermId: uuid('payment_term_id'),
    defaultWithholdingCodeId: uuid('default_withholding_code_id'),
    active: boolean('active').notNull().default(true),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (t) => [
    // Parent key for the entity-owned children of later units (bills, purchase orders).
    unique('vendor_accounts_tenant_org_id_unique').on(t.tenantId, t.organizationId, t.id),
    unique('vendor_accounts_tenant_org_vendor_unique').on(t.tenantId, t.organizationId, t.vendorId),
    foreignKey({
      name: 'vendor_accounts_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'vendor_accounts_vendor_fk',
      columns: [t.tenantId, t.vendorId],
      foreignColumns: [vendors.tenantId, vendors.id],
    }),
    foreignKey({
      name: 'vendor_accounts_payment_term_fk',
      columns: [t.tenantId, t.paymentTermId],
      foreignColumns: [paymentTerms.tenantId, paymentTerms.id],
    }),
    index('vendor_accounts_tenant_vendor_idx').on(t.tenantId, t.vendorId),
    check(
      'vendor_accounts_default_currency_check',
      sql`${t.defaultCurrency} in ('NPR', 'INR', 'USD')`,
    ),
    check('vendor_accounts_version_check', sql`${t.version} >= 1`),
  ],
);
