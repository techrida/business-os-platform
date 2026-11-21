-- 0165_idempotency_keys_entity_scope: an Idempotency-Key is scoped to the acting legal entity too (FU1).
-- Before this, the unique key was (tenant, actor, command, key): a retry sent from another entity of the same
-- tenant, with the same actor, command and key, found the first entity's row and replayed its cached answer
-- (or got a 422 for a different body). The entity joins the key, so each entity has its own namespace.
--
-- Existing rows stay valid: organization_id is already NOT NULL on every row, and a key that was unique without
-- the entity is still unique with it. The lookup index is replaced in one step, so no window has no index.

ALTER TABLE "app"."idempotency_keys" DROP CONSTRAINT "idempotency_keys_unique";
--> statement-breakpoint
ALTER TABLE "app"."idempotency_keys" ADD CONSTRAINT "idempotency_keys_unique" UNIQUE("tenant_id", "organization_id", "actor_id", "command", "key");
