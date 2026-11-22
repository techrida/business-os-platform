-- 0195_entity_settings_address_phones: the company profile's address and phones move to the FX9 shapes (data half).
--
-- Data written (audited as system:migration-0195):
--   * app.settings `entity.address`: when the latest version still holds the old Address object ({line1, line2?, city,
--     district?, province?, postalCode?, country}), the next version is {line, city, country}: line = line1, or
--     line1 || ', ' || line2 when line2 is set; district, province and postalCode are dropped. An old value without
--     line1, city or an ISO-2 country gets null as the next version (the setting is nullable: "not set yet", and no
--     PDF renders until an admin sets it again). A null or an already-converted value is left alone.
--   * app.settings `entity.profile`: when the latest version's `phones` holds strings (FX8 E.164), the next version
--     holds [{country, e164, label: null}], the country read from the calling code with the same short list as
--     0193 and the same national-part pre-filter (a +977 number only when it passes FX8's Nepal rules). A string
--     that is not E.164 once spaces, dots, hyphens and brackets are removed, whose code is not on the list, or whose
--     national part fails its country's check, is dropped (Kuu: dev data may be cleared, nothing is kept
--     unconverted). Elements that are already objects are kept as they are.
--   * Both are written the way SettingsService.set writes a version (per-key advisory lock, version = max(version)
--     + 1, created_by NULL; same lock text as 0187); older versions stay as history.
--   * app.party_import_batches: every `previewed` batch holds rows parsed with the old CSV shape (address line1/city
--     columns, one phone), which the new commit path cannot read. The 0176 guard refuses DELETE on any batch, so they
--     are expired instead, exactly as 0185's worker job expires an old preview: status `expired` and rows `[]` (the
--     counts and file name stay as the record of the attempt). Committed and expired batches are not touched.
--
-- Idempotent: a converted value needs no change and no preview is left, so a second run writes nothing. The short
-- lock_timeout gives up rather than queue behind a long transaction. Runs as bos_owner, in the migrator's one
-- transaction, split at the breakpoint comments (same rule as 0000).

SELECT
	set_config('bos.actor_kind', 'system', true),
	set_config('bos.actor_id', 'system:migration-0195', true),
	set_config('bos.correlation_id', 'migration-0195:' || gen_random_uuid()::text, true),
	set_config('bos.ip', '', true),
	set_config('bos.user_agent', '', true);
--> statement-breakpoint
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

-- Same as 0193's (pg_temp functions last only for the session, so each migration defines its own). A conservative
-- pre-filter: the app's libphonenumber check is the authority, and a number this keeps may still be refused there.
CREATE OR REPLACE FUNCTION pg_temp.fx9_phone_country(e164 text) RETURNS char(2)
LANGUAGE sql IMMUTABLE AS $$
	SELECT CASE
		WHEN e164 !~ '^\+[1-9][0-9]{6,14}$' THEN NULL
		WHEN e164 LIKE '+977%' THEN
			CASE WHEN substr(e164, 5) ~ '^(9[0-9]{9}|[1-9][0-9]{6,8})$' THEN 'NP' END
		ELSE (
			-- The longest matching code wins first; a national part that breaks its pattern then gives NULL rather
			-- than falling through to a shorter code.
			SELECT CASE WHEN substr(e164, 2 + length(m.code)) ~ m.national THEN m.country END
			  FROM (VALUES
				('880', 'BD', '^(1[0-9]{9}|[2-9][0-9]{7,8})$'),
				('971', 'AE', '^[2-9][0-9]{7,8}$'),
				('91', 'IN', '^[6-9][0-9]{9}$'),
				('44', 'GB', '^[1-9][0-9]{9}$'),
				('86', 'CN', '^(1[0-9]{10}|[2-9][0-9]{8,9})$'),
				('61', 'AU', '^[2-478][0-9]{8}$'),
				('92', 'PK', '^[2-9][0-9]{9}$'),
				('94', 'LK', '^[1-9][0-9]{8}$'),
				('49', 'DE', '^[1-9][0-9]{9,10}$'),
				('33', 'FR', '^[1-9][0-9]{8}$'),
				('81', 'JP', '^[1-9][0-9]{8,9}$'),
				('65', 'SG', '^[3689][0-9]{7}$'),
				('1', 'US', '^[2-9][0-9]{2}[2-9][0-9]{6}$')
			  ) AS m(code, country, national)
			 WHERE substr(e164, 2) LIKE m.code || '%'
			 ORDER BY length(m.code) DESC
			 LIMIT 1)
	END::char(2);
$$;
--> statement-breakpoint
DO $$
DECLARE
	target record;
	latest record;
	phone jsonb;
	cleaned text;
	v_country text;
	new_value jsonb;
	new_phones jsonb;
	v_written bigint := 0;
	v_expired bigint := 0;
BEGIN
	-- entity.address
	FOR target IN
		SELECT DISTINCT "tenant_id", "organization_id"
		  FROM "app"."settings"
		 WHERE "key" = 'entity.address'
		 ORDER BY "tenant_id", "organization_id"
	LOOP
		-- The lock text of settingLockKey() in apps/api/src/platform/settings/settings.service.ts.
		PERFORM pg_advisory_xact_lock(hashtextextended(
			target."tenant_id"::text || ':' || target."organization_id"::text || ':entity.address', 0));
		SELECT s."version", s."value" INTO latest
		  FROM "app"."settings" s
		 WHERE s."tenant_id" = target."tenant_id" AND s."organization_id" = target."organization_id"
		   AND s."key" = 'entity.address'
		 ORDER BY s."version" DESC
		 LIMIT 1;
		CONTINUE WHEN latest."value" IS NULL OR jsonb_typeof(latest."value") = 'null';
		CONTINUE WHEN jsonb_typeof(latest."value") = 'object'
		          AND latest."value" ? 'line' AND NOT latest."value" ? 'line1';

		IF jsonb_typeof(latest."value") = 'object'
		   AND jsonb_typeof(latest."value" -> 'line1') = 'string' AND btrim(latest."value" ->> 'line1') <> ''
		   AND jsonb_typeof(latest."value" -> 'city') = 'string' AND btrim(latest."value" ->> 'city') <> ''
		   AND coalesce(latest."value" ->> 'country', '') ~ '^[A-Z]{2}$' THEN
			new_value := jsonb_build_object(
				'line', CASE
				          WHEN coalesce(btrim(latest."value" ->> 'line2'), '') = '' THEN btrim(latest."value" ->> 'line1')
				          ELSE btrim(latest."value" ->> 'line1') || ', ' || btrim(latest."value" ->> 'line2')
				        END,
				'city', btrim(latest."value" ->> 'city'),
				'country', latest."value" ->> 'country');
		ELSE
			new_value := 'null'::jsonb;
		END IF;

		INSERT INTO "app"."settings" ("tenant_id", "organization_id", "key", "version", "value", "created_by")
		VALUES (target."tenant_id", target."organization_id", 'entity.address', latest."version" + 1, new_value, NULL);
		v_written := v_written + 1;
	END LOOP;

	-- entity.profile phones
	FOR target IN
		SELECT DISTINCT "tenant_id", "organization_id"
		  FROM "app"."settings"
		 WHERE "key" = 'entity.profile'
		 ORDER BY "tenant_id", "organization_id"
	LOOP
		PERFORM pg_advisory_xact_lock(hashtextextended(
			target."tenant_id"::text || ':' || target."organization_id"::text || ':entity.profile', 0));
		SELECT s."version", s."value" INTO latest
		  FROM "app"."settings" s
		 WHERE s."tenant_id" = target."tenant_id" AND s."organization_id" = target."organization_id"
		   AND s."key" = 'entity.profile'
		 ORDER BY s."version" DESC
		 LIMIT 1;
		CONTINUE WHEN jsonb_typeof(latest."value") IS DISTINCT FROM 'object'
		           OR jsonb_typeof(latest."value" -> 'phones') IS DISTINCT FROM 'array';

		new_phones := '[]'::jsonb;
		FOR phone IN SELECT value FROM jsonb_array_elements(latest."value" -> 'phones')
		LOOP
			IF jsonb_typeof(phone) = 'object' THEN
				new_phones := new_phones || jsonb_build_array(phone);
			ELSIF jsonb_typeof(phone) = 'string' THEN
				cleaned := regexp_replace(phone #>> '{}', '[[:space:]().-]', '', 'g');
				v_country := pg_temp.fx9_phone_country(cleaned);
				IF v_country IS NOT NULL THEN
					new_phones := new_phones
						|| jsonb_build_array(jsonb_build_object('country', v_country, 'e164', cleaned, 'label', NULL));
				END IF;
			END IF;
		END LOOP;

		new_value := jsonb_set(latest."value", '{phones}', new_phones);
		IF new_value IS DISTINCT FROM latest."value" THEN
			INSERT INTO "app"."settings" ("tenant_id", "organization_id", "key", "version", "value", "created_by")
			VALUES (target."tenant_id", target."organization_id", 'entity.profile', latest."version" + 1, new_value, NULL);
			v_written := v_written + 1;
		END IF;
	END LOOP;

	-- Previews parsed with the old CSV shape: expired, as 0185's job does (DELETE is refused by the guard).
	UPDATE "app"."party_import_batches"
	   SET "status" = 'expired', "rows" = '[]'::jsonb
	 WHERE "status" = 'previewed';
	GET DIAGNOSTICS v_expired = ROW_COUNT;

	RAISE NOTICE 'migration-0195: settings versions written=%, import previews expired=%', v_written, v_expired;
END
$$;
--> statement-breakpoint
RESET lock_timeout;
