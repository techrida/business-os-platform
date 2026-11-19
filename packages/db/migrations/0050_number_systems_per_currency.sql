-- 0050_number_systems_per_currency: number grouping is chosen per currency (D30), not once for the whole company.
--
-- The single setting `format.number_system` is replaced by `format.number_systems`, one value per currency:
--   { "NPR": ..., "INR": ..., "USD": ... }, each "south_asian" or "international".
-- A company that never saved the old key needs no row: the default (NPR and INR south_asian, USD international)
-- is today's behaviour. A company that did save it keeps what it chose for NPR and INR. USD is not carried over:
-- before U9 it was always written international, and U9 only made it follow the single setting; the per-currency
-- default restores that, and the company can change it on the Number format screen.
--   * Append-only: the old rows stay as history and nothing reads them any more. The new key starts at version 1.
--   * Snapshots of documents already sent are not touched; their stored single `numberSystem` still applies to
--     every currency on a reprint (snapshotNumberSystems in packages/contracts).

SELECT
	set_config('bos.actor_kind', 'system', true),
	set_config('bos.actor_id', 'system:migration-0050', true),
	set_config('bos.correlation_id', 'migration-0050:' || gen_random_uuid()::text, true),
	set_config('bos.ip', '', true),
	set_config('bos.user_agent', '', true);
--> statement-breakpoint

INSERT INTO "app"."settings" ("tenant_id", "organization_id", "key", "version", "value")
SELECT DISTINCT ON (s."tenant_id", s."organization_id")
	s."tenant_id",
	s."organization_id",
	'format.number_systems',
	1,
	jsonb_build_object('NPR', s."value", 'INR', s."value", 'USD', to_jsonb('international'::text))
  FROM "app"."settings" s
 WHERE s."key" = 'format.number_system'
   AND s."value" IN (to_jsonb('south_asian'::text), to_jsonb('international'::text))
   AND NOT EXISTS (
		SELECT 1 FROM "app"."settings" n
		 WHERE n."tenant_id" = s."tenant_id" AND n."organization_id" = s."organization_id"
		   AND n."key" = 'format.number_systems')
 ORDER BY s."tenant_id", s."organization_id", s."version" DESC;
