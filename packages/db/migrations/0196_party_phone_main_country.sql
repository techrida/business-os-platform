-- 0196_party_phone_main_country: a number of a shared calling code is stored with the code's main country (R6A, Kuu 2026-11-23).
--
-- FX9's backfill (0193, 0195) stored the region libphonenumber's own patterns pick, so `+44 7911...` became GG
-- (Guernsey) and `+39 06...` VA, where people expect GB and IT. The app only compares calling codes, so every such
-- row already passes; only the country shown (flag, name) was off. From R6A a number typed or detected without a
-- deliberate country pick resolves to the code's main country (phoneCountryFromE164 in @bos/contracts); this
-- migration brings the existing rows to the same country.
--
-- Data written (audited as system:migration-0196):
--   * customer_contact_phones, vendor_contact_phones, lead_phones: `country` becomes the main country of the number's
--     calling code when it is one of the smaller countries that share that code (the map below is libphonenumber-js
--     1.13.17's `country_calling_codes` order restricted to ISO 3166 countries: +1 US, +7 RU, +39 IT, +44 GB, +47 NO,
--     +61 AU, +212 MA, +262 RE, +290 SH, +358 FI, +590 GP, +599 CW). A row whose country is the main country, or is
--     not of the number's calling code, is not touched; the number itself never changes.
--   * app.settings `entity.profile`: the same change to the objects in `phones`, as the next version of the latest
--     one (written as SettingsService.set writes one: per-key advisory lock, version = max(version) + 1,
--     created_by NULL). Older versions stay as history.
-- A pick the user made on purpose cannot be told from a detected country in stored data, so a Canadian or Jamaican
-- +1 number moves to US too; the next save of that contact can pick the country again.
--
-- Idempotent: a converted row needs no change, so a second run writes nothing. The tenant-level contact tables take
-- each tenant's default entity as the acting entity (as 0193 does). Runs as bos_owner, in the migrator's one
-- transaction, split at the breakpoint comments (same rule as 0000).

SELECT
	set_config('bos.actor_kind', 'system', true),
	set_config('bos.actor_id', 'system:migration-0196', true),
	set_config('bos.correlation_id', 'migration-0196:' || gen_random_uuid()::text, true),
	set_config('bos.ip', '', true),
	set_config('bos.user_agent', '', true);
--> statement-breakpoint
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

-- pg_temp.r6a_main_country: one row per smaller country of a shared calling code.
CREATE TEMP TABLE r6a_main_country ("code" text NOT NULL, "main" char(2) NOT NULL, "other" char(2) NOT NULL) ON COMMIT DROP;
--> statement-breakpoint
INSERT INTO r6a_main_country ("code", "main", "other") VALUES
		('1', 'US', 'AG'),
		('1', 'US', 'AI'),
		('1', 'US', 'AS'),
		('1', 'US', 'BB'),
		('1', 'US', 'BM'),
		('1', 'US', 'BS'),
		('1', 'US', 'CA'),
		('1', 'US', 'DM'),
		('1', 'US', 'DO'),
		('1', 'US', 'GD'),
		('1', 'US', 'GU'),
		('1', 'US', 'JM'),
		('1', 'US', 'KN'),
		('1', 'US', 'KY'),
		('1', 'US', 'LC'),
		('1', 'US', 'MP'),
		('1', 'US', 'MS'),
		('1', 'US', 'PR'),
		('1', 'US', 'SX'),
		('1', 'US', 'TC'),
		('1', 'US', 'TT'),
		('1', 'US', 'VC'),
		('1', 'US', 'VG'),
		('1', 'US', 'VI'),
		('7', 'RU', 'KZ'),
		('39', 'IT', 'VA'),
		('44', 'GB', 'GG'),
		('44', 'GB', 'IM'),
		('44', 'GB', 'JE'),
		('47', 'NO', 'SJ'),
		('61', 'AU', 'CC'),
		('61', 'AU', 'CX'),
		('212', 'MA', 'EH'),
		('262', 'RE', 'YT'),
		('358', 'FI', 'AX'),
		('590', 'GP', 'BL'),
		('590', 'GP', 'MF'),
		('599', 'CW', 'BQ');
--> statement-breakpoint

DO $$
DECLARE
	v_tenant uuid;
	v_default uuid;
	v_customer bigint := 0;
	v_vendor bigint := 0;
	v_lead bigint := 0;
	v_settings bigint := 0;
	n bigint;
	target record;
	latest record;
	phone jsonb;
	new_phones jsonb;
	new_value jsonb;
	hit record;
BEGIN
	FOR v_tenant, v_default IN
		SELECT o."tenant_id", o."id" FROM "app"."organizations" o WHERE o."is_default" ORDER BY o."tenant_id"
	LOOP
		PERFORM set_config('bos.organization_id', v_default::text, true);

		UPDATE "app"."customer_contact_phones" p
		   SET "country" = m."main"
		  FROM r6a_main_country m
		 WHERE p."tenant_id" = v_tenant AND p."country" = m."other" AND p."e164" LIKE '+' || m."code" || '%';
		GET DIAGNOSTICS n = ROW_COUNT;
		v_customer := v_customer + n;

		UPDATE "app"."vendor_contact_phones" p
		   SET "country" = m."main"
		  FROM r6a_main_country m
		 WHERE p."tenant_id" = v_tenant AND p."country" = m."other" AND p."e164" LIKE '+' || m."code" || '%';
		GET DIAGNOSTICS n = ROW_COUNT;
		v_vendor := v_vendor + n;

		PERFORM set_config('bos.organization_id', '', true);
	END LOOP;

	-- lead_phones carries organization_id, so its audit events take it from the row.
	UPDATE "app"."lead_phones" p
	   SET "country" = m."main"
	  FROM r6a_main_country m
	 WHERE p."country" = m."other" AND p."e164" LIKE '+' || m."code" || '%';
	GET DIAGNOSTICS n = ROW_COUNT;
	v_lead := v_lead + n;

	-- entity.profile: the latest version's phones.
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
		CONTINUE WHEN jsonb_typeof(latest."value") IS DISTINCT FROM 'object'
		           OR jsonb_typeof(latest."value" -> 'phones') IS DISTINCT FROM 'array';

		new_phones := '[]'::jsonb;
		FOR phone IN SELECT value FROM jsonb_array_elements(latest."value" -> 'phones')
		LOOP
			IF jsonb_typeof(phone) = 'object' AND jsonb_typeof(phone -> 'country') = 'string'
			   AND jsonb_typeof(phone -> 'e164') = 'string' THEN
				SELECT * INTO hit FROM r6a_main_country c
				 WHERE c."other" = phone ->> 'country' AND (phone ->> 'e164') LIKE '+' || c."code" || '%';
				IF FOUND THEN
					phone := jsonb_set(phone, '{country}', to_jsonb(hit."main"::text));
				END IF;
			END IF;
			new_phones := new_phones || jsonb_build_array(phone);
		END LOOP;

		new_value := jsonb_set(latest."value", '{phones}', new_phones);
		IF new_value IS DISTINCT FROM latest."value" THEN
			INSERT INTO "app"."settings" ("tenant_id", "organization_id", "key", "version", "value", "created_by")
			VALUES (target."tenant_id", target."organization_id", 'entity.profile', latest."version" + 1, new_value, NULL);
			v_settings := v_settings + 1;
		END IF;
	END LOOP;

	RAISE NOTICE 'migration-0196: main country set on customer_contact=%, vendor_contact=%, lead=% phone rows; entity.profile versions written=%',
		v_customer, v_vendor, v_lead, v_settings;
END
$$;
--> statement-breakpoint
RESET lock_timeout;
