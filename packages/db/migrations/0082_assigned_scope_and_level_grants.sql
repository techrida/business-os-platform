-- 0082_assigned_scope_and_level_grants: grant model additions for D50 and D51.
--
--   * `assigned` joins the scopes a role_permissions row may hold: read-only access to a record the caller holds
--     an open or past activity assignment on. Nothing reads it yet; an unknown scope grants nothing, so the new
--     value is inert until the access services honour it (phase 2).
--   * app.role_permission_levels: the grant a role gives a member of a given level or above, in place of the
--     role's base grant. Sales staff see their own leads while Sales managers and heads see their department
--     (D50), and the Founder can edit that (D51). role_permissions holds one scope per role and permission, so
--     the level exception is its own table: min_level is manager or head, the most senior row at or below the
--     member's level wins, and a member below every row gets the base grant. Tenant-scoped like
--     role_permissions, audited, `seeded` with the same meaning. Empty until the seed fills it (phase 2).

ALTER TABLE "app"."role_permissions" DROP CONSTRAINT "role_permissions_scope_check";
--> statement-breakpoint
ALTER TABLE "app"."role_permissions" ADD CONSTRAINT "role_permissions_scope_check" CHECK ("scope" in ('own', 'department', 'customer_org', 'all', 'assigned'));
--> statement-breakpoint
CREATE TABLE "app"."role_permission_levels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"role_key" text NOT NULL,
	"permission" text NOT NULL,
	"min_level" text NOT NULL,
	"scope" text NOT NULL,
	"seeded" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_permission_levels_tenant_role_permission_level_unique" UNIQUE("tenant_id", "role_key", "permission", "min_level"),
	CONSTRAINT "role_permission_levels_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "role_permission_levels_min_level_check" CHECK ("min_level" in ('manager', 'head')),
	CONSTRAINT "role_permission_levels_scope_check" CHECK ("scope" in ('own', 'department', 'customer_org', 'all', 'assigned'))
);
--> statement-breakpoint
SELECT audit.attach('app.role_permission_levels');
