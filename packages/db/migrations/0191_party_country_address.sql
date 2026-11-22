-- 0191_party_country_address: every party gets an explicit country, and an address is three fields (FX9, Kuu 2026-11-22).
--
--   * country char(2) NOT NULL DEFAULT 'NP' (ISO 3166-1 alpha-2, <table>_country_check) on customers, leads,
--     customer_contacts and vendor_contacts. vendors.country (0032) already exists and is reused. A contact's country
--     may differ from its company's.
--   * customers: address_line and address_city (text NOT NULL, not blank) replace the free-form `address` jsonb and
--     its customers_address_check. The street lines are one free-text field; the country is customers.country.
--   * vendors: address_line and address_city, nullable, set together or not at all (vendors_address_check).
--
-- Data written (audited as system:migration-0191; the tenant-level tables take each tenant's default entity as the
-- acting entity, as 0013 does, and bos.organization_id is reset to '' after each tenant):
--   * customers: address_line = line1, or line1 || ', ' || line2 when line2 is set, cut at 500 characters (the
--     contract's limit; two old 200-character lines joined are 402, so the cut is only a safeguard); address_city =
--     city; country = address->>'country'. district, province and postalCode are dropped (no screen shows them any
--     more). A customer whose address has no line1, no city or a country outside the ISO 3166-1 alpha-2 list below
--     is not guessed at: the migration RAISEs and rolls back (Kuu: dev data may be reset, so a blank address or an
--     unknown country is never written).
--   * customer_contacts and vendor_contacts take their parent's country when it is not NP (NP is the default).
--   * leads keep the default NP: a lead has no address to read a country from.
--
-- Not re-runnable: it drops its source column (customers.address). The data half only ever runs once, through the
-- migrator. The short lock_timeout gives up (and fails the deploy) rather than queue behind a long transaction while
-- holding the ALTER TABLE locks. Runs as bos_owner, in the migrator's one transaction, split at the breakpoint
-- comments (same rule as 0000).

SELECT
	set_config('bos.actor_kind', 'system', true),
	set_config('bos.actor_id', 'system:migration-0191', true),
	set_config('bos.correlation_id', 'migration-0191:' || gen_random_uuid()::text, true),
	set_config('bos.ip', '', true),
	set_config('bos.user_agent', '', true);
--> statement-breakpoint
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "app"."customers" ADD COLUMN "country" char(2) DEFAULT 'NP' NOT NULL;
--> statement-breakpoint
ALTER TABLE "app"."customers" ADD CONSTRAINT "customers_country_check" CHECK ("country" ~ '^[A-Z]{2}$');
--> statement-breakpoint
ALTER TABLE "app"."customers" ADD COLUMN "address_line" text;
--> statement-breakpoint
ALTER TABLE "app"."customers" ADD COLUMN "address_city" text;
--> statement-breakpoint
ALTER TABLE "app"."leads" ADD COLUMN "country" char(2) DEFAULT 'NP' NOT NULL;
--> statement-breakpoint
ALTER TABLE "app"."leads" ADD CONSTRAINT "leads_country_check" CHECK ("country" ~ '^[A-Z]{2}$');
--> statement-breakpoint
ALTER TABLE "app"."customer_contacts" ADD COLUMN "country" char(2) DEFAULT 'NP' NOT NULL;
--> statement-breakpoint
ALTER TABLE "app"."customer_contacts" ADD CONSTRAINT "customer_contacts_country_check" CHECK ("country" ~ '^[A-Z]{2}$');
--> statement-breakpoint
ALTER TABLE "app"."vendor_contacts" ADD COLUMN "country" char(2) DEFAULT 'NP' NOT NULL;
--> statement-breakpoint
ALTER TABLE "app"."vendor_contacts" ADD CONSTRAINT "vendor_contacts_country_check" CHECK ("country" ~ '^[A-Z]{2}$');
--> statement-breakpoint
ALTER TABLE "app"."vendors" ADD COLUMN "address_line" text;
--> statement-breakpoint
ALTER TABLE "app"."vendors" ADD COLUMN "address_city" text;
--> statement-breakpoint
DO $$
DECLARE
	bad record;
	-- ISO 3166-1 alpha-2, the 249 codes of ISO_COUNTRIES in packages/contracts/src/countries.ts (CountryCodeSchema).
	v_iso constant text[] := ARRAY[
		'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AW', 'AX', 'AZ', 'BA', 'BB', 'BD',
		'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ', 'BR', 'BS', 'BT', 'BV', 'BW', 'BY', 'BZ', 'CA',
		'CC', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN', 'CO', 'CR', 'CU', 'CV', 'CW', 'CX', 'CY', 'CZ', 'DE',
		'DJ', 'DK', 'DM', 'DO', 'DZ', 'EC', 'EE', 'EG', 'EH', 'ER', 'ES', 'ET', 'FI', 'FJ', 'FK', 'FM', 'FO', 'FR', 'GA',
		'GB', 'GD', 'GE', 'GF', 'GG', 'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT', 'GU', 'GW', 'GY', 'HK',
		'HM', 'HN', 'HR', 'HT', 'HU', 'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR', 'IS', 'IT', 'JE', 'JM', 'JO', 'JP',
		'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KP', 'KR', 'KW', 'KY', 'KZ', 'LA', 'LB', 'LC', 'LI', 'LK', 'LR', 'LS', 'LT',
		'LU', 'LV', 'LY', 'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK', 'ML', 'MM', 'MN', 'MO', 'MP', 'MQ', 'MR', 'MS',
		'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ', 'NA', 'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP', 'NR', 'NU', 'NZ',
		'OM', 'PA', 'PE', 'PF', 'PG', 'PH', 'PK', 'PL', 'PM', 'PN', 'PR', 'PS', 'PT', 'PW', 'PY', 'QA', 'RE', 'RO', 'RS',
		'RU', 'RW', 'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS', 'ST',
		'SV', 'SX', 'SY', 'SZ', 'TC', 'TD', 'TF', 'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO', 'TR', 'TT', 'TV', 'TW',
		'TZ', 'UA', 'UG', 'UM', 'US', 'UY', 'UZ', 'VA', 'VC', 'VE', 'VG', 'VI', 'VN', 'VU', 'WF', 'WS', 'YE', 'YT', 'ZA',
		'ZM', 'ZW'
	];
	v_tenant uuid;
	v_default uuid;
	v_customers bigint := 0;
	v_contacts bigint := 0;
	n bigint;
BEGIN
	-- Refuse before writing anything: a customer address this migration cannot convert with certainty.
	SELECT c."tenant_id", c."id", c."address" INTO bad
	  FROM "app"."customers" c
	 WHERE jsonb_typeof(c."address") IS DISTINCT FROM 'object'
	    OR jsonb_typeof(c."address" -> 'line1') IS DISTINCT FROM 'string'
	    OR btrim(c."address" ->> 'line1') = ''
	    OR jsonb_typeof(c."address" -> 'city') IS DISTINCT FROM 'string'
	    OR btrim(c."address" ->> 'city') = ''
	    OR NOT (coalesce(c."address" ->> 'country', '') = ANY (v_iso))
	 ORDER BY c."tenant_id", c."id"
	 LIMIT 1;
	IF FOUND THEN
		RAISE EXCEPTION 'migration-0191: tenant % customer % has an address without line1, city or an ISO 3166-1 country (%); fix it or reset the dev database',
			bad."tenant_id", bad."id", bad."address";
	END IF;

	FOR v_tenant, v_default IN
		SELECT o."tenant_id", o."id" FROM "app"."organizations" o WHERE o."is_default" ORDER BY o."tenant_id"
	LOOP
		PERFORM set_config('bos.organization_id', v_default::text, true);

		UPDATE "app"."customers" c
		   -- Cut at the contract's 500 characters, a safeguard only (two old 200-character lines joined are 402).
		   SET "address_line" = rtrim(left(CASE
		                          WHEN coalesce(btrim(c."address" ->> 'line2'), '') = '' THEN btrim(c."address" ->> 'line1')
		                          ELSE btrim(c."address" ->> 'line1') || ', ' || btrim(c."address" ->> 'line2')
		                        END, 500)),
		       "address_city" = btrim(c."address" ->> 'city'),
		       "country" = c."address" ->> 'country'
		 WHERE c."tenant_id" = v_tenant AND c."address_line" IS NULL;
		GET DIAGNOSTICS n = ROW_COUNT;
		v_customers := v_customers + n;

		UPDATE "app"."customer_contacts" cc
		   SET "country" = c."country"
		  FROM "app"."customers" c
		 WHERE cc."tenant_id" = v_tenant AND c."tenant_id" = cc."tenant_id" AND c."id" = cc."customer_id"
		   AND cc."country" IS DISTINCT FROM c."country";
		GET DIAGNOSTICS n = ROW_COUNT;
		v_contacts := v_contacts + n;

		UPDATE "app"."vendor_contacts" vc
		   SET "country" = v."country"
		  FROM "app"."vendors" v
		 WHERE vc."tenant_id" = v_tenant AND v."tenant_id" = vc."tenant_id" AND v."id" = vc."vendor_id"
		   AND vc."country" IS DISTINCT FROM v."country";
		GET DIAGNOSTICS n = ROW_COUNT;
		v_contacts := v_contacts + n;

		PERFORM set_config('bos.organization_id', '', true);
	END LOOP;

	RAISE NOTICE 'migration-0191: customers converted=%, contacts given their parent''s country=%', v_customers, v_contacts;
END
$$;
--> statement-breakpoint
ALTER TABLE "app"."customers" ALTER COLUMN "address_line" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "app"."customers" ALTER COLUMN "address_city" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "app"."customers" ADD CONSTRAINT "customers_address_line_check" CHECK (btrim("address_line") <> '');
--> statement-breakpoint
ALTER TABLE "app"."customers" ADD CONSTRAINT "customers_address_city_check" CHECK (btrim("address_city") <> '');
--> statement-breakpoint
ALTER TABLE "app"."vendors" ADD CONSTRAINT "vendors_address_check" CHECK (("address_line" IS NULL) = ("address_city" IS NULL) AND btrim("address_line") <> '' AND btrim("address_city") <> '');
--> statement-breakpoint
ALTER TABLE "app"."customers" DROP CONSTRAINT "customers_address_check";
--> statement-breakpoint
ALTER TABLE "app"."customers" DROP COLUMN "address";
--> statement-breakpoint
RESET lock_timeout;
