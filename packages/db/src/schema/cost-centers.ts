import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import { appSchema, organizations, tenants } from './platform.js';

/** An entity's cost allocation catalogue. Inactive rows remain available on historical requests. */
export const costCenters = appSchema.table(
  'cost_centers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('cost_centers_tenant_org_id_unique').on(t.tenantId, t.organizationId, t.id),
    unique('cost_centers_tenant_org_code_unique').on(t.tenantId, t.organizationId, t.code),
    foreignKey({
      name: 'cost_centers_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    check('cost_centers_code_check', sql`btrim(${t.code}) <> ''`),
    check('cost_centers_name_check', sql`btrim(${t.name}) <> ''`),
  ],
);
