-- 0058_legacy_company_logo: the company logo becomes a stored document (U12, images as documents), data half.
--
-- Until U12 the logo was a data URL inside the setting `entity.profile` (`logoDataUrl`). From U12 the profile holds
-- `logoDocumentId`, and the old data URL is kept as `legacyLogoDataUrl` until the API's LegacyLogoMigrator (run at
-- boot) uploads it through the scanned receive path, sets `logoDocumentId` and clears `legacyLogoDataUrl`. Reads
-- fall back to the legacy value until then.
--
--   * Settings are append-only (0003: a trigger refuses UPDATE and DELETE), so a rename is the next version of the
--     key, written as SettingsService.set writes one: the per-key advisory lock, then version = max(version) + 1,
--     and created_by NULL because the actor is a system id, not a user uuid. Older versions keep `logoDataUrl` as
--     history; nothing reads them for the logo.
--   * Only the latest version of each entity's `entity.profile` is looked at, and only when it is a JSON object
--     holding the key `logoDataUrl` (null or not: the saved profile always carries the key). Its value moves to
--     `legacyLogoDataUrl` unchanged, and `logoDocumentId` is added as null unless the value already has one.
--   * Idempotent: the new latest version has no `logoDataUrl`, so a second run inserts nothing. An entity that
--     never saved a profile, or whose latest profile has no `logoDataUrl`, is not touched.
--   * Every insert is audited as system:migration-0058 (audit.attach on app.settings, 0003). bos.tenant_id and
--     bos.organization_id are left unset: settings rows are entity-owned, so the audit takes both from the row.
--
-- Runs as bos_owner, in the migrator's one transaction, split at the breakpoint comments (same rule as 0000).

SELECT
	set_config('bos.actor_kind', 'system', true),
	set_config('bos.actor_id', 'system:migration-0058', true),
	set_config('bos.correlation_id', 'migration-0058:' || gen_random_uuid()::text, true),
	set_config('bos.ip', '', true),
	set_config('bos.user_agent', '', true);
--> statement-breakpoint

DO $$
DECLARE
	target record;
	v_inserted bigint;
	v_migrated bigint := 0;
BEGIN
	FOR target IN
		SELECT DISTINCT "tenant_id", "organization_id"
		  FROM "app"."settings"
		 WHERE "key" = 'entity.profile'
		 ORDER BY "tenant_id", "organization_id"
	LOOP
		-- The lock text of settingLockKey() in apps/api/src/platform/settings/settings.service.ts, so a save of the
		-- profile running at the same time waits for this version instead of taking the same number.
		PERFORM pg_advisory_xact_lock(hashtextextended(
			target."tenant_id"::text || ':' || target."organization_id"::text || ':entity.profile', 0));

		INSERT INTO "app"."settings" ("tenant_id", "organization_id", "key", "version", "value", "created_by")
		SELECT
			latest."tenant_id",
			latest."organization_id",
			'entity.profile',
			latest."version" + 1,
			jsonb_build_object('logoDocumentId', 'null'::jsonb)
				|| (latest."value" - 'logoDataUrl')
				|| jsonb_build_object('legacyLogoDataUrl', latest."value" -> 'logoDataUrl'),
			NULL
		  FROM (
			SELECT s."tenant_id", s."organization_id", s."version", s."value"
			  FROM "app"."settings" s
			 WHERE s."tenant_id" = target."tenant_id"
			   AND s."organization_id" = target."organization_id"
			   AND s."key" = 'entity.profile'
			 ORDER BY s."version" DESC
			 LIMIT 1
		  ) latest
		 WHERE jsonb_typeof(latest."value") = 'object'
		   AND latest."value" ? 'logoDataUrl';
		GET DIAGNOSTICS v_inserted = ROW_COUNT;
		v_migrated := v_migrated + v_inserted;
	END LOOP;

	RAISE NOTICE 'migration-0058: entity.profile versions written with logoDataUrl moved to legacyLogoDataUrl=%', v_migrated;
END
$$;
