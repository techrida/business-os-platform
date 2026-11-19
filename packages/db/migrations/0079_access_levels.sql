-- 0079_access_levels: a level (staff, manager, head) on every department membership (D50).
--
-- The level feeds the default access model (who sees which department's records, who may assign to whom).
-- It lives on user_entities because the department does (a department belongs to one entity).
--   * level: staff by default; the check keeps the three values, and a head must have a department.
--   * Backfill: the user an existing department names as head becomes level head in that department.
--   * Two row triggers keep app.departments.head_user_id and level = 'head' in step whichever side changes
--     first: naming a head promotes that membership and demotes the previous head to manager; promoting a
--     membership names it head and demotes the previous head; demoting, moving or deleting the head clears the
--     name; a membership created or moved into a department that already names its user head becomes head.
-- Additive. user_entities and departments are already audited, so the trigger writes are on the trail with the
-- caller's actor.

SELECT
	set_config('bos.actor_kind', 'system', true),
	set_config('bos.actor_id', 'system:migration-0079', true),
	set_config('bos.correlation_id', 'migration-0079:' || gen_random_uuid()::text, true),
	set_config('bos.ip', '', true),
	set_config('bos.user_agent', '', true);
--> statement-breakpoint
ALTER TABLE "app"."user_entities" ADD COLUMN "level" text DEFAULT 'staff' NOT NULL;
--> statement-breakpoint
ALTER TABLE "app"."user_entities" ADD CONSTRAINT "user_entities_level_check" CHECK ("level" in ('staff', 'manager', 'head'));
--> statement-breakpoint
ALTER TABLE "app"."user_entities" ADD CONSTRAINT "user_entities_head_department_check" CHECK ("level" <> 'head' OR "department_id" IS NOT NULL);
--> statement-breakpoint
UPDATE "app"."user_entities" ue
SET "level" = 'head'
FROM "app"."departments" d
WHERE d."tenant_id" = ue."tenant_id"
  AND d."organization_id" = ue."organization_id"
  AND d."id" = ue."department_id"
  AND d."head_user_id" = ue."user_id"
  AND ue."level" <> 'head';
--> statement-breakpoint
CREATE INDEX "user_entities_tenant_org_department_level_idx" ON "app"."user_entities" USING btree ("tenant_id", "organization_id", "department_id", "level");
--> statement-breakpoint
CREATE FUNCTION "app"."sync_department_head_from_membership"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  -- Leaving the head position (demoted, moved to another department, or the membership deleted) clears the
  -- department's head.
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD."level" = 'head' AND OLD."department_id" IS NOT NULL
     AND (TG_OP = 'DELETE' OR NEW."level" <> 'head' OR NEW."department_id" IS DISTINCT FROM OLD."department_id") THEN
    UPDATE "app"."departments"
    SET "head_user_id" = NULL, "updated_at" = now()
    WHERE "tenant_id" = OLD."tenant_id" AND "organization_id" = OLD."organization_id"
      AND "id" = OLD."department_id" AND "head_user_id" = OLD."user_id";
  END IF;
  IF TG_OP = 'DELETE' OR NEW."department_id" IS NULL THEN
    RETURN NULL;
  END IF;
  -- One writer per department at a time, so two members promoted together cannot both stay head.
  PERFORM 1 FROM "app"."departments"
  WHERE "tenant_id" = NEW."tenant_id" AND "organization_id" = NEW."organization_id"
    AND "id" = NEW."department_id"
  FOR UPDATE;
  IF NEW."level" = 'head' THEN
    -- Name the head first, then step the previous head down to manager (no interim empty head on the trail).
    UPDATE "app"."departments"
    SET "head_user_id" = NEW."user_id", "updated_at" = now()
    WHERE "tenant_id" = NEW."tenant_id" AND "organization_id" = NEW."organization_id"
      AND "id" = NEW."department_id" AND "head_user_id" IS DISTINCT FROM NEW."user_id";
    UPDATE "app"."user_entities"
    SET "level" = 'manager'
    WHERE "tenant_id" = NEW."tenant_id" AND "organization_id" = NEW."organization_id"
      AND "department_id" = NEW."department_id" AND "level" = 'head' AND "id" <> NEW."id";
  ELSIF EXISTS (
    SELECT 1 FROM "app"."departments"
    WHERE "tenant_id" = NEW."tenant_id" AND "organization_id" = NEW."organization_id"
      AND "id" = NEW."department_id" AND "head_user_id" = NEW."user_id"
  ) THEN
    -- The department already names this user head (the department was written first): the membership follows.
    UPDATE "app"."user_entities" SET "level" = 'head' WHERE "id" = NEW."id";
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "user_entities_sync_department_head"
AFTER INSERT OR DELETE OR UPDATE OF "level", "department_id" ON "app"."user_entities"
FOR EACH ROW EXECUTE FUNCTION "app"."sync_department_head_from_membership"();
--> statement-breakpoint
CREATE FUNCTION "app"."sync_membership_level_from_department_head"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."head_user_id" IS NOT NULL
     AND OLD."head_user_id" IS DISTINCT FROM NEW."head_user_id" THEN
    UPDATE "app"."user_entities"
    SET "level" = 'manager'
    WHERE "tenant_id" = NEW."tenant_id" AND "organization_id" = NEW."organization_id"
      AND "department_id" = NEW."id" AND "user_id" = OLD."head_user_id" AND "level" = 'head';
  END IF;
  IF NEW."head_user_id" IS NOT NULL THEN
    UPDATE "app"."user_entities"
    SET "level" = 'head'
    WHERE "tenant_id" = NEW."tenant_id" AND "organization_id" = NEW."organization_id"
      AND "department_id" = NEW."id" AND "user_id" = NEW."head_user_id" AND "level" <> 'head';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "departments_sync_head_level"
AFTER INSERT OR UPDATE OF "head_user_id" ON "app"."departments"
FOR EACH ROW EXECUTE FUNCTION "app"."sync_membership_level_from_department_head"();
