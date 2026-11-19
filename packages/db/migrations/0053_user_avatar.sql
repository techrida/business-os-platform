-- 0053_user_avatar: a person's avatar is a stored document (U12, images as documents).
--
--   * Nullable uuid, no default: a user without an uploaded image shows the initials avatar, as before.
--   * No foreign key: documents are owned by a tenant and an entity, while a user is tenant-scoped and works in
--     several entities, so no single (tenant_id, organization_id, id) key fits. Whatever sets the column must
--     check the document belongs to the user's tenant; a reader treats a missing document like NULL.
--   * Adding a nullable column with no default rewrites nothing; the users audit trigger is unchanged.
--   * Who may set a picture is `profile.avatar.write`: scope own for every staff role (their own picture), scope
--     all for founder and any role holding `admin.users.invite` (anyone's), the same rule as the code defaults.
--     Portal roles (customer_user, vendor_user) get nothing. A role that already holds it is left alone, and the
--     authz cache version is bumped only for a tenant that gained a row.
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
BEGIN
  FOR target IN
    SELECT org.tenant_id, org.id AS organization_id
    FROM app.organizations org
    WHERE org.is_default
    ORDER BY org.tenant_id
  LOOP
    PERFORM set_config('bos.organization_id', target.organization_id::text, true);

    -- Anyone's picture: founder, and whoever manages users (holds admin.users.invite).
    INSERT INTO app.role_permissions (tenant_id, role_key, permission, scope)
    SELECT DISTINCT grant_row.tenant_id, grant_row.role_key, 'profile.avatar.write'::text, 'all'::text
    FROM app.role_permissions grant_row
    WHERE grant_row.tenant_id = target.tenant_id
      AND (grant_row.role_key = 'founder' OR grant_row.permission = 'admin.users.invite')
      AND NOT EXISTS (
        SELECT 1
        FROM app.role_permissions existing
        WHERE existing.tenant_id = grant_row.tenant_id
          AND existing.role_key = grant_row.role_key
          AND existing.permission = 'profile.avatar.write'
      )
    ON CONFLICT (tenant_id, role_key, permission) DO NOTHING;
    GET DIAGNOSTICS inserted_rows = ROW_COUNT;
    total_rows := inserted_rows;

    -- Their own picture: every other staff role (the rows above already exist, so NOT EXISTS skips them).
    INSERT INTO app.role_permissions (tenant_id, role_key, permission, scope)
    SELECT DISTINCT grant_row.tenant_id, grant_row.role_key, 'profile.avatar.write'::text, 'own'::text
    FROM app.role_permissions grant_row
    WHERE grant_row.tenant_id = target.tenant_id
      AND grant_row.role_key NOT IN ('customer_user', 'vendor_user')
      AND NOT EXISTS (
        SELECT 1
        FROM app.role_permissions existing
        WHERE existing.tenant_id = grant_row.tenant_id
          AND existing.role_key = grant_row.role_key
          AND existing.permission = 'profile.avatar.write'
      )
    ON CONFLICT (tenant_id, role_key, permission) DO NOTHING;
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
