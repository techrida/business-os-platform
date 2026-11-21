-- 0171_credit_override_order_value_backfill: fills opportunities.credit_override_order_value (0170) for overrides
-- that were given before the value was kept (R5 FU4). The value is what the audit trail recorded when the override
-- was given: the `orderValue` of the deal's latest `opportunity.credit_overridden` event (the gross NPR value of the
-- order the override was given against, two decimals). An override whose event has no such value (given before
-- R4a Q1b counted the order) stays null and covers nothing, so its deal needs a new override: it fails closed.
-- Only rows that have an override and no value yet change; the deal's version does not move.
--
-- Runs as bos_owner in the migrator's transaction. bos.tenant_id and bos.organization_id are left unset:
-- opportunities are entity-owned, so the audit takes both from the row.
SELECT
	set_config('bos.actor_kind', 'system', true),
	set_config('bos.actor_id', 'system:migration-0171', true),
	set_config('bos.correlation_id', 'migration-0171:' || gen_random_uuid()::text, true),
	set_config('bos.ip', '', true),
	set_config('bos.user_agent', '', true);
--> statement-breakpoint
UPDATE "app"."opportunities" AS o
SET "credit_override_order_value" = e."order_value"
FROM (
	SELECT DISTINCT ON (ev."tenant_id", ev."entity_id")
		ev."tenant_id",
		ev."entity_id",
		(ev."meta" ->> 'orderValue')::numeric(18, 2) AS "order_value"
	FROM "audit"."audit_events" AS ev
	WHERE ev."action" = 'opportunity.credit_overridden'
		AND ev."entity_type" = 'opportunities'
		AND ev."meta" ->> 'orderValue' ~ '^[0-9]+\.[0-9]{2}$'
	ORDER BY ev."tenant_id", ev."entity_id", ev."occurred_at" DESC, ev."id" DESC
) AS e
WHERE e."tenant_id" = o."tenant_id"
	AND e."entity_id" = o."id"::text
	AND o."credit_override_at" IS NOT NULL
	AND o."credit_override_order_value" IS NULL;
