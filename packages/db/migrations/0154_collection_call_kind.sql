-- 0154_collection_call_kind: a call the payment-promise job plans for Finance is its own activity kind,
-- `collection_call` (R4c1 Q1 = b), instead of a plain `call`.
--
-- A plain call follows the customer's activity reach, so the customer's Sales owner could read and cancel a call
-- about money they may not see. The API reads and changes a collection call by the receivables permissions instead
-- (ar.read to read it, payment.record to complete, move or cancel it). No person can post the kind: it is not in
-- the contract's user or schedulable kinds.
--   * activities_kind_check gains 'collection_call'. It is dropped and added again before the backfill, so the
--     UPDATE below passes the new check.
--   * Backfill: every activity a payment promise names as its collection call (payment_promises.collection_activity_id,
--     set only by the job, 0113) becomes `collection_call`, open, completed and cancelled alike, so the history
--     reads the same. Only rows still of kind `call` change. The version moves, so a form open on one gets a 409.
--
-- Runs as bos_owner in the migrator's transaction. bos.tenant_id and bos.organization_id are left unset:
-- activities are entity-owned, so the audit takes both from the row.
SELECT
	set_config('bos.actor_kind', 'system', true),
	set_config('bos.actor_id', 'system:migration-0154', true),
	set_config('bos.correlation_id', 'migration-0154:' || gen_random_uuid()::text, true),
	set_config('bos.ip', '', true),
	set_config('bos.user_agent', '', true);
--> statement-breakpoint
ALTER TABLE "app"."activities" DROP CONSTRAINT "activities_kind_check";
--> statement-breakpoint
ALTER TABLE "app"."activities" ADD CONSTRAINT "activities_kind_check" CHECK ("kind" in ('call', 'meeting', 'email', 'note', 'task', 'stage_change', 'system', 'collection_call'));
--> statement-breakpoint
UPDATE "app"."activities" AS a
SET "kind" = 'collection_call', "version" = a."version" + 1, "updated_at" = now()
FROM "app"."payment_promises" AS p
WHERE p."tenant_id" = a."tenant_id"
	AND p."organization_id" = a."organization_id"
	AND p."collection_activity_id" = a."id"
	AND a."kind" = 'call';
