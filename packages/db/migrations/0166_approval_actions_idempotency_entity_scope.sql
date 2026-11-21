-- 0166_approval_actions_idempotency_entity_scope: an approval action's Idempotency-Key is scoped to the legal entity
-- too (R5 FU6, following FU1's 0165 for app.idempotency_keys).
-- Before this, the unique key was (tenant, actor, key): the same approver, working in two entities of one tenant,
-- who reused one key for two requests hit the first entity's row (a unique violation, a 500) although the requests
-- never meet. The entity joins the key, so each entity has its own namespace.
--
-- Existing rows stay valid: organization_id is already NOT NULL on every row, and a key that was unique without
-- the entity is still unique with it. No row is read or written, so there is no audit actor to set.
--
-- A short lock_timeout: the constraint swap takes an ACCESS EXCLUSIVE lock on approval_actions, which is small, but
-- it must give up (and fail the deploy, which a retry then repeats) instead of queueing behind a long approval
-- transaction and blocking every approval click that queues behind it. SET LOCAL lasts until the migration run's one
-- transaction commits, so it also covers any migration after this one in the same run. Every later data migration should open with the same line.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "app"."approval_actions" DROP CONSTRAINT "approval_actions_idempotency_unique";
--> statement-breakpoint
ALTER TABLE "app"."approval_actions" ADD CONSTRAINT "approval_actions_idempotency_unique" UNIQUE("tenant_id", "organization_id", "actor_user_id", "idempotency_key");
