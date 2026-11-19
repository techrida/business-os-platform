-- 0053_user_avatar: a person's avatar is a stored document (U12, images as documents).
--
--   * Nullable uuid, no default: a user without an uploaded image shows the initials avatar, as before.
--   * No foreign key: documents are owned by a tenant and an entity, while a user is tenant-scoped and works in
--     several entities, so no single (tenant_id, organization_id, id) key fits. Whatever sets the column must
--     check the document belongs to the user's tenant; a reader treats a missing document like NULL.
--   * Adding a nullable column with no default rewrites nothing; the users audit trigger is unchanged.
--   * Who may set a picture is `profile.avatar.write`: scope own for every staff role (their own picture), scope
--     all for founder and any role holding `admin.users.invite` (anyone's), the same rule as the code defaults.
--     Only the named staff roles get it (a custom role or a portal role gets nothing until someone grants it). A role that already holds it is left alone, and the
--     authz cache version is bumped only for a tenant that gained a row.
--   * `seeded` (0081): where 0081 has already run, every row written here is seeded = true, like 0083's rows, so a
--     reseed may refresh or remove it. Where 0053 runs before 0081 the column does not exist yet and 0081's
--     backfill marks every existing row seeded, the same end state; so the INSERTs are built with EXECUTE and name
--     the column only when it exists.
--
-- Runs as bos_owner, in the migrator's one transaction, split at the breakpoint comments (same rule as 0000).

-- set_config(..., true) lasts to the end of the migrator's transaction, so the grants below are written to the
-- trail as system:migration-0053. bos.organization_id is set per tenant in the loop.
SELECT
	set_config('bos.actor_kind', 'system', true),
	set_config('bos.actor_id', 'system:migration-0053', true),
	set_config('bos.correlation_id', 'migration-0053:' || gen_random_uuid()::text, true),
	set_config('bos.ip', '', true),
	set_config('bos.user_agent', '', true);
--> statement-breakpoint

ALTER TABLE "app"."users" ADD COLUMN "avatar_document_id" uuid;
--> statement-breakpoint

LOCK TABLE app.role_permissions IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
DECLARE
  target record;
  inserted_rows integer;
  total_rows integer;
  -- 0081 adds the column. Read once: nothing below changes the table's shape.
  has_seeded boolean := EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'app' AND table_name = 'role_permissions' AND column_name = 'seeded'
  );
  seeded_column text := CASE WHEN has_seeded THEN ', seeded' ELSE '' END;
  seeded_value text := CASE WHEN has_seeded THEN ', true' ELSE '' END;
BEGIN
  FOR target IN
    SELECT org.tenant_id, org.id AS organization_id
    FROM app.organizations org
    WHERE org.is_default
    ORDER BY org.tenant_id
  LOOP
    PERFORM set_config('bos.organization_id', target.organization_id::text, true);

    -- Anyone's picture: founder, and whoever manages users (holds admin.users.invite).
    EXECUTE format($sql$
      INSERT INTO app.role_permissions (tenant_id, role_key, permission, scope%s)
      SELECT DISTINCT grant_row.tenant_id, grant_row.role_key, 'profile.avatar.write'::text, 'all'::text%s
      FROM app.role_permissions grant_row
      WHERE grant_row.tenant_id = $1
        AND (grant_row.role_key = 'founder' OR grant_row.permission = 'admin.users.invite')
        AND NOT EXISTS (
          SELECT 1
          FROM app.role_permissions existing
          WHERE existing.tenant_id = grant_row.tenant_id
            AND existing.role_key = grant_row.role_key
            AND existing.permission = 'profile.avatar.write'
        )
      ON CONFLICT (tenant_id, role_key, permission) DO NOTHING
    $sql$, seeded_column, seeded_value) USING target.tenant_id;
    GET DIAGNOSTICS inserted_rows = ROW_COUNT;
    total_rows := inserted_rows;

    -- Their own picture: every other staff role (the rows above already exist, so NOT EXISTS skips them).
    EXECUTE format($sql$
      INSERT INTO app.role_permissions (tenant_id, role_key, permission, scope%s)
      SELECT DISTINCT grant_row.tenant_id, grant_row.role_key, 'profile.avatar.write'::text, 'own'::text%s
      FROM app.role_permissions grant_row
      WHERE grant_row.tenant_id = $1
        AND grant_row.role_key IN ('sales', 'marketing', 'pmo', 'operations_head', 'procurement', 'warehouse',
                                   'operations_officer', 'management', 'finance', 'accountant')
        AND NOT EXISTS (
          SELECT 1
          FROM app.role_permissions existing
          WHERE existing.tenant_id = grant_row.tenant_id
            AND existing.role_key = grant_row.role_key
            AND existing.permission = 'profile.avatar.write'
        )
      ON CONFLICT (tenant_id, role_key, permission) DO NOTHING
    $sql$, seeded_column, seeded_value) USING target.tenant_id;
    GET DIAGNOSTICS inserted_rows = ROW_COUNT;
    total_rows := total_rows + inserted_rows;

    IF total_rows > 0 THEN
      INSERT INTO app.authz_versions (tenant_id, version)
      VALUES (target.tenant_id, 1)
      ON CONFLICT (tenant_id) DO UPDATE
        SET version = app.authz_versions.version + 1, updated_at = now();
    END IF;
  END LOOP;
END;
$$;
