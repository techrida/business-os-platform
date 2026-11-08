// Platform tables (migrations 0000 and 0013). This file describes the tables to Drizzle so that queries are typed.
// The SQL that actually creates them is packages/db/migrations/0000_platform.sql and 0013_legal_entities.sql,
// written by hand because it also holds things Drizzle cannot model (a trigger, the GRANT/REVOKE statements for
// the two roles). Keep the two in step: a change to a table is a new migration file, never an edit of an old one.
// ADR 0027: an organization is a legal entity; customers and vendors are parties; ZITADEL logins are idp_orgs.
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  pgSchema,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Business data. Entity-owned tables carry tenant_id and organization_id; tenant-scoped tables carry only
 * tenant_id (see check-tenancy.ts).
 */
export const appSchema = pgSchema('app');

/** Operational bookkeeping that is not business data (no tenancy columns needed). */
export const opsSchema = pgSchema('ops');

/**
 * One row per tenant (a company that runs Business OS). The only table in `app` allowed to lack
 * tenant_id / organization_id: it IS the tenant.
 */
export const tenants = appSchema.table('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The kinds of IdP org (a ZITADEL organization, see `idpOrgs`) the API puts in its request context.
 * Mirrors OrgKindSchema in @bos/contracts. ADR 0027: this is no longer a kind of `organizations` row.
 */
export const ORG_KINDS = ['staff', 'customer', 'vendor'] as const;

/** The kinds of party: a customer or vendor company. Never staff, so a subset of ORG_KINDS. */
export const PARTY_KINDS = ['customer', 'vendor'] as const;

/**
 * An organization inside a tenant is a LEGAL ENTITY (ADR 0027): it issues documents, keeps books and owns
 * number series. `organization_id` on a business table means this and nothing else. Customers and vendors are
 * `parties`; ZITADEL logins are `idpOrgs`. Several entities may share the one staff IdP org.
 *
 * `organizationId` always equals `id` (the row is its own organization). Storing it anyway keeps this table
 * shaped like every other business table, so scoped() and check-tenancy need no special case.
 * In SQL a BEFORE INSERT trigger fills it in when it is left out, and a CHECK keeps the two equal.
 */
export const organizations = appSchema.table(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id').notNull(),
    /** Short code, unique within the tenant (for example `TR`). The seed upserts on (tenant_id, code). */
    code: text('code').notNull(),
    name: text('name').notNull(),
    /** The registered name that goes on documents. PAN and VAT fields come with the P2 invoices. */
    legalName: text('legal_name').notNull(),
    /** The tenant's default entity: bootstrap memberships and portal users land here. At most one per tenant. */
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('organizations_self_check', sql`${t.organizationId} = ${t.id}`),
    index('organizations_tenant_id_idx').on(t.tenantId),
    unique('organizations_tenant_code_unique').on(t.tenantId, t.code),
    // PostgreSQL has no partial unique constraint, so this is a unique index: one default entity per tenant.
    uniqueIndex('organizations_tenant_default_unique')
      .on(t.tenantId)
      .where(sql`${t.isDefault}`),
    // Parent key for the composite FKs (tenant_id, organization_id) -> organizations (tenant_id, id), ADR 0027 section 8.
    unique('organizations_tenant_id_unique').on(t.tenantId, t.id),
  ],
);

/**
 * A customer or vendor company (ADR 0027 section 2). Tenant-scoped: it has no organization_id, so one
 * customer company is one party for every legal entity of the tenant.
 */
export const parties = appSchema.table(
  'parties',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: text('kind', { enum: PARTY_KINDS }).notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('parties_kind_check', sql`${t.kind} in ('customer', 'vendor')`),
    unique('parties_tenant_code_unique').on(t.tenantId, t.code),
    // Target of the kind-checking composite FKs: idp_orgs and the counterparty columns (test_memos).
    unique('parties_tenant_id_kind_unique').on(t.tenantId, t.id, t.kind),
  ],
);

/**
 * A ZITADEL organization (a login container), mapped to the tenant and, for portal users, to a party
 * (ADR 0027 section 2). The staff IdP org has no party. The API maps a token's org claim to a row here.
 */
export const idpOrgs = appSchema.table(
  'idp_orgs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** The organization id inside ZITADEL. Unique across tenants: it is looked up before the tenant is known. */
    zitadelOrgId: text('zitadel_org_id').notNull().unique('idp_orgs_zitadel_org_id_unique'),
    kind: text('kind', { enum: ORG_KINDS }).notNull(),
    /** NULL for the staff org; a party of the same kind for a customer or vendor org. */
    partyId: uuid('party_id'),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('idp_orgs_kind_check', sql`${t.kind} in ('staff', 'customer', 'vendor')`),
    check('idp_orgs_party_check', sql`(${t.kind} = 'staff') = (${t.partyId} is null)`),
    // One staff IdP org per tenant (a partial unique index).
    uniqueIndex('idp_orgs_tenant_staff_unique')
      .on(t.tenantId)
      .where(sql`${t.kind} = 'staff'`),
    unique('idp_orgs_tenant_party_unique').on(t.tenantId, t.partyId),
    // A vendor party cannot sit behind a customer org because the kind is part of the key.
    // MATCH SIMPLE: a staff row (NULL party_id) is not checked, which is intended.
    foreignKey({
      name: 'idp_orgs_tenant_party_kind_fk',
      columns: [t.tenantId, t.partyId, t.kind],
      foreignColumns: [parties.tenantId, parties.id, parties.kind],
    }),
    // Parent key for the (tenant_id, idp_org_id) FKs, ADR 0027 section 8.
    unique('idp_orgs_tenant_id_unique').on(t.tenantId, t.id),
  ],
);

/**
 * Written by the restore drill (infra/backup/restore-drill.sh) before each backup, then looked for in the
 * restored copy. bos_app may insert and read it, never change or delete a row.
 */
export const restoreCanary = opsSchema.table('restore_canary', {
  id: uuid('id').primaryKey().defaultRandom(),
  writtenAt: timestamp('written_at', { withTimezone: true }).notNull().defaultNow(),
});
