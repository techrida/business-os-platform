-- 0102_opportunity_lead_creator_backfill: existing opportunities get the creator of the lead they came from (FX-Q1).
--
-- An opportunity converted before 0101 has lead_id set and lead_creator_user_id NULL. It takes the lead's
-- created_by_user_id (itself filled for historic leads by 0092), matched on tenant, entity and lead id. A lead with
-- no creator leaves the opportunity NULL. A value already set is never changed, and version and updated_at stay as
-- they are: nothing a form edits changes. Running it again finds nothing more to fill. The counts are RAISE NOTICEd.
--
-- Runs as bos_owner, in the migrator's one transaction, split at the breakpoint comments. opportunities is
-- entity-owned, so each fill's row audit takes the tenant and entity from the row and is recorded as
-- system:migration-0102.

SELECT
	set_config('bos.actor_kind', 'system', true),
	set_config('bos.actor_id', 'system:migration-0102', true),
	set_config('bos.correlation_id', 'migration-0102:' || gen_random_uuid()::text, true),
	set_config('bos.ip', '', true),
	set_config('bos.user_agent', '', true);
--> statement-breakpoint

DO $$
DECLARE
	v_from_leads bigint;
	v_filled bigint;
BEGIN
	SELECT count(*) INTO v_from_leads
	FROM "app"."opportunities"
	WHERE "lead_id" IS NOT NULL AND "lead_creator_user_id" IS NULL;

	UPDATE "app"."opportunities" o
	SET "lead_creator_user_id" = l."created_by_user_id"
	FROM "app"."leads" l
	WHERE l."tenant_id" = o."tenant_id"
		AND l."organization_id" = o."organization_id"
		AND l."id" = o."lead_id"
		AND l."created_by_user_id" IS NOT NULL
		AND o."lead_creator_user_id" IS NULL;
	GET DIAGNOSTICS v_filled = ROW_COUNT;

	RAISE NOTICE 'migration-0102: opportunities from a lead without a lead creator before=%, filled=%, left NULL (lead has no known creator)=%',
		v_from_leads, v_filled, v_from_leads - v_filled;
END
$$;
