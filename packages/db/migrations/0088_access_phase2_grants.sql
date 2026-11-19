-- 0088_access_phase2_grants: the default access model's phase 2 grants and department reach (D50, D51, D55).
--
-- Grants, per tenant, and only for tenants that already hold role_permissions rows: a tenant without rows runs on
-- the code defaults, and the grant loader leaves those as soon as one row exists, so a row written here would strip
-- every other role (the same rule as 0083). The authz version moves only for a tenant whose rows changed.
--   * Marketing gains the two defaults 0083 missed: profile.avatar.write own (0053 ran before 0083 created the
--     role's rows, so it never got one) and customer.read own (D55-6). A tenant where marketing already holds either
--     permission keeps its row, whatever its scope.
--   * D50 lead access, on seeded rows only (a Founder's row is never changed): Finance, Accountant and PMO read the
--     leads and opportunities they started (own, which covers what they created) instead of all of them, and
--     Operations Head no longer reads leads or opportunities. Their quotation, customer and verification reads stay.
--     Their managers and heads see the department's leads and opportunities through the level rows below.
--   * The default level rows, a frozen copy of DEFAULT_ROLE_PERMISSION_LEVELS in packages/contracts (its test
--     compares the two), which follows the default switches of Settings > Access: managers and heads see their
--     department's leads, opportunities and quotations, and heads their department's purchase requests (D50, D51).
--     Sales and Marketing managers and heads also edit their department's leads (and Sales its opportunities), so
--     they can hand a staff member's lead over and reschedule its follow-ups (D50); every other write stays with the
--     owner, and Finance, Accountant and PMO, which only start leads, get no write row. A row is written only where
--     the tenant's role holds that permission below the department (a level row never creates access). Seeded; an
--     existing row for the same role, permission and level is kept.
-- Department reach on quotations (K4): quotations.department_id is the department of the quotation's opportunity,
-- stamped on insert, cascaded when the opportunity's department changes, and backfilled, so a department grant
-- reaches quotations the way it reaches leads and opportunities. Always derived: a value written by hand is replaced.
-- The 0080 department stamp on leads and opportunities now re-stamps on an update only when the owner or the
-- department really changes. Before, any UPDATE naming owner_user_id re-read the owner's current membership, so
-- saving an unchanged owner moved an old record to the department the owner had since joined (D55-4). An INSERT
-- trigger cannot test OLD, so each table now has one trigger for insert and one for update.
--
-- Runs as bos_owner, in the migrator's one transaction, split at the breakpoint comments (same rule as 0000).

-- set_config(..., true) lasts to the end of the migrator's transaction, so every write below is recorded as
-- system:migration-0088. bos.organization_id is set per tenant in the loop (both grant tables are tenant-scoped).
SELECT
	set_config('bos.actor_kind', 'system', true),
	set_config('bos.actor_id', 'system:migration-0088', true),
	set_config('bos.correlation_id', 'migration-0088:' || gen_random_uuid()::text, true),
	set_config('bos.ip', '', true),
	set_config('bos.user_agent', '', true);
--> statement-breakpoint

LOCK TABLE app.role_permissions, app.role_permission_levels IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
DECLARE
  target record;
  changed_rows integer;
  total_rows integer;
BEGIN
  FOR target IN
    SELECT org.tenant_id, org.id AS organization_id
    FROM app.organizations org
    WHERE org.is_default
      AND EXISTS (SELECT 1 FROM app.role_permissions rp WHERE rp.tenant_id = org.tenant_id)
    ORDER BY org.tenant_id
  LOOP
    PERFORM set_config('bos.organization_id', target.organization_id::text, true);

    INSERT INTO app.role_permissions (tenant_id, role_key, permission, scope, seeded)
    SELECT target.tenant_id, 'marketing', marketing_grant.permission, marketing_grant.scope, true
    FROM jsonb_to_recordset('[
      {"permission": "profile.avatar.write", "scope": "own"},
      {"permission": "customer.read", "scope": "own"}
    ]'::jsonb) AS marketing_grant(permission text, scope text)
    WHERE NOT EXISTS (
      SELECT 1
      FROM app.role_permissions existing
      WHERE existing.tenant_id = target.tenant_id
        AND existing.role_key = 'marketing'
        AND existing.permission = marketing_grant.permission
    )
    ON CONFLICT (tenant_id, role_key, permission) DO NOTHING;
    GET DIAGNOSTICS changed_rows = ROW_COUNT;
    total_rows := changed_rows;

    UPDATE app.role_permissions
    SET scope = 'own'
    WHERE tenant_id = target.tenant_id
      AND seeded
      AND role_key IN ('finance', 'accountant', 'pmo')
      AND permission IN ('crm.lead.read', 'crm.opportunity.read')
      AND scope = 'all';
    GET DIAGNOSTICS changed_rows = ROW_COUNT;
    total_rows := total_rows + changed_rows;

    DELETE FROM app.role_permissions
    WHERE tenant_id = target.tenant_id
      AND seeded
      AND role_key = 'operations_head'
      AND permission IN ('crm.lead.read', 'crm.opportunity.read');
    GET DIAGNOSTICS changed_rows = ROW_COUNT;
    total_rows := total_rows + changed_rows;

    -- After the D50 changes above, so the filter sees this tenant's grants as they now stand: a row is written only
    -- where the role holds the permission below the department, as Settings > Access materialises it. A level row
    -- never creates access, and a role a Founder already widened to the department or further needs none.
    INSERT INTO app.role_permission_levels (tenant_id, role_key, permission, min_level, scope, seeded)
    SELECT target.tenant_id, level_grant.role, level_grant.permission, level_grant.min_level, level_grant.scope, true
    FROM jsonb_to_recordset('[
      {"role": "finance", "permission": "crm.lead.read", "min_level": "manager", "scope": "department"},
      {"role": "finance", "permission": "crm.lead.read", "min_level": "head", "scope": "department"},
      {"role": "finance", "permission": "crm.opportunity.read", "min_level": "manager", "scope": "department"},
      {"role": "finance", "permission": "crm.opportunity.read", "min_level": "head", "scope": "department"},
      {"role": "accountant", "permission": "crm.lead.read", "min_level": "manager", "scope": "department"},
      {"role": "accountant", "permission": "crm.lead.read", "min_level": "head", "scope": "department"},
      {"role": "accountant", "permission": "crm.opportunity.read", "min_level": "manager", "scope": "department"},
      {"role": "accountant", "permission": "crm.opportunity.read", "min_level": "head", "scope": "department"},
      {"role": "sales", "permission": "crm.lead.read", "min_level": "manager", "scope": "department"},
      {"role": "sales", "permission": "crm.lead.read", "min_level": "head", "scope": "department"},
      {"role": "sales", "permission": "crm.opportunity.read", "min_level": "manager", "scope": "department"},
      {"role": "sales", "permission": "crm.opportunity.read", "min_level": "head", "scope": "department"},
      {"role": "sales", "permission": "crm.lead.write", "min_level": "manager", "scope": "department"},
      {"role": "sales", "permission": "crm.lead.write", "min_level": "head", "scope": "department"},
      {"role": "sales", "permission": "crm.opportunity.write", "min_level": "manager", "scope": "department"},
      {"role": "sales", "permission": "crm.opportunity.write", "min_level": "head", "scope": "department"},
      {"role": "sales", "permission": "quotation.read", "min_level": "manager", "scope": "department"},
      {"role": "sales", "permission": "quotation.read", "min_level": "head", "scope": "department"},
      {"role": "marketing", "permission": "crm.lead.read", "min_level": "manager", "scope": "department"},
      {"role": "marketing", "permission": "crm.lead.read", "min_level": "head", "scope": "department"},
      {"role": "marketing", "permission": "crm.lead.write", "min_level": "manager", "scope": "department"},
      {"role": "marketing", "permission": "crm.lead.write", "min_level": "head", "scope": "department"},
      {"role": "pmo", "permission": "crm.lead.read", "min_level": "manager", "scope": "department"},
      {"role": "pmo", "permission": "crm.lead.read", "min_level": "head", "scope": "department"},
      {"role": "pmo", "permission": "crm.opportunity.read", "min_level": "manager", "scope": "department"},
      {"role": "pmo", "permission": "crm.opportunity.read", "min_level": "head", "scope": "department"},
      {"role": "operations_officer", "permission": "procurement.pr.read", "min_level": "head", "scope": "department"}
    ]'::jsonb) AS level_grant(role text, permission text, min_level text, scope text)
    WHERE EXISTS (
      SELECT 1
      FROM app.role_permissions base
      WHERE base.tenant_id = target.tenant_id
        AND base.role_key = level_grant.role
        AND base.permission = level_grant.permission
        AND base.scope NOT IN ('department', 'all')
    )
    ON CONFLICT (tenant_id, role_key, permission, min_level) DO NOTHING;
    GET DIAGNOSTICS changed_rows = ROW_COUNT;
    total_rows := total_rows + changed_rows;

    IF total_rows > 0 THEN
      INSERT INTO app.authz_versions (tenant_id, version)
      VALUES (target.tenant_id, 1)
      ON CONFLICT (tenant_id) DO UPDATE
        SET version = app.authz_versions.version + 1, updated_at = now();
    END IF;
  END LOOP;
END;
$$;
--> statement-breakpoint

ALTER TABLE "app"."quotations" ADD COLUMN "department_id" uuid;
--> statement-breakpoint
ALTER TABLE "app"."quotations" ADD CONSTRAINT "quotations_department_fk" FOREIGN KEY ("tenant_id", "organization_id", "department_id") REFERENCES "app"."departments"("tenant_id", "organization_id", "id");
--> statement-breakpoint
CREATE INDEX "quotations_tenant_org_department_idx" ON "app"."quotations" USING btree ("tenant_id", "organization_id", "department_id");
--> statement-breakpoint
-- Backfill before the triggers exist: quotations_guard lets department_id change, and the audit records each row.
UPDATE "app"."quotations" q
SET "department_id" = o."department_id"
FROM "app"."opportunities" o
WHERE o."tenant_id" = q."tenant_id" AND o."organization_id" = q."organization_id"
  AND o."id" = q."opportunity_id"
  AND q."department_id" IS DISTINCT FROM o."department_id";
--> statement-breakpoint
CREATE FUNCTION "app"."stamp_quotation_department"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  -- Always the opportunity's, which a quotation never changes (quotations_guard): a department written by hand,
  -- on insert or on an update, is replaced.
  NEW."department_id" := (
    SELECT o."department_id"
    FROM "app"."opportunities" o
    WHERE o."tenant_id" = NEW."tenant_id" AND o."organization_id" = NEW."organization_id"
      AND o."id" = NEW."opportunity_id"
  );
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "app"."stamp_quotation_department"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "quotations_stamp_department"
BEFORE INSERT ON "app"."quotations"
FOR EACH ROW EXECUTE FUNCTION "app"."stamp_quotation_department"();
--> statement-breakpoint
CREATE TRIGGER "quotations_restamp_department"
BEFORE UPDATE OF "department_id" ON "app"."quotations"
FOR EACH ROW WHEN (OLD."department_id" IS DISTINCT FROM NEW."department_id")
EXECUTE FUNCTION "app"."stamp_quotation_department"();
--> statement-breakpoint
CREATE FUNCTION "app"."cascade_opportunity_department"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  UPDATE "app"."quotations" q
  SET "department_id" = NEW."department_id"
  WHERE q."tenant_id" = NEW."tenant_id" AND q."organization_id" = NEW."organization_id"
    AND q."opportunity_id" = NEW."id"
    AND q."department_id" IS DISTINCT FROM NEW."department_id";
  RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "app"."cascade_opportunity_department"() FROM PUBLIC;
--> statement-breakpoint
-- AFTER UPDATE with no column list: an owner change moves department_id inside the BEFORE stamp trigger, and a
-- column-list trigger (UPDATE OF department_id) fires only for columns the statement itself names.
CREATE TRIGGER "opportunities_cascade_department"
AFTER UPDATE ON "app"."opportunities"
FOR EACH ROW WHEN (OLD."department_id" IS DISTINCT FROM NEW."department_id")
EXECUTE FUNCTION "app"."cascade_opportunity_department"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "leads_stamp_owner_department" ON "app"."leads";
--> statement-breakpoint
CREATE TRIGGER "leads_stamp_owner_department"
BEFORE INSERT ON "app"."leads"
FOR EACH ROW EXECUTE FUNCTION "app"."stamp_owner_department"();
--> statement-breakpoint
CREATE TRIGGER "leads_restamp_owner_department"
BEFORE UPDATE OF "owner_user_id", "department_id" ON "app"."leads"
FOR EACH ROW WHEN (OLD."owner_user_id" IS DISTINCT FROM NEW."owner_user_id" OR OLD."department_id" IS DISTINCT FROM NEW."department_id")
EXECUTE FUNCTION "app"."stamp_owner_department"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "opportunities_stamp_owner_department" ON "app"."opportunities";
--> statement-breakpoint
CREATE TRIGGER "opportunities_stamp_owner_department"
BEFORE INSERT ON "app"."opportunities"
FOR EACH ROW EXECUTE FUNCTION "app"."stamp_owner_department"();
--> statement-breakpoint
CREATE TRIGGER "opportunities_restamp_owner_department"
BEFORE UPDATE OF "owner_user_id", "department_id" ON "app"."opportunities"
FOR EACH ROW WHEN (OLD."owner_user_id" IS DISTINCT FROM NEW."owner_user_id" OR OLD."department_id" IS DISTINCT FROM NEW."department_id")
EXECUTE FUNCTION "app"."stamp_owner_department"();
