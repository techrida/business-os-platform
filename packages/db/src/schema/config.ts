// Drizzle tables for migration 0003_config: versioned settings, gap-free number series and manual FX rates.
// Serves the audit NFR (settings keep their history) and the finance NFR (document numbers have no gaps).
// The SQL in migrations/0003_config.sql is the source of truth; this file only types the queries, so keep
// the two in step (a change is a new migration, never an edit of 0003).
import { sql } from 'drizzle-orm';
import {
  bigint,
  char,
  check,
  date,
  integer,
  jsonb,
  numeric,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { appSchema, organizations, tenants } from './platform.js';

/** Currencies that may have a manual rate to NPR. NPR itself needs none. */
export const FX_CURRENCIES = ['INR', 'USD'] as const;

/** Append-only: a change inserts the next `version` of the key. A trigger refuses UPDATE and DELETE. */
export const settings = appSchema.table(
  'settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    key: text('key').notNull(),
    version: integer('version').notNull(),
    value: jsonb('value').notNull(),
    /** `app.users.id` of the editor; no foreign key, NULL when a system job wrote it. */
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('settings_tenant_org_key_version_unique').on(
      t.tenantId,
      t.organizationId,
      t.key,
      t.version,
    ),
    check('settings_version_check', sql`${t.version} >= 1`),
  ],
);

/** One counter row per series and fiscal year. NumberingService locks it to hand out the next number. */
export const numberSeries = appSchema.table(
  'number_series',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    key: text('key').notNull(),
    /** Nepali fiscal year such as `2082/83`. */
    fiscalYear: text('fiscal_year').notNull(),
    prefix: text('prefix').notNull(),
    nextValue: bigint('next_value', { mode: 'number' }).notNull().default(1),
    pad: integer('pad').notNull().default(5),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('number_series_tenant_org_key_fy_unique').on(
      t.tenantId,
      t.organizationId,
      t.key,
      t.fiscalYear,
    ),
    check('number_series_next_value_check', sql`${t.nextValue} >= 1`),
    check('number_series_pad_check', sql`${t.pad} >= 1`),
  ],
);

/** Manual exchange rate to NPR for one currency on one date. */
export const fxRates = appSchema.table(
  'fx_rates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    currency: char('currency', { length: 3, enum: FX_CURRENCIES }).notNull(),
    /** numeric as a string, so no float ever touches a rate. Wrap it in decimal.js. */
    rateNpr: numeric('rate_npr', { precision: 18, scale: 6 }).notNull(),
    source: text('source'),
    rateDate: date('rate_date').notNull(),
    /** `app.users.id` of the person who entered it; no foreign key, like settings.created_by. */
    enteredBy: uuid('entered_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('fx_rates_tenant_org_currency_date_unique').on(
      t.tenantId,
      t.organizationId,
      t.currency,
      t.rateDate,
    ),
    check('fx_rates_currency_check', sql`${t.currency} in ('INR', 'USD')`),
    check('fx_rates_rate_npr_check', sql`${t.rateNpr} > 0`),
  ],
);
