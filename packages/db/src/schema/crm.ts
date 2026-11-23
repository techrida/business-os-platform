// Drizzle tables for migration 0015_crm: the CRM of P2 (customers, contacts, KYB cases, per-entity accounts, leads,
// opportunities, requirements, proposals and activities). Serves the NFR "the pipeline is auditable": every table
// is audited, and stages, sources and kinds are held to the catalogue by CHECK constraints.
// The SQL in migrations/0015_crm.sql is the source of truth; this file only types the queries, so keep the two in
// step (a change is a new migration, never an edit of an old one). crm-schema.test.ts compares their names.
// customers, customer_contacts and verification_cases are tenant-level (no organization_id, ADR 0027 D17); the
// other six are entity-owned. A FK into a tenant-level table is (tenant_id, x); between entity-owned tables it is
// (tenant_id, organization_id, x).
import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type PgTableExtraConfigValue,
} from 'drizzle-orm/pg-core';

import { documents } from './documents.js';
import { departments, users } from './identity.js';
import { appSchema, organizations, PARTY_KINDS, parties, tenants } from './platform.js';

// These mirror the catalogues in @bos/contracts crm.ts (the db package does not depend on contracts).
export const CUSTOMER_RELATIONSHIPS = ['prospect', 'active', 'inactive'] as const;
export const VERIFICATION_STATUSES = [
  'draft',
  'submitted',
  'approved',
  'rejected',
  'expired',
] as const;
export const LEAD_STAGES = [
  'new',
  'contacted',
  'qualified',
  'converted',
  'lost',
  'on_hold',
] as const;
export const LEAD_SOURCES = [
  'website',
  'referral',
  'cold_outreach',
  'event',
  'partner',
  'social',
  'walk_in',
  'campaign',
  'other',
] as const;
export const OPPORTUNITY_STAGES = [
  'qualified',
  'requirement_received',
  'proposal_sent',
  'quotation_sent',
  'negotiation',
  'won',
  'lost',
  'on_hold',
] as const;
export const ACTIVITY_KINDS = [
  'call',
  'meeting',
  'email',
  'note',
  'task',
  'stage_change',
  'system',
  // 0154: the call the payment-promise job plans for Finance; read and changed by the receivables permissions.
  'collection_call',
] as const;

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

// ---------------------------------------------------------------------------------------------------------------
// Tenant-level tables
// ---------------------------------------------------------------------------------------------------------------

/**
 * A customer: the CRM record of a customer party. `id` is the party id (no default: the party row comes first).
 * Tenant-level, so one customer for every legal entity of the tenant.
 */
export const customers = appSchema.table(
  'customers',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /**
     * Always 'customer' (a stored generated column), so customers_party_fk makes the database refuse a vendor
     * party. Left out of inserts; the FK allows only NO ACTION.
     */
    partyKind: text('party_kind').generatedAlwaysAs(sql`'customer'`),
    /** Display number, for example CUS-0001. */
    number: text('number').notNull(),
    legalName: text('legal_name').notNull(),
    /** The normalised legal name the API writes, for the duplicate search. */
    nameNorm: text('name_norm').notNull(),
    /** Upper-case (CHECK), so the per-tenant partial unique index holds whatever case was typed. */
    panVatNo: text('pan_vat_no'),
    industry: text('industry'),
    relationship: text('relationship', { enum: CUSTOMER_RELATIONSHIPS })
      .notNull()
      .default('prospect'),
    ownerUserId: uuid('owner_user_id'),
    defaultCurrency: char('default_currency', { length: 3 }),
    /** ISO 3166-1 alpha-2 (0191, CHECK); also the address's country. */
    country: char('country', { length: 2 }).notNull().default('NP'),
    /** The street lines of the address, one free-text field (0191; not blank, CHECK). */
    addressLine: text('address_line').notNull(),
    /** The address's city (0191; not blank, CHECK). */
    addressCity: text('address_city').notNull(),
    /** Set when this record was merged into another; the target is the live one. */
    mergedIntoId: uuid('merged_into_id'),
    /**
     * The logo, an `app.documents.id` (migration 0054). No foreign key: documents are owned per tenant and
     * entity. NULL shows the initials avatar.
     */
    logoDocumentId: uuid('logo_document_id'),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (t): PgTableExtraConfigValue[] => [
    unique('customers_tenant_id_unique').on(t.tenantId, t.id),
    unique('customers_tenant_number_unique').on(t.tenantId, t.number),
    foreignKey({
      name: 'customers_party_fk',
      columns: [t.tenantId, t.id, t.partyKind],
      foreignColumns: [parties.tenantId, parties.id, parties.kind],
    }),
    foreignKey({
      name: 'customers_owner_user_fk',
      columns: [t.tenantId, t.ownerUserId],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'customers_merged_into_fk',
      columns: [t.tenantId, t.mergedIntoId],
      foreignColumns: [t.tenantId, t.id],
    }),
    // PostgreSQL has no partial unique constraint, so this is a unique index.
    uniqueIndex('customers_tenant_pan_vat_no_unique')
      .on(t.tenantId, t.panVatNo)
      .where(sql`${t.panVatNo} IS NOT NULL`),
    index('customers_tenant_name_norm_idx').on(t.tenantId, t.nameNorm),
    check(
      'customers_relationship_check',
      sql`${t.relationship} in ('prospect', 'active', 'inactive')`,
    ),
    check('customers_default_currency_check', sql`${t.defaultCurrency} in ('NPR', 'INR', 'USD')`),
    check('customers_pan_vat_no_check', sql`${t.panVatNo} ~ '^[A-Z0-9-]{5,20}$'`),
    check('customers_country_check', sql`${t.country} ~ '^[A-Z]{2}$'`),
    check('customers_address_line_check', sql`btrim(${t.addressLine}) <> ''`),
    check('customers_address_city_check', sql`btrim(${t.addressCity}) <> ''`),
    check('customers_merged_into_check', sql`${t.mergedIntoId} <> ${t.id}`),
    check('customers_version_check', sql`${t.version} >= 1`),
  ],
);

/** A person at a customer. Tenant-level, like the customer. */
export const customerContacts = appSchema.table(
  'customer_contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    customerId: uuid('customer_id').notNull(),
    fullName: text('full_name').notNull(),
    /** Lower-cased and trimmed (CHECK). */
    emailNorm: text('email_norm'),
    /** ISO 3166-1 alpha-2 (0191, CHECK); may differ from the customer's. Phones: customerContactPhones. */
    country: char('country', { length: 2 }).notNull().default('NP'),
    title: text('title'),
    isPrimary: boolean('is_primary').notNull().default(false),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (t) => [
    unique('customer_contacts_tenant_id_unique').on(t.tenantId, t.id),
    // Target of the leads and opportunities contact FKs: the contact must belong to the record's customer.
    unique('customer_contacts_tenant_customer_id_unique').on(t.tenantId, t.customerId, t.id),
    foreignKey({
      name: 'customer_contacts_customer_fk',
      columns: [t.tenantId, t.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
    uniqueIndex('customer_contacts_tenant_customer_primary_unique')
      .on(t.tenantId, t.customerId)
      .where(sql`${t.isPrimary}`),
    index('customer_contacts_tenant_email_norm_idx').on(t.tenantId, t.emailNorm),
    check('customer_contacts_email_norm_check', sql`${t.emailNorm} = lower(btrim(${t.emailNorm}))`),
    check('customer_contacts_country_check', sql`${t.country} ~ '^[A-Z]{2}$'`),
    check('customer_contacts_version_check', sql`${t.version} >= 1`),
  ],
);

/** Mirrors PhoneLabel of @bos/contracts (0192). */
export const PHONE_LABELS = ['mobile', 'work', 'home', 'landline'] as const;

/**
 * A phone number of a customer contact (0192). Tenant-level, like the contact; deleted with it. `country` is the
 * number's country (ISO-2), `e164` the number (CHECK). One number per contact once, at most one primary.
 * A row is replaced, never edited, so there is no version.
 */
export const customerContactPhones = appSchema.table(
  'customer_contact_phones',
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
    unique('customer_contact_phones_owner_e164_unique').on(t.tenantId, t.contactId, t.e164),
    foreignKey({
      name: 'customer_contact_phones_contact_fk',
      columns: [t.tenantId, t.contactId],
      foreignColumns: [customerContacts.tenantId, customerContacts.id],
    }).onDelete('cascade'),
    uniqueIndex('customer_contact_phones_owner_primary_unique')
      .on(t.tenantId, t.contactId)
      .where(sql`${t.isPrimary}`),
    index('customer_contact_phones_tenant_e164_idx').on(t.tenantId, t.e164),
    check('customer_contact_phones_country_check', sql`${t.country} ~ '^[A-Z]{2}$'`),
    check('customer_contact_phones_e164_check', sql`${t.e164} ~ '^\\+[1-9][0-9]{6,14}$'`),
    check(
      'customer_contact_phones_label_check',
      sql`${t.label} in ('mobile', 'work', 'home', 'landline')`,
    ),
    check('customer_contact_phones_sort_order_check', sql`${t.sortOrder} >= 0`),
  ],
);

/**
 * The KYB case of a customer or a vendor: one per party. `partyKind` says which (0031); the FK to parties includes
 * it. `checklist` is the ChecklistItem array of @bos/contracts, chosen by the kind.
 */
export const verificationCases = appSchema.table(
  'verification_cases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** The party id (a customer's id is its party id). */
    partyId: uuid('party_id').notNull(),
    partyKind: text('party_kind', { enum: PARTY_KINDS }).notNull().default('customer'),
    status: text('status', { enum: VERIFICATION_STATUSES }).notNull().default('draft'),
    checklist: jsonb('checklist')
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Who submitted the case and when; set by the submit, and so never the reviewer's (separation of duties). */
    reviewPolicy: text('review_policy', { enum: ['case_review_v0', 'document_review_v1'] })
      .notNull()
      .default('case_review_v0'),
    reviewRound: integer('review_round').notNull().default(0),
    submittedByUserId: uuid('submitted_by_user_id'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    /** Who decided; set only by the decision. */
    reviewerUserId: uuid('reviewer_user_id'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    /** The decision note (the DTO's decisionNote); required to reject. */
    reason: text('reason'),
    /** When a change of the party's identity last reset this case, and who made it (0220); both null if never. */
    identityResetAt: timestamp('identity_reset_at', { withTimezone: true }),
    identityResetByUserId: uuid('identity_reset_by_user_id'),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (t) => [
    unique('verification_cases_tenant_id_unique').on(t.tenantId, t.id),
    unique('verification_cases_tenant_party_unique').on(t.tenantId, t.partyId),
    foreignKey({
      name: 'verification_cases_party_fk',
      columns: [t.tenantId, t.partyId, t.partyKind],
      foreignColumns: [parties.tenantId, parties.id, parties.kind],
    }),
    foreignKey({
      name: 'verification_cases_submitter_user_fk',
      columns: [t.tenantId, t.submittedByUserId],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'verification_cases_reviewer_user_fk',
      columns: [t.tenantId, t.reviewerUserId],
      foreignColumns: [users.tenantId, users.id],
    }),
    check('verification_cases_party_kind_check', sql`${t.partyKind} in ('customer', 'vendor')`),
    check(
      'verification_cases_status_check',
      sql`${t.status} in ('draft', 'submitted', 'approved', 'rejected', 'expired')`,
    ),
    check('verification_cases_checklist_check', sql`jsonb_typeof(${t.checklist}) = 'array'`),
    check(
      'verification_cases_submission_check',
      sql`${t.status} NOT IN ('submitted', 'approved', 'rejected') OR (${t.submittedByUserId} IS NOT NULL AND ${t.submittedAt} IS NOT NULL)`,
    ),
    check(
      'verification_cases_decision_check',
      sql`${t.status} NOT IN ('approved', 'rejected') OR (${t.reviewerUserId} IS NOT NULL AND ${t.decidedAt} IS NOT NULL)`,
    ),
    check(
      'verification_cases_reason_check',
      sql`${t.status} <> 'rejected' OR ${t.reason} IS NOT NULL`,
    ),
    check('verification_cases_version_check', sql`${t.version} >= 1`),
    foreignKey({
      name: 'verification_cases_identity_reset_user_fk',
      columns: [t.tenantId, t.identityResetByUserId],
      foreignColumns: [users.tenantId, users.id],
    }),
    check(
      'verification_cases_identity_reset_check',
      sql`(${t.identityResetAt} IS NULL) = (${t.identityResetByUserId} IS NULL)`,
    ),
  ],
);

// ---------------------------------------------------------------------------------------------------------------
// Entity-owned tables
// ---------------------------------------------------------------------------------------------------------------

/**
 * A customer's terms with one legal entity. `creditLimit` is in NPR. `paymentTermId` gets its FK to
 * payment_terms in 0016 (plan unit S2).
 */
export const partyAccounts = appSchema.table(
  'party_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id').notNull(),
    partyId: uuid('party_id').notNull(),
    ownerUserId: uuid('owner_user_id'),
    defaultCurrency: char('default_currency', { length: 3 }),
    paymentTermId: uuid('payment_term_id'),
    creditLimit: numeric('credit_limit', { precision: 18, scale: 2 }),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (t) => [
    unique('party_accounts_tenant_org_party_unique').on(t.tenantId, t.organizationId, t.partyId),
    foreignKey({
      name: 'party_accounts_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'party_accounts_customer_fk',
      columns: [t.tenantId, t.partyId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
    foreignKey({
      name: 'party_accounts_owner_user_fk',
      columns: [t.tenantId, t.ownerUserId],
      foreignColumns: [users.tenantId, users.id],
    }),
    index('party_accounts_tenant_party_idx').on(t.tenantId, t.partyId),
    check(
      'party_accounts_default_currency_check',
      sql`${t.defaultCurrency} in ('NPR', 'INR', 'USD')`,
    ),
    check('party_accounts_credit_limit_check', sql`${t.creditLimit} >= 0`),
    check('party_accounts_version_check', sql`${t.version} >= 1`),
  ],
);

/**
 * A lost reason (D49, 0071): an option of the tenant's list a lead is marked Lost with. Tenant-level, like
 * payment_terms: one list for every legal entity. `label_norm` is the trimmed, lower-cased label, unique per tenant,
 * so "price" and "Price " are one option. `default_key` names the seven options the app ships (null for one the
 * tenant added); reset-to-default restores them. A retired option keeps its row and stays on old leads.
 */
export const leadLostReasons = appSchema.table(
  'lead_lost_reasons',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    label: text('label').notNull(),
    labelNorm: text('label_norm').notNull(),
    position: integer('position').notNull(),
    defaultKey: text('default_key'),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (t): PgTableExtraConfigValue[] => [
    unique('lead_lost_reasons_tenant_id_unique').on(t.tenantId, t.id),
    unique('lead_lost_reasons_tenant_label_unique').on(t.tenantId, t.labelNorm),
    unique('lead_lost_reasons_tenant_default_key_unique').on(t.tenantId, t.defaultKey),
    index('lead_lost_reasons_tenant_position_idx').on(t.tenantId, t.position),
    check('lead_lost_reasons_label_check', sql`btrim(${t.label}) <> ''`),
    check('lead_lost_reasons_label_norm_check', sql`${t.labelNorm} = lower(btrim(${t.label}))`),
    check('lead_lost_reasons_position_check', sql`${t.position} >= 0`),
    check('lead_lost_reasons_version_check', sql`${t.version} >= 1`),
  ],
);

/** A lead. Company and contact are free text until conversion links a customer and a contact. */
export const leads = appSchema.table(
  'leads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id').notNull(),
    /** Display number, for example LD-2026-0142. */
    number: text('number').notNull(),
    title: text('title').notNull(),
    source: text('source', { enum: LEAD_SOURCES }).notNull(),
    campaign: text('campaign'),
    ownerUserId: uuid('owner_user_id'),
    /** The owner's department, stamped by a trigger when the owner is set or changes (migration 0080). */
    departmentId: uuid('department_id'),
    /** Who entered the lead (migration 0080); NULL for rows that predate it. */
    createdByUserId: uuid('created_by_user_id'),
    companyName: text('company_name').notNull(),
    contactName: text('contact_name').notNull(),
    emailNorm: text('email_norm'),
    /** ISO 3166-1 alpha-2 (0191, CHECK). */
    country: char('country', { length: 2 }).notNull().default('NP'),
    /** The lead's optional address (0199): street lines and city, together or both NULL; its country is `country`. */
    addressLine: text('address_line'),
    addressCity: text('address_city'),
    /**
     * The lead's numbers (leadPhones) as E.164, space-separated in sort order; NULL when it has none (0192). The API
     * writes it with the phones; the list search reads it through leads_phones_search_trgm_idx.
     */
    phonesSearch: text('phones_search'),
    customerId: uuid('customer_id'),
    /** Must belong to customerId (leads_contact_fk, leads_contact_customer_check). */
    contactId: uuid('contact_id'),
    requirement: text('requirement'),
    expectedValue: numeric('expected_value', { precision: 18, scale: 2 }),
    currency: char('currency', { length: 3 }).notNull().default('NPR'),
    probability: smallint('probability'),
    /** `YYYY-MM-DD`, kept as a string so no time zone can shift the day. */
    expectedClose: date('expected_close', { mode: 'string' }),
    nextFollowUpAt: timestamp('next_follow_up_at', { withTimezone: true }),
    notes: text('notes'),
    stage: text('stage', { enum: LEAD_STAGES }).notNull().default('new'),
    /** For lost, the words of the chosen option when it was chosen (a snapshot); the label shown is the option's. */
    stageReason: text('stage_reason'),
    stageNote: text('stage_note'),
    /** 0071 (D49): the lost reason option; set with stage = 'lost' (leads_lost_reason_fk). */
    lostReasonId: uuid('lost_reason_id'),
    /** 0100 (F1-Q53): the stage an on_hold lead was held at; resuming returns there. NULL for older holds. */
    heldFromStage: text('held_from_stage', { enum: LEAD_STAGES }),
    /** Set exactly when stage = 'converted' (leads_converted_check). */
    convertedOpportunityId: uuid('converted_opportunity_id'),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (t): PgTableExtraConfigValue[] => [
    unique('leads_tenant_id_unique').on(t.tenantId, t.id),
    unique('leads_tenant_org_id_unique').on(t.tenantId, t.organizationId, t.id),
    unique('leads_tenant_org_number_unique').on(t.tenantId, t.organizationId, t.number),
    foreignKey({
      name: 'leads_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'leads_owner_user_fk',
      columns: [t.tenantId, t.ownerUserId],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'leads_department_fk',
      columns: [t.tenantId, t.organizationId, t.departmentId],
      foreignColumns: [departments.tenantId, departments.organizationId, departments.id],
    }),
    foreignKey({
      name: 'leads_created_by_user_fk',
      columns: [t.tenantId, t.createdByUserId],
      foreignColumns: [users.tenantId, users.id],
    }),
    index('leads_tenant_org_department_idx').on(t.tenantId, t.organizationId, t.departmentId),
    index('leads_tenant_created_by_idx').on(t.tenantId, t.organizationId, t.createdByUserId),
    foreignKey({
      name: 'leads_customer_fk',
      columns: [t.tenantId, t.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
    foreignKey({
      name: 'leads_lost_reason_fk',
      columns: [t.tenantId, t.lostReasonId],
      foreignColumns: [leadLostReasons.tenantId, leadLostReasons.id],
    }),
    foreignKey({
      name: 'leads_contact_fk',
      columns: [t.tenantId, t.customerId, t.contactId],
      foreignColumns: [customerContacts.tenantId, customerContacts.customerId, customerContacts.id],
    }),
    // Added after opportunities in the SQL (the two tables reference each other).
    foreignKey({
      name: 'leads_converted_opportunity_fk',
      columns: [t.tenantId, t.organizationId, t.convertedOpportunityId],
      foreignColumns: [opportunities.tenantId, opportunities.organizationId, opportunities.id],
    }),
    index('leads_tenant_org_stage_idx').on(t.tenantId, t.organizationId, t.stage),
    index('leads_tenant_customer_idx').on(t.tenantId, t.customerId),
    index('leads_tenant_email_norm_idx').on(t.tenantId, t.emailNorm),
    index('leads_phones_search_trgm_idx').using('gin', t.phonesSearch.op('gin_trgm_ops')),
    check(
      'leads_stage_check',
      sql`${t.stage} in ('new', 'contacted', 'qualified', 'converted', 'lost', 'on_hold')`,
    ),
    check(
      'leads_held_from_stage_check',
      sql`${t.heldFromStage} IS NULL OR (${t.stage} = 'on_hold' AND ${t.heldFromStage} in ('new', 'contacted', 'qualified'))`,
    ),
    check(
      'leads_source_check',
      sql`${t.source} in ('website', 'referral', 'cold_outreach', 'event', 'partner', 'social', 'walk_in', 'campaign', 'other')`,
    ),
    check('leads_currency_check', sql`${t.currency} in ('NPR', 'INR', 'USD')`),
    check('leads_expected_value_check', sql`${t.expectedValue} >= 0`),
    check('leads_probability_check', sql`${t.probability} BETWEEN 0 AND 100`),
    check('leads_email_norm_check', sql`${t.emailNorm} = lower(btrim(${t.emailNorm}))`),
    check('leads_country_check', sql`${t.country} ~ '^[A-Z]{2}$'`),
    check(
      'leads_address_check',
      sql`((${t.addressLine} IS NULL) = (${t.addressCity} IS NULL)) AND btrim(${t.addressLine}) <> '' AND btrim(${t.addressCity}) <> ''`,
    ),
    check(
      'leads_contact_customer_check',
      sql`${t.contactId} IS NULL OR ${t.customerId} IS NOT NULL`,
    ),
    check(
      'leads_stage_reason_check',
      sql`${t.stage} NOT IN ('lost', 'on_hold') OR (${t.stageReason} IS NOT NULL AND ${t.stageNote} IS NOT NULL)`,
    ),
    check(
      'leads_converted_check',
      sql`(${t.stage} = 'converted') = (${t.convertedOpportunityId} IS NOT NULL)`,
    ),
    check(
      'leads_converted_customer_check',
      sql`${t.stage} <> 'converted' OR ${t.customerId} IS NOT NULL`,
    ),
    check('leads_version_check', sql`${t.version} >= 1`),
  ],
);

/**
 * A phone number of a lead's person (0192). Entity-owned, like the lead; deleted with it. Same columns and rules
 * as customerContactPhones. Writing a lead's phones also rewrites leads.phones_search.
 */
export const leadPhones = appSchema.table(
  'lead_phones',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id').notNull(),
    leadId: uuid('lead_id').notNull(),
    country: char('country', { length: 2 }).notNull(),
    e164: text('e164').notNull(),
    label: text('label', { enum: PHONE_LABELS }),
    sortOrder: smallint('sort_order').notNull().default(0),
    isPrimary: boolean('is_primary').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('lead_phones_owner_e164_unique').on(t.tenantId, t.organizationId, t.leadId, t.e164),
    foreignKey({
      name: 'lead_phones_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'lead_phones_lead_fk',
      columns: [t.tenantId, t.organizationId, t.leadId],
      foreignColumns: [leads.tenantId, leads.organizationId, leads.id],
    }).onDelete('cascade'),
    uniqueIndex('lead_phones_owner_primary_unique')
      .on(t.tenantId, t.organizationId, t.leadId)
      .where(sql`${t.isPrimary}`),
    index('lead_phones_tenant_e164_idx').on(t.tenantId, t.e164),
    check('lead_phones_country_check', sql`${t.country} ~ '^[A-Z]{2}$'`),
    check('lead_phones_e164_check', sql`${t.e164} ~ '^\\+[1-9][0-9]{6,14}$'`),
    check('lead_phones_label_check', sql`${t.label} in ('mobile', 'work', 'home', 'landline')`),
    check('lead_phones_sort_order_check', sql`${t.sortOrder} >= 0`),
  ],
);

/**
 * An opportunity with one customer. Won is set only by the system, with the accepted quotation version
 * (`wonQuotationVersionId`, FK to quotation_versions in 0016).
 */
export const opportunities = appSchema.table(
  'opportunities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id').notNull(),
    /** Display number, for example DEAL-2026-0095. */
    number: text('number').notNull(),
    name: text('name').notNull(),
    customerId: uuid('customer_id').notNull(),
    /** Must belong to customerId (opportunities_contact_fk). */
    contactId: uuid('contact_id'),
    leadId: uuid('lead_id'),
    ownerUserId: uuid('owner_user_id'),
    /** The owner's department, stamped by a trigger when the owner is set or changes (migration 0080). */
    departmentId: uuid('department_id'),
    stage: text('stage', { enum: OPPORTUNITY_STAGES }).notNull().default('qualified'),
    stageReason: text('stage_reason'),
    stageNote: text('stage_note'),
    /** 0090 (D54-3): the lost reason option; set with stage = 'lost' (opportunities_lost_reason_fk). */
    lostReasonId: uuid('lost_reason_id'),
    /** 0100 (F1-Q53): the stage an on_hold opportunity was held at; resuming returns there. NULL for older holds. */
    heldFromStage: text('held_from_stage', { enum: OPPORTUNITY_STAGES }),
    /** 0101 (FX-Q1): who entered the lead this opportunity came from; creator reach covers the opportunity too. */
    leadCreatorUserId: uuid('lead_creator_user_id'),
    /**
     * 0103 (F1-Q20/F1-Q26): the override of the deal's credit hold, set together (opportunities_credit_override_check).
     * The hold itself is derived from the ledger, never stored.
     */
    creditOverrideReason: text('credit_override_reason'),
    creditOverrideByUserId: uuid('credit_override_by_user_id'),
    creditOverrideAt: timestamp('credit_override_at', { withTimezone: true }),
    /**
     * 0170 (R5 FU4): the gross NPR value of the order the override was given against. A later, bigger order needs a
     * new override. NULL on an override given before it was kept (0171 fills it from the audit trail where it can):
     * such an override covers nothing.
     */
    creditOverrideOrderValue: numeric('credit_override_order_value', { precision: 18, scale: 2 }),
    /**
     * 0183 (R5 FU10): the quotation version the override was given for; it covers that version only. NULL on an
     * override given before it was kept (not backfilled): such an override covers nothing. The composite FK to
     * quotation_versions (opportunities_credit_override_quotation_version_fk) lives in SQL only, like the won one.
     */
    creditOverrideQuotationVersionId: uuid('credit_override_quotation_version_id'),
    /** The expected deal value. */
    value: numeric('value', { precision: 18, scale: 2 }),
    currency: char('currency', { length: 3 }).notNull().default('NPR'),
    probability: smallint('probability'),
    expectedClose: date('expected_close', { mode: 'string' }),
    wonQuotationVersionId: uuid('won_quotation_version_id'),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (t): PgTableExtraConfigValue[] => [
    unique('opportunities_tenant_id_unique').on(t.tenantId, t.id),
    unique('opportunities_tenant_org_id_unique').on(t.tenantId, t.organizationId, t.id),
    unique('opportunities_tenant_org_number_unique').on(t.tenantId, t.organizationId, t.number),
    foreignKey({
      name: 'opportunities_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    // Tenant-level parent: not composite on the entity (C-9).
    foreignKey({
      name: 'opportunities_customer_fk',
      columns: [t.tenantId, t.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
    foreignKey({
      name: 'opportunities_contact_fk',
      columns: [t.tenantId, t.customerId, t.contactId],
      foreignColumns: [customerContacts.tenantId, customerContacts.customerId, customerContacts.id],
    }),
    foreignKey({
      name: 'opportunities_lead_fk',
      columns: [t.tenantId, t.organizationId, t.leadId],
      foreignColumns: [leads.tenantId, leads.organizationId, leads.id],
    }),
    foreignKey({
      name: 'opportunities_owner_user_fk',
      columns: [t.tenantId, t.ownerUserId],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'opportunities_department_fk',
      columns: [t.tenantId, t.organizationId, t.departmentId],
      foreignColumns: [departments.tenantId, departments.organizationId, departments.id],
    }),
    foreignKey({
      name: 'opportunities_lost_reason_fk',
      columns: [t.tenantId, t.lostReasonId],
      foreignColumns: [leadLostReasons.tenantId, leadLostReasons.id],
    }),
    foreignKey({
      name: 'opportunities_lead_creator_user_fk',
      columns: [t.tenantId, t.leadCreatorUserId],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'opportunities_credit_override_by_user_fk',
      columns: [t.tenantId, t.creditOverrideByUserId],
      foreignColumns: [users.tenantId, users.id],
    }),
    check(
      'opportunities_credit_override_check',
      sql`(${t.creditOverrideReason} IS NULL AND ${t.creditOverrideByUserId} IS NULL AND ${t.creditOverrideAt} IS NULL) OR (${t.creditOverrideReason} IS NOT NULL AND length(btrim(${t.creditOverrideReason})) > 0 AND ${t.creditOverrideByUserId} IS NOT NULL AND ${t.creditOverrideAt} IS NOT NULL)`,
    ),
    check(
      'opportunities_credit_override_value_check',
      sql`${t.creditOverrideOrderValue} IS NULL OR (${t.creditOverrideAt} IS NOT NULL AND ${t.creditOverrideOrderValue} >= 0)`,
    ),
    check(
      'opportunities_credit_override_quotation_version_check',
      sql`${t.creditOverrideQuotationVersionId} IS NULL OR ${t.creditOverrideAt} IS NOT NULL`,
    ),
    index('opportunities_tenant_lead_creator_idx').on(
      t.tenantId,
      t.organizationId,
      t.leadCreatorUserId,
    ),
    index('opportunities_tenant_org_department_idx').on(
      t.tenantId,
      t.organizationId,
      t.departmentId,
    ),
    index('opportunities_tenant_org_stage_idx').on(t.tenantId, t.organizationId, t.stage),
    index('opportunities_tenant_customer_idx').on(t.tenantId, t.customerId),
    index('opportunities_tenant_org_lead_idx').on(t.tenantId, t.organizationId, t.leadId),
    check(
      'opportunities_stage_check',
      sql`${t.stage} in ('qualified', 'requirement_received', 'proposal_sent', 'quotation_sent', 'negotiation', 'won', 'lost', 'on_hold')`,
    ),
    check(
      'opportunities_held_from_stage_check',
      sql`${t.heldFromStage} IS NULL OR (${t.stage} = 'on_hold' AND ${t.heldFromStage} in ('qualified', 'requirement_received', 'proposal_sent', 'quotation_sent', 'negotiation'))`,
    ),
    check('opportunities_currency_check', sql`${t.currency} in ('NPR', 'INR', 'USD')`),
    check('opportunities_value_check', sql`${t.value} >= 0`),
    check('opportunities_probability_check', sql`${t.probability} BETWEEN 0 AND 100`),
    check(
      'opportunities_stage_reason_check',
      sql`${t.stage} NOT IN ('lost', 'on_hold') OR (${t.stageReason} IS NOT NULL AND ${t.stageNote} IS NOT NULL)`,
    ),
    check(
      'opportunities_won_check',
      sql`${t.stage} <> 'won' OR ${t.wonQuotationVersionId} IS NOT NULL`,
    ),
    check('opportunities_version_check', sql`${t.version} >= 1`),
  ],
);

/** What the customer asked for, on an opportunity. Files are kernel documents. */
export const requirements = appSchema.table(
  'requirements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id').notNull(),
    opportunityId: uuid('opportunity_id').notNull(),
    summary: text('summary').notNull(),
    detail: text('detail'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (t) => [
    unique('requirements_tenant_id_unique').on(t.tenantId, t.id),
    unique('requirements_tenant_org_id_unique').on(t.tenantId, t.organizationId, t.id),
    foreignKey({
      name: 'requirements_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'requirements_opportunity_fk',
      columns: [t.tenantId, t.organizationId, t.opportunityId],
      foreignColumns: [opportunities.tenantId, opportunities.organizationId, opportunities.id],
    }),
    index('requirements_tenant_org_opportunity_idx').on(
      t.tenantId,
      t.organizationId,
      t.opportunityId,
    ),
    check('requirements_version_check', sql`${t.version} >= 1`),
  ],
);

/** An unpriced proposal on an opportunity. No price column, ever: prices live only in quotations (A2 C11). */
export const proposals = appSchema.table(
  'proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id').notNull(),
    opportunityId: uuid('opportunity_id').notNull(),
    title: text('title').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    documentId: uuid('document_id'),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (t) => [
    unique('proposals_tenant_id_unique').on(t.tenantId, t.id),
    unique('proposals_tenant_org_id_unique').on(t.tenantId, t.organizationId, t.id),
    foreignKey({
      name: 'proposals_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'proposals_opportunity_fk',
      columns: [t.tenantId, t.organizationId, t.opportunityId],
      foreignColumns: [opportunities.tenantId, opportunities.organizationId, opportunities.id],
    }),
    // MATCH SIMPLE: not checked while document_id is NULL.
    foreignKey({
      name: 'proposals_document_fk',
      columns: [t.tenantId, t.organizationId, t.documentId],
      foreignColumns: [documents.tenantId, documents.organizationId, documents.id],
    }),
    index('proposals_tenant_org_opportunity_idx').on(t.tenantId, t.organizationId, t.opportunityId),
    check('proposals_version_check', sql`${t.version} >= 1`),
  ],
);

/**
 * A call, meeting, email, note or task (or a server-written stage change or system entry), on exactly one of the
 * five subject columns (activities_one_subject_check). `quotationId` gets its FK to quotations in 0016.
 */
export const activities = appSchema.table(
  'activities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id').notNull(),
    kind: text('kind', { enum: ACTIVITY_KINDS }).notNull(),
    /** What the activity is about, as a line of text; not the record it belongs to. */
    subject: text('subject').notNull(),
    body: text('body'),
    leadId: uuid('lead_id'),
    opportunityId: uuid('opportunity_id'),
    customerId: uuid('customer_id'),
    contactId: uuid('contact_id'),
    quotationId: uuid('quotation_id'),
    dueAt: timestamp('due_at', { withTimezone: true }),
    assigneeUserId: uuid('assignee_user_id'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    /** 0062: a planned activity that was called off. Cancelled rows never list. */
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    /** 0062: the staff user who wrote the row; NULL for system and migrated rows. */
    createdByUserId: uuid('created_by_user_id'),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: 'activities_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'activities_lead_fk',
      columns: [t.tenantId, t.organizationId, t.leadId],
      foreignColumns: [leads.tenantId, leads.organizationId, leads.id],
    }),
    foreignKey({
      name: 'activities_opportunity_fk',
      columns: [t.tenantId, t.organizationId, t.opportunityId],
      foreignColumns: [opportunities.tenantId, opportunities.organizationId, opportunities.id],
    }),
    foreignKey({
      name: 'activities_customer_fk',
      columns: [t.tenantId, t.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
    foreignKey({
      name: 'activities_contact_fk',
      columns: [t.tenantId, t.contactId],
      foreignColumns: [customerContacts.tenantId, customerContacts.id],
    }),
    foreignKey({
      name: 'activities_assignee_user_fk',
      columns: [t.tenantId, t.assigneeUserId],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'activities_created_by_user_fk',
      columns: [t.tenantId, t.createdByUserId],
      foreignColumns: [users.tenantId, users.id],
    }),
    index('activities_tenant_org_lead_idx').on(t.tenantId, t.organizationId, t.leadId),
    /** 0062: the planned rows (follow-ups) of a lead, earliest first. */
    index('activities_tenant_org_lead_planned_idx')
      .on(t.tenantId, t.organizationId, t.leadId, t.dueAt)
      .where(sql`${t.dueAt} IS NOT NULL AND ${t.completedAt} IS NULL AND ${t.cancelledAt} IS NULL`),
    index('activities_tenant_org_opportunity_idx').on(
      t.tenantId,
      t.organizationId,
      t.opportunityId,
    ),
    index('activities_tenant_org_customer_idx').on(t.tenantId, t.organizationId, t.customerId),
    index('activities_tenant_org_contact_idx').on(t.tenantId, t.organizationId, t.contactId),
    index('activities_tenant_org_quotation_idx').on(t.tenantId, t.organizationId, t.quotationId),
    index('activities_tenant_org_assignee_due_idx').on(
      t.tenantId,
      t.organizationId,
      t.assigneeUserId,
      t.dueAt,
    ),
    check(
      'activities_kind_check',
      sql`${t.kind} in ('call', 'meeting', 'email', 'note', 'task', 'stage_change', 'system', 'collection_call')`,
    ),
    check(
      'activities_one_subject_check',
      sql`num_nonnulls(${t.leadId}, ${t.opportunityId}, ${t.customerId}, ${t.contactId}, ${t.quotationId}) = 1`,
    ),
    check('activities_version_check', sql`${t.version} >= 1`),
  ],
);
