-- 0089_follow_ups_to_current_owner: follow-ups left with a lead's previous owner move to its current owner (D54-1).
--
-- Since D45, changing a lead's owner moves the lead's planned follow-ups assigned to the old owner to the new one,
-- in the same transaction, and records the change as a `lead.owner_changed` event. Owner changes made before D45
-- left those follow-ups with the old owner, who may no longer see the lead. This finds them in the audit trail:
--   * an owner change from X: a `leads.update` row-audit event whose before.owner_user_id is X and whose after
--     differs, with no `lead.owner_changed` event in the same correlation (a D45 change already moved its
--     follow-ups, and anything left from it was assigned on purpose);
--   * a follow-up it left behind: a planned activity (call, meeting or email, due, neither completed nor cancelled)
--     on that lead, assigned to X, created no later than the change, whose assignee nobody changed after the
--     change (a reassignment after it was a choice), and not already assigned to the lead's current owner.
-- Each one moves to the lead's current owner (a lead without an owner keeps its follow-ups as they are), with its
-- version raised like the D45 move, so a form still open on the old assignee gets a 409. Running it again finds
-- nothing: a moved follow-up is assigned to the current owner. Before and after counts are RAISE NOTICEd.
--
-- Runs as bos_owner, in the migrator's one transaction, split at the breakpoint comments (same rule as 0000).

-- set_config(..., true) lasts to the end of the migrator's transaction, so every move is audited as
-- system:migration-0089. activities is entity-owned, so the audit takes the tenant and entity from the row.
SELECT
	set_config('bos.actor_kind', 'system', true),
	set_config('bos.actor_id', 'system:migration-0089', true),
	set_config('bos.correlation_id', 'migration-0089:' || gen_random_uuid()::text, true),
	set_config('bos.ip', '', true),
	set_config('bos.user_agent', '', true);
--> statement-breakpoint

DO $$
DECLARE
	v_with_other_assignee bigint;
	v_left_behind bigint;
	v_moved bigint;
	v_after_with_other_assignee bigint;
	v_after_left_behind bigint;
BEGIN
	CREATE TEMPORARY TABLE migration_0089_moves ON COMMIT DROP AS
	WITH owner_changes AS (
		SELECT
			change."id" AS event_id,
			change."tenant_id",
			change."entity_id" AS lead_id,
			change."before" ->> 'owner_user_id' AS from_user_id,
			change."occurred_at"
		FROM "audit"."audit_events" change
		WHERE change."entity_type" = 'leads'
			AND change."action" = 'leads.update'
			AND (change."before" ->> 'owner_user_id') IS NOT NULL
			AND (change."after" ->> 'owner_user_id') IS DISTINCT FROM (change."before" ->> 'owner_user_id')
			AND NOT EXISTS (
				SELECT 1
				FROM "audit"."audit_events" d45
				WHERE d45."tenant_id" = change."tenant_id"
					AND d45."correlation_id" = change."correlation_id"
					AND d45."action" = 'lead.owner_changed'
					AND d45."entity_id" = change."entity_id"
			)
	)
	SELECT DISTINCT a."id", l."owner_user_id" AS to_user_id
	FROM "app"."activities" a
	JOIN "app"."leads" l
		ON l."tenant_id" = a."tenant_id" AND l."organization_id" = a."organization_id" AND l."id" = a."lead_id"
	JOIN owner_changes c
		ON c."tenant_id" = a."tenant_id" AND c."lead_id" = a."lead_id"::text
		AND c."from_user_id" = a."assignee_user_id"::text
	WHERE a."kind" IN ('call', 'meeting', 'email')
		AND a."due_at" IS NOT NULL AND a."completed_at" IS NULL AND a."cancelled_at" IS NULL
		AND l."owner_user_id" IS NOT NULL
		AND a."assignee_user_id" IS DISTINCT FROM l."owner_user_id"
		AND a."created_at" <= c."occurred_at"
		AND NOT EXISTS (
			SELECT 1
			FROM "audit"."audit_events" later
			WHERE later."tenant_id" = a."tenant_id"
				AND later."entity_type" = 'activities'
				AND later."action" = 'activities.update'
				AND later."entity_id" = a."id"::text
				AND later."id" > c."event_id"
				AND (later."before" ->> 'assignee_user_id') IS DISTINCT FROM (later."after" ->> 'assignee_user_id')
		);

	-- Before: planned lead follow-ups not assigned to the lead's owner (moved here or left as they are), and how
	-- many of them a pre-D45 owner change left behind.
	SELECT count(*) INTO v_with_other_assignee
	FROM "app"."activities" a
	JOIN "app"."leads" l
		ON l."tenant_id" = a."tenant_id" AND l."organization_id" = a."organization_id" AND l."id" = a."lead_id"
	WHERE a."kind" IN ('call', 'meeting', 'email')
		AND a."due_at" IS NOT NULL AND a."completed_at" IS NULL AND a."cancelled_at" IS NULL
		AND l."owner_user_id" IS NOT NULL
		AND a."assignee_user_id" IS DISTINCT FROM l."owner_user_id";
	SELECT count(*) INTO v_left_behind FROM migration_0089_moves;
	RAISE NOTICE 'migration-0089 before: planned lead follow-ups not assigned to the lead owner=%, of them left behind by an owner change before D45=%',
		v_with_other_assignee, v_left_behind;

	UPDATE "app"."activities" a
	SET
		"assignee_user_id" = m."to_user_id",
		"version" = a."version" + 1,
		"updated_at" = now()
	FROM migration_0089_moves m
	WHERE a."id" = m."id";
	GET DIAGNOSTICS v_moved = ROW_COUNT;

	SELECT count(*) INTO v_after_with_other_assignee
	FROM "app"."activities" a
	JOIN "app"."leads" l
		ON l."tenant_id" = a."tenant_id" AND l."organization_id" = a."organization_id" AND l."id" = a."lead_id"
	WHERE a."kind" IN ('call', 'meeting', 'email')
		AND a."due_at" IS NOT NULL AND a."completed_at" IS NULL AND a."cancelled_at" IS NULL
		AND l."owner_user_id" IS NOT NULL
		AND a."assignee_user_id" IS DISTINCT FROM l."owner_user_id";
	SELECT count(*) INTO v_after_left_behind
	FROM "app"."activities" a
	JOIN migration_0089_moves m ON m."id" = a."id"
	WHERE a."assignee_user_id" IS DISTINCT FROM m."to_user_id";
	RAISE NOTICE 'migration-0089 after: follow-ups moved to the current owner=%, still with the previous owner=%, planned lead follow-ups not assigned to the lead owner (assigned on purpose)=%',
		v_moved, v_after_left_behind, v_after_with_other_assignee;

	DROP TABLE migration_0089_moves;
END
$$;
