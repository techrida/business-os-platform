-- 0193_party_phones_backfill: the old single phone_e164 of each contact and lead becomes its first phone row (FX9).
--
-- Data written (audited as system:migration-0193):
--   * customer_contact_phones, vendor_contact_phones, lead_phones: one row per old customer_contacts.phone_e164,
--     vendor_contacts.phone_e164 and leads.phone_e164, as the owner's primary number (is_primary, sort_order 0,
--     label NULL). The contact tables are tenant-level, so their writes take each tenant's default entity as the
--     acting entity (as 0013 does); bos.organization_id is reset to '' after each tenant.
--   * leads.phones_search: the lead's numbers, space-separated in sort order (only leads that got a number).
-- The number's country comes from its calling code, through the short list in pg_temp.fx9_phone_country below
-- (longest code first), and only when the national part has a plausible length and leading digits for that country
-- (+1 must be a NANP number: a 2-9 area code and a 2-9 exchange). A +977 number is NP only when its national part
-- passes FX8's Nepal rules (a 10-digit mobile starting with 9, or a 7 to 9 digit landline with no leading 0). A number
-- whose code is not on the list, or whose national part fails its country's check, is not copied (Kuu: dev data may
-- be cleared, so nothing is kept unconverted). The check is a conservative pre-filter of the app's libphonenumber
-- validation, not a copy of it. A country is never guessed from digits without a code: every old value is already
-- E.164 (the old CHECK).
--
-- Idempotent: an owner that already has a phone row is skipped, and phones_search is written only when it differs,
-- so a second run writes nothing. It has to run before 0194 drops the old columns. The short lock_timeout gives up
-- rather than queue behind a long transaction. Runs as bos_owner, in the migrator's one transaction, split at the
-- breakpoint comments (same rule as 0000).

SELECT
	set_config('bos.actor_kind', 'system', true),
	set_config('bos.actor_id', 'system:migration-0193', true),
	set_config('bos.correlation_id', 'migration-0193:' || gen_random_uuid()::text, true),
	set_config('bos.ip', '', true),
	set_config('bos.user_agent', '', true);
--> statement-breakpoint
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

-- The country of an E.164 number from its calling code, or NULL when the code is not on this list, the national part
-- has an implausible length or leading digits for that country (`national` below), or a +977 number breaks FX8's
-- Nepal rules. +1 is read as US (the rest of the North American plan is not told apart here) and must be a NANP
-- number: area code and exchange each start with 2-9.
-- This is a conservative pre-filter only: the app's libphonenumber check (phoneProblem in @bos/contracts) is the
-- authority, and a number this keeps may still be refused by the app (for example an unassigned area code).
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
	v_tenant uuid;
	v_default uuid;
	v_customer bigint := 0;
	v_vendor bigint := 0;
	v_lead bigint := 0;
	v_search bigint := 0;
	n bigint;
BEGIN
	FOR v_tenant, v_default IN
		SELECT o."tenant_id", o."id" FROM "app"."organizations" o WHERE o."is_default" ORDER BY o."tenant_id"
	LOOP
		PERFORM set_config('bos.organization_id', v_default::text, true);

		INSERT INTO "app"."customer_contact_phones" ("tenant_id", "contact_id", "country", "e164", "label", "sort_order", "is_primary")
		SELECT c."tenant_id", c."id", pg_temp.fx9_phone_country(c."phone_e164"), c."phone_e164", NULL, 0, true
		  FROM "app"."customer_contacts" c
		 WHERE c."tenant_id" = v_tenant
		   AND c."phone_e164" IS NOT NULL
		   AND pg_temp.fx9_phone_country(c."phone_e164") IS NOT NULL
		   AND NOT EXISTS (SELECT 1 FROM "app"."customer_contact_phones" p
		                    WHERE p."tenant_id" = c."tenant_id" AND p."contact_id" = c."id")
		 ORDER BY c."id";
		GET DIAGNOSTICS n = ROW_COUNT;
		v_customer := v_customer + n;

		INSERT INTO "app"."vendor_contact_phones" ("tenant_id", "contact_id", "country", "e164", "label", "sort_order", "is_primary")
		SELECT c."tenant_id", c."id", pg_temp.fx9_phone_country(c."phone_e164"), c."phone_e164", NULL, 0, true
		  FROM "app"."vendor_contacts" c
		 WHERE c."tenant_id" = v_tenant
		   AND c."phone_e164" IS NOT NULL
		   AND pg_temp.fx9_phone_country(c."phone_e164") IS NOT NULL
		   AND NOT EXISTS (SELECT 1 FROM "app"."vendor_contact_phones" p
		                    WHERE p."tenant_id" = c."tenant_id" AND p."contact_id" = c."id")
		 ORDER BY c."id";
		GET DIAGNOSTICS n = ROW_COUNT;
		v_vendor := v_vendor + n;

		PERFORM set_config('bos.organization_id', '', true);
	END LOOP;

	-- lead_phones and leads carry organization_id, so their audit events take it from the row.
	INSERT INTO "app"."lead_phones" ("tenant_id", "organization_id", "lead_id", "country", "e164", "label", "sort_order", "is_primary")
	SELECT l."tenant_id", l."organization_id", l."id", pg_temp.fx9_phone_country(l."phone_e164"), l."phone_e164", NULL, 0, true
	  FROM "app"."leads" l
	 WHERE l."phone_e164" IS NOT NULL
	   AND pg_temp.fx9_phone_country(l."phone_e164") IS NOT NULL
	   AND NOT EXISTS (SELECT 1 FROM "app"."lead_phones" p
	                    WHERE p."tenant_id" = l."tenant_id" AND p."organization_id" = l."organization_id" AND p."lead_id" = l."id")
	 ORDER BY l."tenant_id", l."id";
	GET DIAGNOSTICS n = ROW_COUNT;
	v_lead := v_lead + n;

	UPDATE "app"."leads" l
	   SET "phones_search" = s."numbers"
	  FROM (SELECT p."tenant_id", p."organization_id", p."lead_id",
	               string_agg(p."e164", ' ' ORDER BY p."sort_order", p."e164") AS "numbers"
	          FROM "app"."lead_phones" p
	         GROUP BY p."tenant_id", p."organization_id", p."lead_id") s
	 WHERE l."tenant_id" = s."tenant_id" AND l."organization_id" = s."organization_id" AND l."id" = s."lead_id"
	   AND l."phones_search" IS DISTINCT FROM s."numbers";
	GET DIAGNOSTICS n = ROW_COUNT;
	v_search := v_search + n;

	RAISE NOTICE 'migration-0193: phone rows written customer_contact=%, vendor_contact=%, lead=%; leads.phones_search written=%',
		v_customer, v_vendor, v_lead, v_search;
END
$$;
--> statement-breakpoint
RESET lock_timeout;
