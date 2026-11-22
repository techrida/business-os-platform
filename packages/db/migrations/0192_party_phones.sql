-- 0192_party_phones: a person can have several phone numbers, each with its own country (FX9, Kuu 2026-11-22).
-- Structure only; 0193 copies the old single numbers in and 0194 drops the old columns.
--
-- One child table per owner kind, each scoped like its owner:
--   * customer_contact_phones and vendor_contact_phones are tenant-level (on check-tenancy's TENANT_SCOPED list, like
--     their contacts): tenant_id NOT NULL with its FK to app.tenants, no organization_id, and the owner FK is
--     (tenant_id, contact_id) -> <contacts>(tenant_id, id) ON DELETE CASCADE.
--   * lead_phones is entity-owned, like leads: tenant_id and organization_id NOT NULL, (tenant_id, organization_id) ->
--     organizations, and the owner FK is (tenant_id, organization_id, lead_id) -> leads(tenant_id, organization_id, id)
--     ON DELETE CASCADE.
-- Every phone row has: country (ISO 3166-1 alpha-2, the number's country as picked or detected), e164 (E.164, the
-- same CHECK the old phone_e164 columns had), label (null, or mobile / work / home / landline), sort_order (0 is
-- first), is_primary and created_at. A number is listed once per owner (<table>_owner_e164_unique), at most one
-- number per owner is primary (<table>_owner_primary_unique, a partial unique index), and (tenant_id, e164) is
-- indexed for the duplicate and conversion lookups. A phone row is replaced, never edited in place, so it has no
-- version or updated_at. Whether the number is valid for its country is the API's check (libphonenumber-js and the
-- FX8 Nepal rules); the database only holds the shape.
--
-- leads.phones_search: the lead's numbers as E.164, space-separated in sort order, or NULL when it has none. The API
-- writes it whenever it writes the lead's phones, so the list search keeps one trigram index on leads
-- (leads_phones_search_trgm_idx; it replaces 0060's leads_phone_e164_trgm_idx, which 0194 drops with its column).
--
-- Every new table is audited (audit.attach); the tenant-level ones take the acting entity (bos.organization_id, set
-- by withTx). No GRANT: 0008's default privileges cover new tables. The tables start empty and the new leads column
-- starts NULL, so no row is written and no audit actor is needed. The short lock_timeout gives up (and fails the
-- deploy) rather than queue behind a long transaction while holding the ALTER TABLE lock on leads.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE "app"."customer_contact_phones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"country" char(2) NOT NULL,
	"e164" text NOT NULL,
	"label" text,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_contact_phones_owner_e164_unique" UNIQUE("tenant_id", "contact_id", "e164"),
	CONSTRAINT "customer_contact_phones_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "customer_contact_phones_contact_fk" FOREIGN KEY ("tenant_id", "contact_id") REFERENCES "app"."customer_contacts"("tenant_id", "id") ON DELETE CASCADE,
	CONSTRAINT "customer_contact_phones_country_check" CHECK ("country" ~ '^[A-Z]{2}$'),
	CONSTRAINT "customer_contact_phones_e164_check" CHECK ("e164" ~ '^\+[1-9][0-9]{6,14}$'),
	CONSTRAINT "customer_contact_phones_label_check" CHECK ("label" in ('mobile', 'work', 'home', 'landline')),
	CONSTRAINT "customer_contact_phones_sort_order_check" CHECK ("sort_order" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "customer_contact_phones_owner_primary_unique" ON "app"."customer_contact_phones" USING btree ("tenant_id", "contact_id") WHERE "is_primary";
--> statement-breakpoint
CREATE INDEX "customer_contact_phones_tenant_e164_idx" ON "app"."customer_contact_phones" USING btree ("tenant_id", "e164");
--> statement-breakpoint
SELECT audit.attach('app.customer_contact_phones');
--> statement-breakpoint
CREATE TABLE "app"."vendor_contact_phones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"country" char(2) NOT NULL,
	"e164" text NOT NULL,
	"label" text,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_contact_phones_owner_e164_unique" UNIQUE("tenant_id", "contact_id", "e164"),
	CONSTRAINT "vendor_contact_phones_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "vendor_contact_phones_contact_fk" FOREIGN KEY ("tenant_id", "contact_id") REFERENCES "app"."vendor_contacts"("tenant_id", "id") ON DELETE CASCADE,
	CONSTRAINT "vendor_contact_phones_country_check" CHECK ("country" ~ '^[A-Z]{2}$'),
	CONSTRAINT "vendor_contact_phones_e164_check" CHECK ("e164" ~ '^\+[1-9][0-9]{6,14}$'),
	CONSTRAINT "vendor_contact_phones_label_check" CHECK ("label" in ('mobile', 'work', 'home', 'landline')),
	CONSTRAINT "vendor_contact_phones_sort_order_check" CHECK ("sort_order" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_contact_phones_owner_primary_unique" ON "app"."vendor_contact_phones" USING btree ("tenant_id", "contact_id") WHERE "is_primary";
--> statement-breakpoint
CREATE INDEX "vendor_contact_phones_tenant_e164_idx" ON "app"."vendor_contact_phones" USING btree ("tenant_id", "e164");
--> statement-breakpoint
SELECT audit.attach('app.vendor_contact_phones');
--> statement-breakpoint
CREATE TABLE "app"."lead_phones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"country" char(2) NOT NULL,
	"e164" text NOT NULL,
	"label" text,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_phones_owner_e164_unique" UNIQUE("tenant_id", "organization_id", "lead_id", "e164"),
	CONSTRAINT "lead_phones_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "lead_phones_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "lead_phones_lead_fk" FOREIGN KEY ("tenant_id", "organization_id", "lead_id") REFERENCES "app"."leads"("tenant_id", "organization_id", "id") ON DELETE CASCADE,
	CONSTRAINT "lead_phones_country_check" CHECK ("country" ~ '^[A-Z]{2}$'),
	CONSTRAINT "lead_phones_e164_check" CHECK ("e164" ~ '^\+[1-9][0-9]{6,14}$'),
	CONSTRAINT "lead_phones_label_check" CHECK ("label" in ('mobile', 'work', 'home', 'landline')),
	CONSTRAINT "lead_phones_sort_order_check" CHECK ("sort_order" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "lead_phones_owner_primary_unique" ON "app"."lead_phones" USING btree ("tenant_id", "organization_id", "lead_id") WHERE "is_primary";
--> statement-breakpoint
CREATE INDEX "lead_phones_tenant_e164_idx" ON "app"."lead_phones" USING btree ("tenant_id", "e164");
--> statement-breakpoint
SELECT audit.attach('app.lead_phones');
--> statement-breakpoint
ALTER TABLE "app"."leads" ADD COLUMN "phones_search" text;
--> statement-breakpoint
CREATE INDEX "leads_phones_search_trgm_idx" ON "app"."leads" USING gin ("phones_search" gin_trgm_ops);
--> statement-breakpoint
RESET lock_timeout;
