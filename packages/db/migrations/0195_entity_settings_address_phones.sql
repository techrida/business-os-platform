-- 0195_entity_settings_address_phones: the company profile's address and phones move to the FX9 shapes (data half).
--
-- Data written (audited as system:migration-0195):
--   * app.settings `entity.address`: when the latest version still holds the old Address object ({line1, line2?, city,
--     district?, province?, postalCode?, country}), the next version is {line, city, country}: line = line1, or
--     line1 || ', ' || line2 when line2 is set, cut at 500 characters (the contract's limit; two old 200-character
--     lines joined are 402, so the cut is only a safeguard); district, province and postalCode are dropped. An old
--     value without line1, city or a country in the ISO 3166-1 alpha-2 list below gets null as the next version (the
--     setting is nullable: "not set yet", and no PDF renders until an admin sets it again). A null or an
--     already-converted value is left alone.
--   * app.settings `entity.profile`: when the latest version's `phones` holds strings (FX8 E.164), the next version
--     holds [{country, e164, label: null}], the country read from the calling code by the same function as 0193 (the
--     generated table of every calling code, with the same national-part pre-filter and Nepal rule). A string that is
--     not E.164 once spaces, dots, hyphens and brackets are removed, whose code is unknown, or whose national part
--     fails its check, is dropped (Kuu: dev data may be cleared, nothing is kept unconverted). Elements that are
--     already objects are kept as they are.
--   * app.settings `entity.pan_vat_no`: 0187 left a value that is not nine digits as stored, but the issuer and the
--     company editor read only nine digits, so documents silently dropped it. The latest version becomes the
--     canonical value: nine digits once spaces and hyphens are removed, otherwise null (the setting is nullable; an
--     admin enters the PAN again). A null or an already nine-digit value is left alone.
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
	target record;
	latest record;
	phone jsonb;
	cleaned text;
	v_country text;
	new_value jsonb;
	new_phones jsonb;
	new_pan text;
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
		   AND coalesce(latest."value" ->> 'country', '') = ANY (v_iso) THEN
			-- Cut at the contract's 500 characters, a safeguard only (two old 200-character lines joined are 402).
			new_value := jsonb_build_object(
				'line', rtrim(left(CASE
				          WHEN coalesce(btrim(latest."value" ->> 'line2'), '') = '' THEN btrim(latest."value" ->> 'line1')
				          ELSE btrim(latest."value" ->> 'line1') || ', ' || btrim(latest."value" ->> 'line2')
				        END, 500)),
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

	-- entity.pan_vat_no: a JSON string (or null), as 0187 reads it, with the same lock text.
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
		CONTINUE WHEN latest."value" IS NULL OR jsonb_typeof(latest."value") = 'null';
		new_pan := CASE WHEN jsonb_typeof(latest."value") IN ('string', 'number')
		                THEN regexp_replace(latest."value" #>> '{}', '[[:space:]-]', '', 'g') END;
		new_value := CASE WHEN new_pan ~ '^[0-9]{9}$' THEN to_jsonb(new_pan) ELSE 'null'::jsonb END;
		IF new_value IS DISTINCT FROM latest."value" THEN
			INSERT INTO "app"."settings" ("tenant_id", "organization_id", "key", "version", "value", "created_by")
			VALUES (target."tenant_id", target."organization_id", 'entity.pan_vat_no', latest."version" + 1, new_value, NULL);
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
