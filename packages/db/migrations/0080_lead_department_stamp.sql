-- 0080_lead_department_stamp: leads and opportunities carry the department of their owner (D50, D51).
--
-- A `department` grant reaches a record whose department_id is the caller's department. Until now neither table
-- had the column, so the scope reached nothing.
--   * department_id on leads and opportunities, stamped by a BEFORE trigger from the owner's membership in the
--     same entity when a row is inserted or its owner or department changes (NULL when there is no owner, no membership or no
--     department). A trigger rather than service code: no writer can forget it, and no service file changes.
--   * Backfill of existing rows from their current owner.
--   * leads.created_by_user_id: who entered the lead. Finance, Accountant and PMO create leads that belong to a
--     Sales owner and keep read access to what they created (D50); ownership alone cannot say that. NULL for
--     existing rows (unknown). The services set it in phase 2.
-- Additive. Both tables are already audited.

SELECT
	set_config('bos.actor_kind', 'system', true),
	set_config('bos.actor_id', 'system:migration-0080', true),
	set_config('bos.correlation_id', 'migration-0080:' || gen_random_uuid()::text, true),
	set_config('bos.ip', '', true),
	set_config('bos.user_agent', '', true);
--> statement-breakpoint
ALTER TABLE "app"."leads" ADD COLUMN "department_id" uuid;
--> statement-breakpoint
ALTER TABLE "app"."leads" ADD COLUMN "created_by_user_id" uuid;
--> statement-breakpoint
ALTER TABLE "app"."opportunities" ADD COLUMN "department_id" uuid;
--> statement-breakpoint
ALTER TABLE "app"."leads" ADD CONSTRAINT "leads_department_fk" FOREIGN KEY ("tenant_id", "organization_id", "department_id") REFERENCES "app"."departments"("tenant_id", "organization_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."leads" ADD CONSTRAINT "leads_created_by_user_fk" FOREIGN KEY ("tenant_id", "created_by_user_id") REFERENCES "app"."users"("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."opportunities" ADD CONSTRAINT "opportunities_department_fk" FOREIGN KEY ("tenant_id", "organization_id", "department_id") REFERENCES "app"."departments"("tenant_id", "organization_id", "id");
--> statement-breakpoint
CREATE INDEX "leads_tenant_org_department_idx" ON "app"."leads" USING btree ("tenant_id", "organization_id", "department_id");
--> statement-breakpoint
CREATE INDEX "leads_tenant_created_by_idx" ON "app"."leads" USING btree ("tenant_id", "organization_id", "created_by_user_id");
--> statement-breakpoint
CREATE INDEX "opportunities_tenant_org_department_idx" ON "app"."opportunities" USING btree ("tenant_id", "organization_id", "department_id");
--> statement-breakpoint
UPDATE "app"."leads" l
SET "department_id" = ue."department_id"
FROM "app"."user_entities" ue
WHERE ue."tenant_id" = l."tenant_id" AND ue."organization_id" = l."organization_id"
  AND ue."user_id" = l."owner_user_id" AND ue."department_id" IS NOT NULL
  AND l."department_id" IS DISTINCT FROM ue."department_id";
--> statement-breakpoint
UPDATE "app"."opportunities" o
SET "department_id" = ue."department_id"
FROM "app"."user_entities" ue
WHERE ue."tenant_id" = o."tenant_id" AND ue."organization_id" = o."organization_id"
  AND ue."user_id" = o."owner_user_id" AND ue."department_id" IS NOT NULL
  AND o."department_id" IS DISTINCT FROM ue."department_id";
--> statement-breakpoint
CREATE FUNCTION "app"."stamp_owner_department"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  -- Always derived: a department written by hand, on insert or by an update that leaves the owner alone, is
  -- replaced by the owner's.
  NEW."department_id" := (
    SELECT ue."department_id"
    FROM "app"."user_entities" ue
    WHERE ue."tenant_id" = NEW."tenant_id" AND ue."organization_id" = NEW."organization_id"
      AND ue."user_id" = NEW."owner_user_id"
  );
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "leads_stamp_owner_department"
BEFORE INSERT OR UPDATE OF "owner_user_id", "department_id" ON "app"."leads"
FOR EACH ROW EXECUTE FUNCTION "app"."stamp_owner_department"();
--> statement-breakpoint
CREATE TRIGGER "opportunities_stamp_owner_department"
BEFORE INSERT OR UPDATE OF "owner_user_id", "department_id" ON "app"."opportunities"
FOR EACH ROW EXECUTE FUNCTION "app"."stamp_owner_department"();
