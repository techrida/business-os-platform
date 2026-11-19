-- 0063_follow_up_data: one model for follow-ups (D39), data half. Needs 0062's columns.
--
--   (a) Each lead with next_follow_up_at gets a planned call "Follow up" due then, assigned to the lead owner
--       (NULL when the lead has none); then the column is set NULL. The column stays for rollback safety but is
--       no longer read or written.
--   (b) Each task activity becomes a call. A completed task stays logged (occurred_at and completed_at kept);
--       an open task is planned, and one without due_at gets due_at = occurred_at, so it shows as overdue
--       rather than vanishing.
--   (c) Any other kind with due_at and no completed_at is planned by the new rule: counted, left as is.
-- The counts before and after are RAISE NOTICEd. Every write is audited as system:migration-0063.
--
-- Runs as bos_owner, in the migrator's one transaction, split at the breakpoint comments (same rule as 0000).

-- set_config(..., true) lasts to the end of the migrator's transaction. bos.tenant_id and bos.organization_id
-- are left unset: leads and activities are entity-owned, so the audit takes both from the row.
SELECT
	set_config('bos.actor_kind', 'system', true),
	set_config('bos.actor_id', 'system:migration-0063', true),
	set_config('bos.correlation_id', 'migration-0063:' || gen_random_uuid()::text, true),
	set_config('bos.ip', '', true),
	set_config('bos.user_agent', '', true);
--> statement-breakpoint

DO $$
DECLARE
	v_lead_follow_ups bigint;
	v_tasks_completed bigint;
	v_tasks_open bigint;
	v_tasks_open_without_due bigint;
	v_other_due_open bigint;
	v_inserted bigint;
	v_converted bigint;
	v_after_lead_follow_ups bigint;
	v_after_tasks bigint;
	v_after_planned bigint;
BEGIN
	-- Every "before" count is taken before (a) inserts calls and (b) converts tasks.
	SELECT count(*) INTO v_lead_follow_ups FROM "app"."leads" WHERE "next_follow_up_at" IS NOT NULL;
	SELECT
		count(*) FILTER (WHERE "completed_at" IS NOT NULL),
		count(*) FILTER (WHERE "completed_at" IS NULL),
		count(*) FILTER (WHERE "completed_at" IS NULL AND "due_at" IS NULL)
	INTO v_tasks_completed, v_tasks_open, v_tasks_open_without_due
	FROM "app"."activities" WHERE "kind" = 'task';
	SELECT count(*) INTO v_other_due_open
	FROM "app"."activities"
	WHERE "kind" <> 'task' AND "due_at" IS NOT NULL AND "completed_at" IS NULL;
	RAISE NOTICE 'migration-0063 before: leads with next_follow_up_at=%, task activities completed=% open=% (open without due_at=%), other kinds with due_at and not completed=% (left as is)',
		v_lead_follow_ups, v_tasks_completed, v_tasks_open, v_tasks_open_without_due, v_other_due_open;

	-- (a)
	INSERT INTO "app"."activities" ("tenant_id", "organization_id", "kind", "subject", "lead_id", "due_at", "assignee_user_id")
	SELECT "tenant_id", "organization_id", 'call', 'Follow up', "id", "next_follow_up_at", "owner_user_id"
	FROM "app"."leads"
	WHERE "next_follow_up_at" IS NOT NULL;
	GET DIAGNOSTICS v_inserted = ROW_COUNT;
	UPDATE "app"."leads" SET "next_follow_up_at" = NULL WHERE "next_follow_up_at" IS NOT NULL;

	-- (b) A completed task keeps its due_at; an open one falls back to occurred_at.
	UPDATE "app"."activities"
	SET
		"kind" = 'call',
		"due_at" = CASE WHEN "completed_at" IS NULL THEN coalesce("due_at", "occurred_at") ELSE "due_at" END
	WHERE "kind" = 'task';
	GET DIAGNOSTICS v_converted = ROW_COUNT;

	SELECT count(*) INTO v_after_lead_follow_ups FROM "app"."leads" WHERE "next_follow_up_at" IS NOT NULL;
	SELECT count(*) INTO v_after_tasks FROM "app"."activities" WHERE "kind" = 'task';
	SELECT count(*) INTO v_after_planned
	FROM "app"."activities"
	WHERE "kind" IN ('call', 'meeting', 'email')
		AND "due_at" IS NOT NULL AND "completed_at" IS NULL AND "cancelled_at" IS NULL;
	RAISE NOTICE 'migration-0063 after: planned calls inserted from leads=%, tasks converted to calls=%, leads with next_follow_up_at=%, task activities=%, planned activities=%',
		v_inserted, v_converted, v_after_lead_follow_ups, v_after_tasks, v_after_planned;
END
$$;
