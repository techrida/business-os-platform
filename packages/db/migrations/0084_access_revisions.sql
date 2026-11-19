-- 0084_access_revisions: tenant-wide revision counter for the Access Settings screen (U20b).
--
--   * One row per tenant, bumped atomically on every access policy or department-membership/head save so
--     concurrent edits detect stale revisions (409 stale_access) and the screen can show "Last changed".
--   * `level_rules_materialized` records whether default rows have been copied into app.role_permission_levels
--     for this tenant, distinguishing an unseeded tenant (shows defaults) from one where the Founder deliberately
--     turned every manager/head department switch off (zero rows in role_permission_levels).
--   * Tenant-scoped (listed in TENANT_SCOPED in check-tenancy.ts), audited via audit.attach.

CREATE TABLE "app"."access_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	"level_rules_materialized" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid,
	CONSTRAINT "access_revisions_tenant_unique" UNIQUE("tenant_id"),
	CONSTRAINT "access_revisions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "access_revisions_updated_by_user_fk" FOREIGN KEY ("tenant_id", "updated_by_user_id") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "access_revisions_revision_nonneg_check" CHECK ("revision" >= 0)
);
--> statement-breakpoint
SELECT audit.attach('app.access_revisions');
