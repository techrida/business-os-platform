-- 0127_workflow_publish_and_memo_approver: publishing a workflow needs a second person (F1-Q11, D7).
--
-- * app.workflow_versions.created_by: who saved the version. Every save inserts a new version (no draft is edited in
--   place), so the creator is the version's editor, and the API refuses that person's publish. Rows saved before this
--   migration have no recorded editor (NULL); the API refuses to publish such a draft and asks for it to be saved
--   again, so no draft goes live on one person's say. Published and retired versions are history and keep NULL.
-- * approvals.definitions.publish (the "second person"): Management sees workflow drafts (approvals.definitions.read)
--   and publishes them; the Founder holds every permission. Granted at scope all, seeded, per tenant, and only for
--   tenants that already hold role_permissions rows: a tenant without rows runs on the code defaults, and the grant
--   loader leaves those as soon as one row exists, so a row written here would strip every other role (the rule of
--   0083, 0088 and 0120). A role that already holds either permission keeps its row, whatever its scope. The authz
--   version moves only for a tenant whose rows changed, so running this again changes nothing.
--
-- Runs as bos_owner, in the migrator's one transaction, split at the breakpoint comments (same rule as 0000).

-- set_config(..., true) lasts to the end of the migrator's transaction, so every write below is recorded as
-- system:migration-0127. bos.organization_id is set per tenant in the loop (role_permissions is tenant-scoped).
SELECT
	set_config('bos.actor_kind', 'system', true),
	set_config('bos.actor_id', 'system:migration-0127', true),
	set_config('bos.correlation_id', 'migration-0127:' || gen_random_uuid()::text, true),
	set_config('bos.ip', '', true),
	set_config('bos.user_agent', '', true);
--> statement-breakpoint

ALTER TABLE "app"."workflow_versions" ADD COLUMN IF NOT EXISTS "created_by" uuid;
--> statement-breakpoint

LOCK TABLE app.role_permissions IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
DECLARE
  target record;
  changed_rows integer;
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
    SELECT target.tenant_id, publish_grant.role, publish_grant.permission, publish_grant.scope, true
    FROM jsonb_to_recordset('[
      {"role": "management", "permission": "approvals.definitions.read", "scope": "all"},
      {"role": "management", "permission": "approvals.definitions.publish", "scope": "all"},
      {"role": "founder", "permission": "approvals.definitions.publish", "scope": "all"}
    ]'::jsonb) AS publish_grant(role text, permission text, scope text)
    WHERE NOT EXISTS (
      SELECT 1
      FROM app.role_permissions existing
      WHERE existing.tenant_id = target.tenant_id
        AND existing.role_key = publish_grant.role
        AND existing.permission = publish_grant.permission
    )
    ON CONFLICT (tenant_id, role_key, permission) DO NOTHING;
    GET DIAGNOSTICS changed_rows = ROW_COUNT;

    IF changed_rows > 0 THEN
      INSERT INTO app.authz_versions (tenant_id, version)
      VALUES (target.tenant_id, 1)
      ON CONFLICT (tenant_id) DO UPDATE
        SET version = app.authz_versions.version + 1, updated_at = now();
    END IF;
  END LOOP;
END;
$$;
