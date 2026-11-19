-- 0086_departments_admin: department lifecycle (status, retired_at, version), case-insensitive unique active
-- department names per legal entity, trigram index for department search, and `user_entities.department_since`
-- (US-106 "Since", backfilled from created_at where department_id is set, kept in step on department changes).
--
-- Audit is already attached to app.departments (0002) and app.user_entities (0013). Additive and safe on a
-- populated database.

SELECT
	set_config('bos.actor_kind', 'system', true),
	set_config('bos.actor_id', 'system:migration-0086', true),
	set_config('bos.correlation_id', 'migration-0086:' || gen_random_uuid()::text, true),
	set_config('bos.ip', '', true),
	set_config('bos.user_agent', '', true);
--> statement-breakpoint
ALTER TABLE "app"."departments" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;
--> statement-breakpoint
ALTER TABLE "app"."departments" ADD COLUMN "retired_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "app"."departments" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "app"."departments" ADD CONSTRAINT "departments_status_check" CHECK ("status" in ('active', 'retired'));
--> statement-breakpoint
ALTER TABLE "app"."departments" ADD CONSTRAINT "departments_retired_at_check" CHECK (("status" = 'active' AND "retired_at" IS NULL) OR ("status" = 'retired' AND "retired_at" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "app"."departments" ADD CONSTRAINT "departments_version_check" CHECK ("version" >= 1);
--> statement-breakpoint
CREATE UNIQUE INDEX "departments_tenant_org_active_name_unique" ON "app"."departments" ("tenant_id", "organization_id", lower(btrim("name"))) WHERE "status" = 'active';
--> statement-breakpoint
CREATE INDEX "departments_name_trgm_idx" ON "app"."departments" USING gin ("name" gin_trgm_ops);
--> statement-breakpoint
ALTER TABLE "app"."user_entities" ADD COLUMN "department_since" timestamp with time zone;
--> statement-breakpoint
UPDATE "app"."user_entities"
SET "department_since" = "created_at"
WHERE "department_id" IS NOT NULL AND "department_since" IS NULL;
--> statement-breakpoint
CREATE FUNCTION "app"."sync_user_entity_department_since"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."department_id" IS NULL THEN
      NEW."department_since" := NULL;
    ELSIF NEW."department_since" IS NULL THEN
      NEW."department_since" := COALESCE(NEW."created_at", now());
    END IF;
  ELSIF TG_OP = 'UPDATE' AND NEW."department_id" IS DISTINCT FROM OLD."department_id" THEN
    IF NEW."department_id" IS NULL THEN
      NEW."department_since" := NULL;
    ELSE
      NEW."department_since" := now();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "user_entities_set_department_since"
BEFORE INSERT OR UPDATE OF "department_id" ON "app"."user_entities"
FOR EACH ROW EXECUTE FUNCTION "app"."sync_user_entity_department_since"();
