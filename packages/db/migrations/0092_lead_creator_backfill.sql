-- 0092_lead_creator_backfill: historic leads get the creator their audit trail names (D50).
--
-- 0080 added leads.created_by_user_id and left it NULL for existing leads. Since 0088, Finance, Accountant and PMO
-- read leads and opportunities through creator reach, so a lead one of them entered and handed to a Sales owner
-- before 0080 dropped out of their view. Every lead the API created is audited as `lead.created` (entity_type
-- 'leads', entity_id the lead id) by the user who entered it, in the same transaction. A NULL creator is filled
-- from that event when:
--   * every `lead.created` event of the lead names one and the same actor (two different actors, of any kind,
--     is ambiguous and stays NULL);
--   * that actor is a user (actor_kind 'user'; seed, system and zitadel writes name no person);
--   * the actor id is a user of the lead's own tenant (anyone else, or an id that is no user, stays NULL).
-- A creator already set is never changed, and version and updated_at stay as they are (nothing a form edits
-- changes). Running it again finds nothing: a filled lead is no longer NULL. The counts are RAISE NOTICEd.
--
-- Runs as bos_owner, in the migrator's one transaction, split at the breakpoint comments. leads is entity-owned,
-- so each fill's row audit takes the tenant and entity from the row and is recorded as system:migration-0092.

SELECT
	set_config('bos.actor_kind', 'system', true),
	set_config('bos.actor_id', 'system:migration-0092', true),
	set_config('bos.correlation_id', 'migration-0092:' || gen_random_uuid()::text, true),
	set_config('bos.ip', '', true),
	set_config('bos.user_agent', '', true);
--> statement-breakpoint

DO $$
DECLARE
	v_missing bigint;
	v_filled bigint;
	v_left bigint;
BEGIN
	SELECT count(*) INTO v_missing FROM "app"."leads" WHERE "created_by_user_id" IS NULL;

	-- Actor ids are compared as text: audit ids are free text (system:<job>), so a cast could fail.
	UPDATE "app"."leads" l
	SET "created_by_user_id" = u."id"
	FROM (
		SELECT e."tenant_id", e."entity_id", min(e."actor_kind") AS actor_kind, min(lower(e."actor_id")) AS actor_id
		FROM "audit"."audit_events" e
		WHERE e."action" = 'lead.created' AND e."entity_type" = 'leads'
		GROUP BY e."tenant_id", e."entity_id"
		HAVING count(DISTINCT e."actor_kind" || ':' || lower(e."actor_id")) = 1
	) c
	JOIN "app"."users" u ON u."tenant_id" = c."tenant_id" AND u."id"::text = c.actor_id
	WHERE c.actor_kind = 'user'
		AND c."tenant_id" = l."tenant_id" AND c."entity_id" = l."id"::text
		AND l."created_by_user_id" IS NULL;
	GET DIAGNOSTICS v_filled = ROW_COUNT;

	SELECT count(*) INTO v_left FROM "app"."leads" WHERE "created_by_user_id" IS NULL;
	RAISE NOTICE 'migration-0092: leads without a creator before=%, filled from lead.created=%, still without one (no single known user in the audit trail)=%',
		v_missing, v_filled, v_left;
END
$$;
