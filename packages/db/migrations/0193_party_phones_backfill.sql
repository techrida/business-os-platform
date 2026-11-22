-- 0193_party_phones_backfill: the old single phone_e164 of each contact and lead becomes its first phone row (FX9).
--
-- Data written (audited as system:migration-0193):
--   * customer_contact_phones, vendor_contact_phones, lead_phones: one row per old customer_contacts.phone_e164,
--     vendor_contacts.phone_e164 and leads.phone_e164, as the owner's primary number (is_primary, sort_order 0,
--     label NULL). The contact tables are tenant-level, so their writes take each tenant's default entity as the
--     acting entity (as 0013 does); bos.organization_id is reset to '' after each tenant.
--   * leads.phones_search: the lead's numbers, space-separated in sort order (only leads that got a number).
-- The number's country comes from its calling code through pg_temp.fx9_phone_country below: every calling code of
-- the pinned libphonenumber-js metadata (a generated table) maps to its main country, and the national part must
-- have one of that country's possible lengths, or match a stricter hand-written pattern for the common codes (+1
-- must be a NANP number: a 2-9 area code and a 2-9 exchange; a +977 national number starting with 9 is a 10-digit
-- mobile, a landline is 7 to 9 digits starting with neither 0 nor 9). A number whose code is unknown, or whose
-- national part fails its check, is not copied (Kuu: dev data may be cleared, so nothing is kept unconverted). The
-- check is a conservative pre-filter of the app's libphonenumber validation, not a copy of it. A country is never
-- guessed from digits without a code: every old value is already E.164 (the old CHECK).
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

-- The country of an E.164 number from its calling code, or NULL. Calling codes are prefix-free, so at most one row
-- of `c` matches (the longest-first order is only a safeguard); a national part that fails its check gives NULL
-- rather than falling through to a shorter code.
--   * `c` is GENERATED, do not edit by hand: every calling code in the libphonenumber-js 1.13.17 min metadata (the
--     version pinned in @bos/contracts) with its main country (the metadata's first country for the code: 1 -> US,
--     7 -> RU, 44 -> GB, 47 -> NO, 977 -> NP) and that country's possible national-number lengths. +247 (AC) and +383
--     (XK) are left out: no ISO 3166-1 country uses them, so such a number is not copied. Regenerate with this
--     command, run from packages/contracts (it prints "code country lengths" per row), and keep the function
--     identical in 0193 and 0195:
--       node -e "const m=require('libphonenumber-js/metadata.min.json'),iso=[...require('fs').readFileSync('src/countries.ts','utf8').split('export const ISO_COUNTRIES')[1].split('] as const')[0].matchAll(/'([A-Z]{2})'/g)].map(x=>x[1]);for(const[k,cs]of Object.entries(m.country_calling_codes)){const c=cs.find(x=>iso.includes(x));if(c)console.log(k,c,m.countries[c][3].join(','))}"
--   * `s` is hand-written: a stricter national pattern for the common codes, used instead of the length check. +1 is
--     read as US (the rest of the North American plan is not told apart here) and must be a NANP number (area code
--     and exchange each start with 2-9). +977 follows the Nepal rule of @bos/contracts: a national number starting
--     with 9 is a mobile of exactly 10 digits; a landline is 7 to 9 digits starting with neither 0 nor 9.
-- A conservative pre-filter only: the app's libphonenumber check (phoneProblem in @bos/contracts) is the authority,
-- and a number this keeps may still be refused by the app (for example an unassigned area code).
CREATE OR REPLACE FUNCTION pg_temp.fx9_phone_country(e164 text) RETURNS char(2)
LANGUAGE sql IMMUTABLE AS $$
	SELECT CASE
		WHEN e164 !~ '^\+[1-9][0-9]{6,14}$' THEN NULL
		ELSE (
			SELECT CASE
			         WHEN s.national IS NOT NULL THEN CASE WHEN n.digits ~ s.national THEN c.country END
			         WHEN length(n.digits) = ANY (c.lengths::int[]) THEN c.country
			       END
			  FROM (VALUES
				('1', 'US', '{10}'), ('7', 'RU', '{10,14}'), ('20', 'EG', '{8,9,10}'), ('27', 'ZA', '{5,6,7,8,9,10}'),
				('30', 'GR', '{10,11,12}'), ('31', 'NL', '{5,6,7,8,9,10,11}'), ('32', 'BE', '{8,9}'),
				('33', 'FR', '{9}'), ('34', 'ES', '{9}'), ('36', 'HU', '{8,9}'), ('39', 'IT', '{6,7,8,9,10,11,12}'),
				('40', 'RO', '{6,9}'), ('41', 'CH', '{9,12}'), ('43', 'AT', '{4,5,6,7,8,9,10,11,12,13}'),
				('44', 'GB', '{7,9,10}'), ('45', 'DK', '{8}'), ('46', 'SE', '{6,7,8,9,10,12}'), ('47', 'NO', '{5,8}'),
				('48', 'PL', '{6,7,8,9,10}'), ('49', 'DE', '{4,5,6,7,8,9,10,11,12,13,14,15}'), ('51', 'PE', '{8,9}'),
				('52', 'MX', '{10}'), ('53', 'CU', '{6,7,8,10}'), ('54', 'AR', '{10,11}'), ('55', 'BR', '{8,9,10,11}'),
				('56', 'CL', '{9,10,11}'), ('57', 'CO', '{8,10,11}'), ('58', 'VE', '{10}'), ('60', 'MY', '{8,9,10}'),
				('61', 'AU', '{5,6,7,8,9,10,12}'), ('62', 'ID', '{7,8,9,10,11,12,13,14,15,16,17}'),
				('63', 'PH', '{6,8,9,10,11,12,13}'), ('64', 'NZ', '{5,6,7,8,9,10,11,12,13,14}'),
				('65', 'SG', '{8,10,11}'), ('66', 'TH', '{8,9,10,13}'), ('81', 'JP', '{8,9,10,11,12,13,14,15,16,17}'),
				('82', 'KR', '{5,6,8,9,10,11,12,13,14}'), ('84', 'VN', '{7,8,9,10}'), ('86', 'CN', '{7,8,9,10,11,12}'),
				('90', 'TR', '{7,10,12,13}'), ('91', 'IN', '{8,9,10,11,12,13}'), ('92', 'PK', '{8,9,10,11,12}'),
				('93', 'AF', '{9}'), ('94', 'LK', '{9}'), ('95', 'MM', '{6,7,8,9,10}'), ('98', 'IR', '{4,5,6,7,10}'),
				('211', 'SS', '{9}'), ('212', 'MA', '{9}'), ('213', 'DZ', '{8,9}'), ('216', 'TN', '{8}'),
				('218', 'LY', '{9}'), ('220', 'GM', '{7,9}'), ('221', 'SN', '{9}'), ('222', 'MR', '{8}'),
				('223', 'ML', '{8}'), ('224', 'GN', '{8,9}'), ('225', 'CI', '{10}'), ('226', 'BF', '{8}'),
				('227', 'NE', '{8}'), ('228', 'TG', '{8}'), ('229', 'BJ', '{10}'), ('230', 'MU', '{7,8,10}'),
				('231', 'LR', '{7,8,9}'), ('232', 'SL', '{8}'), ('233', 'GH', '{8,9}'),
				('234', 'NG', '{10,11,12,13,14}'), ('235', 'TD', '{8}'), ('236', 'CF', '{8}'), ('237', 'CM', '{8,9}'),
				('238', 'CV', '{7}'), ('239', 'ST', '{7}'), ('240', 'GQ', '{9}'), ('241', 'GA', '{7,8}'),
				('242', 'CG', '{9}'), ('243', 'CD', '{7,8,9,10}'), ('244', 'AO', '{9}'), ('245', 'GW', '{7,9}'),
				('246', 'IO', '{7}'), ('248', 'SC', '{7}'), ('249', 'SD', '{9}'), ('250', 'RW', '{8,9}'),
				('251', 'ET', '{9}'), ('252', 'SO', '{6,7,8,9}'), ('253', 'DJ', '{8}'), ('254', 'KE', '{7,8,9,10}'),
				('255', 'TZ', '{9}'), ('256', 'UG', '{9}'), ('257', 'BI', '{8}'), ('258', 'MZ', '{8,9}'),
				('260', 'ZM', '{9}'), ('261', 'MG', '{9}'), ('262', 'RE', '{9}'), ('263', 'ZW', '{7,9,10}'),
				('264', 'NA', '{8,9}'), ('265', 'MW', '{7,9}'), ('266', 'LS', '{8}'), ('267', 'BW', '{7,8,10}'),
				('268', 'SZ', '{8,9}'), ('269', 'KM', '{7}'), ('290', 'SH', '{4,5}'), ('291', 'ER', '{7}'),
				('297', 'AW', '{7}'), ('298', 'FO', '{6}'), ('299', 'GL', '{6}'), ('350', 'GI', '{8}'),
				('351', 'PT', '{9}'), ('352', 'LU', '{4,5,6,7,8,9,10,11}'), ('353', 'IE', '{7,8,9,10}'),
				('354', 'IS', '{7,9}'), ('355', 'AL', '{6,7,8,9}'), ('356', 'MT', '{8}'), ('357', 'CY', '{8}'),
				('358', 'FI', '{5,6,7,8,9,10,11,12}'), ('359', 'BG', '{6,7,8,9,12}'), ('370', 'LT', '{8}'),
				('371', 'LV', '{8}'), ('372', 'EE', '{7,8,10}'), ('373', 'MD', '{8}'), ('374', 'AM', '{8}'),
				('375', 'BY', '{6,7,8,9,10,11}'), ('376', 'AD', '{6,8,9}'), ('377', 'MC', '{8,9}'),
				('378', 'SM', '{8,10}'), ('380', 'UA', '{9,10}'), ('381', 'RS', '{6,7,8,9,10,11,12}'),
				('382', 'ME', '{8,9}'), ('385', 'HR', '{7,8,9}'), ('386', 'SI', '{5,6,7,8}'), ('387', 'BA', '{8,9}'),
				('389', 'MK', '{8}'), ('420', 'CZ', '{9,10,11,12}'), ('421', 'SK', '{6,7,9}'), ('423', 'LI', '{7,9}'),
				('500', 'FK', '{5}'), ('501', 'BZ', '{7,11}'), ('502', 'GT', '{8,11}'), ('503', 'SV', '{7,8,11}'),
				('504', 'HN', '{8,11}'), ('505', 'NI', '{8}'), ('506', 'CR', '{8,10}'), ('507', 'PA', '{7,8,10,11}'),
				('508', 'PM', '{6,9}'), ('509', 'HT', '{8}'), ('590', 'GP', '{9}'), ('591', 'BO', '{8,9}'),
				('592', 'GY', '{7}'), ('593', 'EC', '{8,9,10,11}'), ('594', 'GF', '{9}'),
				('595', 'PY', '{6,7,8,9,10,11}'), ('596', 'MQ', '{9}'), ('597', 'SR', '{6,7}'),
				('598', 'UY', '{4,5,6,7,8,9,10,11,12,13}'), ('599', 'CW', '{7,8}'), ('670', 'TL', '{7,8}'),
				('672', 'NF', '{6}'), ('673', 'BN', '{7}'), ('674', 'NR', '{7}'), ('675', 'PG', '{7,8}'),
				('676', 'TO', '{5,7}'), ('677', 'SB', '{5,7}'), ('678', 'VU', '{5,7}'), ('679', 'FJ', '{7,11}'),
				('680', 'PW', '{7}'), ('681', 'WF', '{6,9}'), ('682', 'CK', '{5}'), ('683', 'NU', '{4,7}'),
				('685', 'WS', '{5,6,7,10}'), ('686', 'KI', '{5,8}'), ('687', 'NC', '{6}'), ('688', 'TV', '{5,6,7}'),
				('689', 'PF', '{6,8,9}'), ('690', 'TK', '{4,5,6,7}'), ('691', 'FM', '{7}'), ('692', 'MH', '{7}'),
				('850', 'KP', '{8,10}'), ('852', 'HK', '{5,6,7,8,9,11}'), ('853', 'MO', '{7,8}'),
				('855', 'KH', '{8,9,10}'), ('856', 'LA', '{8,9,10}'), ('880', 'BD', '{6,7,8,9,10}'),
				('886', 'TW', '{7,8,9,10,11}'), ('960', 'MV', '{7,10}'), ('961', 'LB', '{7,8}'),
				('962', 'JO', '{8,9}'), ('963', 'SY', '{8,9}'), ('964', 'IQ', '{8,9,10}'), ('965', 'KW', '{7,8}'),
				('966', 'SA', '{9,10}'), ('967', 'YE', '{7,8,9}'), ('968', 'OM', '{7,8,9}'), ('970', 'PS', '{8,9,10}'),
				('971', 'AE', '{5,6,7,8,9,10,11,12}'), ('972', 'IL', '{7,8,9,10,11,12}'), ('973', 'BH', '{8}'),
				('974', 'QA', '{7,8,9,11}'), ('975', 'BT', '{7,8}'), ('976', 'MN', '{8,9,10}'),
				('977', 'NP', '{8,10,11}'), ('992', 'TJ', '{9}'), ('993', 'TM', '{8}'), ('994', 'AZ', '{9}'),
				('995', 'GE', '{9}'), ('996', 'KG', '{9,10}'), ('998', 'UZ', '{9}')
			  ) AS c(code, country, lengths)
			  LEFT JOIN (VALUES
				('880', '^(1[0-9]{9}|[2-9][0-9]{7,8})$'),
				('971', '^[2-9][0-9]{7,8}$'),
				('977', '^(9[0-9]{9}|[1-8][0-9]{6,8})$'),
				('91', '^[6-9][0-9]{9}$'),
				('44', '^[1-9][0-9]{9}$'),
				('86', '^(1[0-9]{10}|[2-9][0-9]{8,9})$'),
				('61', '^[2-478][0-9]{8}$'),
				('92', '^[2-9][0-9]{9}$'),
				('94', '^[1-9][0-9]{8}$'),
				('49', '^[1-9][0-9]{9,10}$'),
				('33', '^[1-9][0-9]{8}$'),
				('81', '^[1-9][0-9]{8,9}$'),
				('65', '^[3689][0-9]{7}$'),
				('1', '^[2-9][0-9]{2}[2-9][0-9]{6}$')
			  ) AS s(code, national) ON s.code = c.code
			 CROSS JOIN LATERAL (SELECT substr(e164, 2 + length(c.code)) AS digits) AS n
			 WHERE substr(e164, 2) LIKE c.code || '%'
			 ORDER BY length(c.code) DESC
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
