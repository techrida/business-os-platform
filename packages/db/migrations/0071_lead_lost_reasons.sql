-- 0071_lead_lost_reasons: the tenant's list of lead lost reasons (D49), schema half. A lead stores a reference to an
-- option (leads.lost_reason_id), never the words. Tenant-level like payment_terms: tenant_id NOT NULL with its FK, no
-- organization_id. label_norm (trimmed, lower-cased label) is unique per tenant, so a duplicate is refused whatever
-- its case or spacing. default_key names the seven shipped options (NULL for one a tenant added); reset restores them.
-- A retired option keeps its row: retired_at hides it from the choices, leads that use it still show it.
-- The FK is (tenant_id, lost_reason_id), so a lead can only name an option of its own tenant. Data half: 0072.
--
-- Runs as bos_owner, split at the breakpoint comments. No GRANT: 0008's default privileges cover new tables.

CREATE TABLE "app"."lead_lost_reasons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"label" text NOT NULL,
	"label_norm" text NOT NULL,
	"position" integer NOT NULL,
	"default_key" text,
	"retired_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_lost_reasons_tenant_id_unique" UNIQUE("tenant_id", "id"),
	CONSTRAINT "lead_lost_reasons_tenant_label_unique" UNIQUE("tenant_id", "label_norm"),
	CONSTRAINT "lead_lost_reasons_tenant_default_key_unique" UNIQUE("tenant_id", "default_key"),
	CONSTRAINT "lead_lost_reasons_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "lead_lost_reasons_label_check" CHECK (btrim("label") <> ''),
	CONSTRAINT "lead_lost_reasons_label_norm_check" CHECK ("label_norm" = lower(btrim("label"))),
	CONSTRAINT "lead_lost_reasons_position_check" CHECK ("position" >= 0),
	CONSTRAINT "lead_lost_reasons_version_check" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE INDEX "lead_lost_reasons_tenant_position_idx" ON "app"."lead_lost_reasons" USING btree ("tenant_id", "position");
--> statement-breakpoint
ALTER TABLE "app"."leads" ADD COLUMN "lost_reason_id" uuid;
--> statement-breakpoint
ALTER TABLE "app"."leads" ADD CONSTRAINT "leads_lost_reason_fk" FOREIGN KEY ("tenant_id", "lost_reason_id") REFERENCES "app"."lead_lost_reasons"("tenant_id", "id");
--> statement-breakpoint
SELECT audit.attach('app.lead_lost_reasons');
