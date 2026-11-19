-- 0091_opportunity_lost_reason_data: opportunity lost reasons from the shared tenant list (D49, D54-3), data half.
-- Needs 0090.
--
--   (a) Every tenant that has lost opportunities (lost_reason_id IS NULL) and no lost-reason options yet gets the
--       seven default options (Price, Chose a competitor, No budget, No response, Not a fit, Timing, Other).
--   (b) Each lost opportunity's free-text reason (stage = 'lost', lost_reason_id IS NULL) is matched,
--       case-insensitively and trimmed, to an option of its tenant by label_norm or default_key. A match sets
--       lost_reason_id and stage_reason becomes the option's label. No match goes to "Other" (default_key = 'other'),
--       keeping the old words at the front of stage_note ("Reason given: <old text>") and setting stage_reason to the
--       option's label.
-- The counts are RAISE NOTICEd. Every write is audited as system:migration-0091.
--
-- Runs as bos_owner, in the migrator's one transaction, split at the breakpoint comments.

SELECT
	set_config('bos.actor_kind', 'system', true),
	set_config('bos.actor_id', 'system:migration-0091', true),
	set_config('bos.correlation_id', 'migration-0091:' || gen_random_uuid()::text, true),
	set_config('bos.ip', '', true),
	set_config('bos.user_agent', '', true);
--> statement-breakpoint

DO $$
DECLARE
	v_tenant uuid;
	v_entity uuid;
	v_rows bigint;
	v_options bigint := 0;
	v_matched bigint;
	v_other bigint;
BEGIN
	-- lead_lost_reasons has no organization_id, so its audit events take bos.organization_id (as 0072 does):
	-- the tenant's default entity, reset to '' after each tenant. Only tenants with unmigrated lost
	-- opportunities and no options yet are seeded here.
	FOR v_tenant, v_entity IN
		SELECT o."tenant_id", o."id"
		FROM "app"."organizations" o
		WHERE o."is_default"
			AND EXISTS (
				SELECT 1 FROM "app"."opportunities" op
				WHERE op."tenant_id" = o."tenant_id"
					AND op."stage" = 'lost'
					AND op."lost_reason_id" IS NULL
			)
			AND NOT EXISTS (
				SELECT 1 FROM "app"."lead_lost_reasons" r
				WHERE r."tenant_id" = o."tenant_id"
			)
		ORDER BY o."tenant_id"
	LOOP
		PERFORM set_config('bos.organization_id', v_entity::text, true);
		INSERT INTO "app"."lead_lost_reasons" ("tenant_id", "label", "label_norm", "position", "default_key")
		SELECT v_tenant, d.label, lower(d.label), d.position, d.key
		FROM (VALUES
			('price', 'Price', 0),
			('competitor', 'Chose a competitor', 1),
			('no_budget', 'No budget', 2),
			('no_response', 'No response', 3),
			('not_a_fit', 'Not a fit', 4),
			('timing', 'Timing', 5),
			('other', 'Other', 6)
		) AS d(key, label, position)
		ON CONFLICT DO NOTHING;
		GET DIAGNOSTICS v_rows = ROW_COUNT;
		v_options := v_options + v_rows;
		PERFORM set_config('bos.organization_id', '', true);
	END LOOP;

	UPDATE "app"."opportunities" op
	SET "lost_reason_id" = m."id", "stage_reason" = m.label, "version" = op."version" + 1, "updated_at" = now()
	FROM (
		SELECT DISTINCT ON (x."id") x."id" AS opportunity_id, r."id", r."label"
		FROM "app"."opportunities" x
		JOIN "app"."lead_lost_reasons" r ON r."tenant_id" = x."tenant_id"
			AND (r."label_norm" = lower(btrim(x."stage_reason")) OR r."default_key" = lower(btrim(x."stage_reason")))
		WHERE x."stage" = 'lost' AND x."lost_reason_id" IS NULL
		ORDER BY x."id", (r."label_norm" = lower(btrim(x."stage_reason"))) DESC
	) m
	WHERE op."id" = m.opportunity_id;
	GET DIAGNOSTICS v_matched = ROW_COUNT;

	UPDATE "app"."opportunities" op
	SET "lost_reason_id" = r."id",
		"stage_note" = 'Reason given: ' || op."stage_reason" || E'\n' || op."stage_note",
		"stage_reason" = r."label",
		"version" = op."version" + 1, "updated_at" = now()
	FROM "app"."lead_lost_reasons" r
	WHERE op."stage" = 'lost' AND op."lost_reason_id" IS NULL
		AND r."tenant_id" = op."tenant_id" AND r."default_key" = 'other';
	GET DIAGNOSTICS v_other = ROW_COUNT;

	RAISE NOTICE '0091: % default options seeded; lost opportunities matched to an option: %; moved to Other with the old text in the note: %',
		v_options, v_matched, v_other;
END $$;
