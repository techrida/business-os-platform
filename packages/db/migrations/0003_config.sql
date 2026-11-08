-- 0003_config: versioned settings, gap-free number series and manual FX rates.
-- Serves the audit NFR (a setting change keeps its history) and the finance NFR (document numbers have no
-- gaps, money converts at a rate that was entered by a person on a date). Plan: the P1 plan
-- section 4, "0003_config".
--
-- Runs as bos_owner, in one transaction, split at the breakpoint comments (same rule as 0000).

-- A setting is never edited: a change inserts the next version, so "what was the VAT rate on 3 June" always
-- has an answer. The latest version of a key is the one with the highest version number.
-- created_by is the app.users id of the editor. It has no foreign key on purpose: a system job (the seed,
-- a migration) has no user row, and NULL says "no person did this".
CREATE TABLE "app"."settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"key" text NOT NULL,
	"version" integer NOT NULL,
	"value" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_tenant_org_key_version_unique" UNIQUE("tenant_id", "organization_id", "key", "version"),
	CONSTRAINT "settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id"),
	CONSTRAINT "settings_version_check" CHECK ("version" >= 1)
);
--> statement-breakpoint

-- Append-only: UPDATE and DELETE are refused for every role, the owner included (a superuser could still
-- disable the trigger, which is what the audit chain is for).
CREATE FUNCTION "app"."settings_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'settings are append-only: insert a new version';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "settings_append_only" BEFORE UPDATE OR DELETE ON "app"."settings"
FOR EACH ROW EXECUTE FUNCTION "app"."settings_append_only"();
--> statement-breakpoint

-- One counter row per series (for example MEMO) and Nepali fiscal year (2082/83). NumberingService locks the
-- row with UPDATE inside the business transaction, so a rollback gives the number back.
-- The unique constraint is the ON CONFLICT target of the service's first-use insert.
CREATE TABLE "app"."number_series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"key" text NOT NULL,
	"fiscal_year" text NOT NULL,
	"prefix" text NOT NULL,
	"next_value" bigint DEFAULT 1 NOT NULL,
	"pad" integer DEFAULT 5 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "number_series_tenant_org_key_fy_unique" UNIQUE("tenant_id", "organization_id", "key", "fiscal_year"),
	CONSTRAINT "number_series_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "number_series_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id"),
	CONSTRAINT "number_series_next_value_check" CHECK ("next_value" >= 1),
	CONSTRAINT "number_series_pad_check" CHECK ("pad" >= 1)
);
--> statement-breakpoint

-- Manual exchange rates to NPR. A rate is entered by a person for a date, never fetched, so a document's
-- NPR snapshot can always be traced to a row here. entered_by has no foreign key, for the reason given above.
CREATE TABLE "app"."fx_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"currency" char(3) NOT NULL,
	"rate_npr" numeric(18, 6) NOT NULL,
	"source" text,
	"rate_date" date NOT NULL,
	"entered_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fx_rates_tenant_org_currency_date_unique" UNIQUE("tenant_id", "organization_id", "currency", "rate_date"),
	CONSTRAINT "fx_rates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "fx_rates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id"),
	CONSTRAINT "fx_rates_currency_check" CHECK ("currency" in ('INR', 'USD')),
	CONSTRAINT "fx_rates_rate_npr_check" CHECK ("rate_npr" > 0)
);
--> statement-breakpoint

-- Audit triggers (audit.attach comes from 0001_audit). number_series ignores next_value: every document takes a
-- number, and those increments must not write audit rows, while a change of prefix or pad still does.
SELECT audit.attach('app.settings');
--> statement-breakpoint
SELECT audit.attach('app.fx_rates');
--> statement-breakpoint
SELECT audit.attach('app.number_series', ignore => '{next_value}');
