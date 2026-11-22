-- 0187_company_contacts_strict: the company's phones and PAN move to the strict contracts (FX8), data half.
--
-- From FX8 `entity.profile.phones` are E.164 numbers (a +977 number is a 10-digit mobile starting with 9 or a 7 to 9
-- digit landline), and `entity.profile.panVatNo` and `entity.pan_vat_no` are exactly nine digits. A save is checked
-- against those rules; a read still accepts the old free-text shapes, so nothing breaks while rows are converted.
--
--   * Only the latest version of each entity's `entity.profile` and `entity.pan_vat_no` is looked at. A value that
--     converts gets the next version, written the way SettingsService.set writes one (per-key advisory lock,
--     version = max(version) + 1, created_by NULL); older versions stay as history.
--   * A phone converts when, once spaces, dots, hyphens and brackets are removed, it is already E.164, or it is a
--     Nepal number written with `+977`, `00977` or `977` in front, with a trunk 0 (`01-4123456`), or as a bare
--     10-digit mobile starting with 9. A bare 7 to 9 digit number with no trunk 0 is not guessed at: it is ambiguous
--     (a local Kathmandu number, or another country's), so it is left as it is.
--   * A PAN converts when it is nine digits once spaces and hyphens are removed. The profile's own panVatNo (no screen
--     edits it) is set to null when it does not, and reported; `entity.pan_vat_no` is left as stored.
--   * An unseparated 977 followed by 7 digits or fewer is ambiguous (country code or a mobile) and is left as stored.
--   * A number written 00 and another country's code is not a Nepal trunk 0 and is left as stored.
--   * A value that does not convert is left exactly as stored and reported in a NOTICE naming the tenant, the
--     entity and the value. A profile with some convertible phones gets those converted and keeps the rest.
--   * Idempotent: a converted row needs no change, so a second run inserts nothing.
--   * Every insert is audited as system:migration-0187 (audit.attach on app.settings, 0003).
--
-- Runs as bos_owner, in the migrator's one transaction, split at the breakpoint comments (same rule as 0000).

SELECT
	set_config('bos.actor_kind', 'system', true),
	set_config('bos.actor_id', 'system:migration-0187', true),
	set_config('bos.correlation_id', 'migration-0187:' || gen_random_uuid()::text, true),
	set_config('bos.ip', '', true),
	set_config('bos.user_agent', '', true);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION pg_temp.fx8_nepal_national_ok(nat_no text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
	SELECT nat_no ~ '^[0-9]+$'
	   AND ((length(nat_no) = 10 AND nat_no LIKE '9%')
	     OR (length(nat_no) BETWEEN 7 AND 9 AND nat_no NOT LIKE '0%'));
$$;
--> statement-breakpoint

-- The E.164 form of a phone, or NULL when it is not one this migration can convert with certainty.
CREATE OR REPLACE FUNCTION pg_temp.fx8_phone(raw text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
	-- `977 1 412345`: the country code is recognised while the separator after it is still there.
	t text := regexp_replace(
		regexp_replace(raw, '^[[:space:](]*977(?=[[:space:].()-])', '+977'), '[[:space:]().-]', '', 'g');
	nat_no text;
BEGIN
	IF t ~ '^\+[1-9][0-9]{6,14}$' AND (t NOT LIKE '+977%' OR pg_temp.fx8_nepal_national_ok(substr(t, 5))) THEN
		RETURN t;
	ELSIF t ~ '^\+977[0-9]+$' THEN
		nat_no := substr(t, 5);
	ELSIF t ~ '^00977[0-9]+$' THEN
		nat_no := substr(t, 6);
	ELSIF t ~ '^977[0-9]{8,12}$' THEN
		nat_no := substr(t, 4);
	ELSIF t ~ '^0[1-9][0-9]+$' THEN
		nat_no := substr(t, 2);
	ELSIF t ~ '^9[0-9]{9}$' AND t NOT LIKE '977%' THEN
		nat_no := t;
	ELSE
		RETURN NULL;
	END IF;
	IF nat_no LIKE '0%' THEN
		nat_no := substr(nat_no, 2);
	END IF;
	RETURN CASE WHEN pg_temp.fx8_nepal_national_ok(nat_no) THEN '+977' || nat_no END;
END
$$;
--> statement-breakpoint

DO $$
DECLARE
	target record;
	latest record;
	phone jsonb;
	converted text;
	new_phones jsonb;
	new_profile jsonb;
	new_pan text;
	cleaned text;
	v_written bigint := 0;
	v_left bigint := 0;
BEGIN
	-- entity.profile: phones and the profile's own PAN.
	FOR target IN
		SELECT DISTINCT "tenant_id", "organization_id"
		  FROM "app"."settings"
		 WHERE "key" = 'entity.profile'
		 ORDER BY "tenant_id", "organization_id"
	LOOP
		-- The lock text of settingLockKey() in apps/api/src/platform/settings/settings.service.ts.
		PERFORM pg_advisory_xact_lock(hashtextextended(
			target."tenant_id"::text || ':' || target."organization_id"::text || ':entity.profile', 0));
		SELECT s."version", s."value" INTO latest
		  FROM "app"."settings" s
		 WHERE s."tenant_id" = target."tenant_id" AND s."organization_id" = target."organization_id"
		   AND s."key" = 'entity.profile'
		 ORDER BY s."version" DESC
		 LIMIT 1;
		CONTINUE WHEN jsonb_typeof(latest."value") IS DISTINCT FROM 'object';

		new_profile := latest."value";
		IF jsonb_typeof(latest."value" -> 'phones') = 'array' THEN
			new_phones := '[]'::jsonb;
			FOR phone IN SELECT value FROM jsonb_array_elements(latest."value" -> 'phones')
			LOOP
				converted := CASE WHEN jsonb_typeof(phone) = 'string' THEN pg_temp.fx8_phone(phone #>> '{}') END;
				IF converted IS NULL THEN
					v_left := v_left + 1;
					RAISE NOTICE 'migration-0187: tenant % entity % entity.profile phone % left as stored',
						target."tenant_id", target."organization_id", phone;
					new_phones := new_phones || jsonb_build_array(phone);
				ELSE
					new_phones := new_phones || to_jsonb(converted);
				END IF;
			END LOOP;
			new_profile := jsonb_set(new_profile, '{phones}', new_phones);
		END IF;
		IF jsonb_typeof(latest."value" -> 'panVatNo') = 'string' THEN
			cleaned := regexp_replace(latest."value" ->> 'panVatNo', '[[:space:]-]', '', 'g');
			IF cleaned ~ '^[0-9]{9}$' THEN
				new_profile := jsonb_set(new_profile, '{panVatNo}', to_jsonb(cleaned));
			ELSE
				-- Not editable on any screen (the PAN is its own setting) and documents fall back to entity.pan_vat_no, so a value
				-- that is not nine digits would only block every later write of the profile. It is cleared and reported.
				v_left := v_left + 1;
				new_profile := jsonb_set(new_profile, '{panVatNo}', 'null'::jsonb);
				RAISE NOTICE 'migration-0187: tenant % entity % entity.profile panVatNo % cleared (not nine digits)',
					target."tenant_id", target."organization_id", latest."value" ->> 'panVatNo';
			END IF;
		END IF;

		IF new_profile IS DISTINCT FROM latest."value" THEN
			INSERT INTO "app"."settings" ("tenant_id", "organization_id", "key", "version", "value", "created_by")
			VALUES (target."tenant_id", target."organization_id", 'entity.profile', latest."version" + 1, new_profile, NULL);
			v_written := v_written + 1;
		END IF;
	END LOOP;

	-- entity.pan_vat_no: a JSON string (or null).
	FOR target IN
		SELECT DISTINCT "tenant_id", "organization_id"
		  FROM "app"."settings"
		 WHERE "key" = 'entity.pan_vat_no'
		 ORDER BY "tenant_id", "organization_id"
	LOOP
		PERFORM pg_advisory_xact_lock(hashtextextended(
			target."tenant_id"::text || ':' || target."organization_id"::text || ':entity.pan_vat_no', 0));
		SELECT s."version", s."value" INTO latest
		  FROM "app"."settings" s
		 WHERE s."tenant_id" = target."tenant_id" AND s."organization_id" = target."organization_id"
		   AND s."key" = 'entity.pan_vat_no'
		 ORDER BY s."version" DESC
		 LIMIT 1;
		CONTINUE WHEN jsonb_typeof(latest."value") IS DISTINCT FROM 'string';
		new_pan := regexp_replace(latest."value" #>> '{}', '[[:space:]-]', '', 'g');
		IF new_pan ~ '^[0-9]{9}$' THEN
			IF new_pan IS DISTINCT FROM (latest."value" #>> '{}') THEN
				INSERT INTO "app"."settings" ("tenant_id", "organization_id", "key", "version", "value", "created_by")
				VALUES (target."tenant_id", target."organization_id", 'entity.pan_vat_no', latest."version" + 1, to_jsonb(new_pan), NULL);
				v_written := v_written + 1;
			END IF;
		ELSE
			v_left := v_left + 1;
			RAISE NOTICE 'migration-0187: tenant % entity % entity.pan_vat_no % left as stored',
				target."tenant_id", target."organization_id", latest."value" #>> '{}';
		END IF;
	END LOOP;

	RAISE NOTICE 'migration-0187: settings versions written=%, values left as stored=%', v_written, v_left;
END
$$;
