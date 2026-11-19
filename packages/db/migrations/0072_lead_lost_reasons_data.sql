-- 0072_lead_lost_reasons_data: lost reasons as a list (D49), data half. Needs 0071.
--
--   (a) Every tenant gets the seven default options (Price, Chose a competitor, No budget, No response, Not a fit,
--       Timing, Other). A tenant created later is seeded by the API on first use.
--   (b) Each lost lead's free-text reason is matched, case-insensitively and trimmed, to an option by label. A match
--       sets lost_reason_id. No match goes to "Other", and the old words are kept at the front of the note
--       ("Reason given: <old text>"). stage_reason keeps the words as they were chosen.
-- The counts are RAISE NOTICEd. Every write is audited as system:migration-0072.
--
-- Runs as bos_owner, in the migrator's one transaction, split at the breakpoint comments.

SELECT
	set_config('bos.actor_kind', 'system', true),
	set_config('bos.actor_id', 'system:migration-0072', true),
	set_config('bos.correlation_id', 'migration-0072:' || gen_random_uuid()::text, true),
	set_config('bos.ip', '', true),
	set_config('bos.user_agent', '', true);
--> statement-breakpoint

DO $$
DECLARE
	v_tenants bigint;
	v_matched bigint;
	v_other bigint;
BEGIN
	INSERT INTO "app"."lead_lost_reasons" ("tenant_id", "label", "label_norm", "position", "default_key")
	SELECT t."id", d.label, lower(d.label), d.position, d.key
	FROM "app"."tenants" t
	CROSS JOIN (VALUES
		('price', 'Price', 0),
		('competitor', 'Chose a competitor', 1),
		('no_budget', 'No budget', 2),
		('no_response', 'No response', 3),
		('not_a_fit', 'Not a fit', 4),
		('timing', 'Timing', 5),
		('other', 'Other', 6)
	) AS d(key, label, position)
	ON CONFLICT DO NOTHING;
	GET DIAGNOSTICS v_tenants = ROW_COUNT;

	UPDATE "app"."leads" l
	SET "lost_reason_id" = r."id", "version" = l."version" + 1, "updated_at" = now()
	FROM "app"."lead_lost_reasons" r
	WHERE l."stage" = 'lost' AND l."lost_reason_id" IS NULL
		AND r."tenant_id" = l."tenant_id" AND r."label_norm" = lower(btrim(l."stage_reason"));
	GET DIAGNOSTICS v_matched = ROW_COUNT;

	UPDATE "app"."leads" l
	SET "lost_reason_id" = r."id",
		"stage_note" = 'Reason given: ' || l."stage_reason" || E'\n' || l."stage_note",
		"stage_reason" = r."label",
		"version" = l."version" + 1, "updated_at" = now()
	FROM "app"."lead_lost_reasons" r
	WHERE l."stage" = 'lost' AND l."lost_reason_id" IS NULL
		AND r."tenant_id" = l."tenant_id" AND r."default_key" = 'other';
	GET DIAGNOSTICS v_other = ROW_COUNT;

	RAISE NOTICE '0072: % default options seeded; lost leads matched to an option: %; moved to Other with the old text in the note: %',
		v_tenants, v_matched, v_other;
END $$;
