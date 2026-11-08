-- 0012_idempotency_keys: one table for "the same command with the same key runs once" (D34, M22).
-- Owner: N4. Serves the NFR "no double effects": a retried request replays the stored answer instead of
-- running again, and the same key with a different body is refused (HTTP 422 in the API).
--
-- Runs as bos_owner, in one transaction, split at the breakpoint comments (same rule as 0000).
--
-- How the API uses it (apps/api/src/platform/db/idempotency.ts): the first call INSERTs a claim row with
-- status NULL inside the caller's transaction, runs the command, then sets status and response. A second
-- call with the same key blocks on the unique index until the first transaction ends, so two simultaneous
-- first calls can never both run the command. If the first one rolls back, its claim vanishes with it and
-- the second one runs.
--
-- actor_id is text, not uuid: it holds bos.actor_id, which is a user uuid for people and "system:<job>" for
-- background jobs. approval_actions predates this table and keeps its own columns; approvals moves over later.
-- The audit trail redacts "response": it can hold business data that the audited tables already record.

CREATE TABLE "app"."idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"command" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" bytea NOT NULL,
	-- NULL while the first call is still running; the HTTP status of the stored answer once it has finished.
	"status" integer,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_unique" UNIQUE("tenant_id", "actor_id", "command", "key"),
	CONSTRAINT "idempotency_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "idempotency_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id"),
	CONSTRAINT "idempotency_keys_sha256_check" CHECK (octet_length("request_hash") = 32),
	CONSTRAINT "idempotency_keys_status_check" CHECK ("status" IS NULL OR "status" BETWEEN 100 AND 599)
);
--> statement-breakpoint

SELECT audit.attach('app.idempotency_keys', '{response}');
