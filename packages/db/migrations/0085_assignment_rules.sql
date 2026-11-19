-- 0085_assignment_rules: entity-owned "Who can assign" rules and cross-department hand-over pairs (U20b).
--
--   * app.access_assignment_rules: one row per (tenant, entity, area) once configured by a Founder. Unconfigured
--     entities fall back to defaults (staff: self_and_peers, managers: any_at_or_below, Marketing -> Sales pair).
--     No stored option permits assigning upward; that invariant stays unconditional in code.
--   * app.access_assignment_handovers: explicit directed department pairs (from_department_id -> to_department_id)
--     allowed for cross-department assignment in that area. Both FKs carry (tenant_id, organization_id) to
--     app.departments so pairs can never cross tenants or legal entities.

CREATE TABLE "app"."access_assignment_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"area" text NOT NULL,
	"staff_rule" text DEFAULT 'self_and_peers' NOT NULL,
	"managers_rule" text DEFAULT 'any_at_or_below' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_assignment_rules_tenant_org_area_unique" UNIQUE("tenant_id", "organization_id", "area"),
	CONSTRAINT "access_assignment_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "access_assignment_rules_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "access_assignment_rules_area_check" CHECK ("area" in ('leads', 'opportunities')),
	CONSTRAINT "access_assignment_rules_staff_rule_check" CHECK ("staff_rule" in ('self_and_peers', 'self_only', 'any_at_or_below')),
	CONSTRAINT "access_assignment_rules_managers_rule_check" CHECK ("managers_rule" in ('any_at_or_below', 'self_and_staff'))
);
--> statement-breakpoint
SELECT audit.attach('app.access_assignment_rules');
--> statement-breakpoint
CREATE TABLE "app"."access_assignment_handovers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"area" text NOT NULL,
	"from_department_id" uuid NOT NULL,
	"to_department_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_assignment_handovers_tenant_org_area_pair_unique" UNIQUE("tenant_id", "organization_id", "area", "from_department_id", "to_department_id"),
	CONSTRAINT "access_assignment_handovers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "access_assignment_handovers_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "access_assignment_handovers_from_department_fk" FOREIGN KEY ("tenant_id", "organization_id", "from_department_id") REFERENCES "app"."departments"("tenant_id", "organization_id", "id"),
	CONSTRAINT "access_assignment_handovers_to_department_fk" FOREIGN KEY ("tenant_id", "organization_id", "to_department_id") REFERENCES "app"."departments"("tenant_id", "organization_id", "id"),
	CONSTRAINT "access_assignment_handovers_area_check" CHECK ("area" in ('leads', 'opportunities')),
	CONSTRAINT "access_assignment_handovers_distinct_departments_check" CHECK ("from_department_id" <> "to_department_id")
);
--> statement-breakpoint
CREATE INDEX "access_assignment_handovers_tenant_org_area_idx" ON "app"."access_assignment_handovers" USING btree ("tenant_id", "organization_id", "area");
--> statement-breakpoint
SELECT audit.attach('app.access_assignment_handovers');
