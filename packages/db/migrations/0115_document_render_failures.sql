-- 0115_document_render_failures: a PDF render that keeps failing stops after a bounded number of tries, and the screen
-- says so (round 4, R4c2: TR-Q4 and F1-Q13, decision D56).
--
-- Until now a failed render was retried every five minutes for ever, so a document that could never render showed
-- "Being prepared" for ever and nobody was told. The render sweepers now retry in the background with a growing pause
-- and, after the last try, mark the render as given up and write an admin (audit) entry; staff can then ask for a
-- fresh round with Retry. The policy (how many tries, how long between them) lives in one place in the API
-- (render-retry.ts); the database only holds the state.
--
-- * quotation_versions.render_attempts: how many renders of this version failed since its last success or Retry. It
--   extends the version's existing render_state: `failed` with fewer attempts than the limit is waiting for its next
--   try; `failed` at the limit is given up. Not material (not in the approval hash), so it stays updatable after
--   submit like render_state. Existing rows start at 0, so a version that failed before this migration gets the full
--   set of tries.
-- * document_render_failures: the same state for invoices and purchase-order versions. Their rows are immutable and
--   have no render_state to extend; their render state lives in `documents` (a live document means rendered or being
--   rendered), and the failure backoff was kept in each worker's memory, lost on restart and invisible to the
--   screens. One row per owner (owner_type + owner_id, as in `documents`) that has failed since its last success;
--   the sweeper deletes it when a render succeeds and the Retry route deletes it to start again. `next_attempt_at` is
--   when the sweeper may try again; once the tries are used up it is NULL and `exhausted_at` is set.
-- DDL only: no rows are written, so no audit actor is needed.

ALTER TABLE "app"."quotation_versions" ADD COLUMN "render_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint

ALTER TABLE "app"."quotation_versions" ADD CONSTRAINT "quotation_versions_render_attempts_check" CHECK ("render_attempts" >= 0);
--> statement-breakpoint

CREATE TABLE "app"."document_render_failures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"attempts" integer NOT NULL,
	"last_failure_kind" text NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"exhausted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_render_failures_tenant_id_unique" UNIQUE("tenant_id", "id"),
	CONSTRAINT "document_render_failures_owner_unique" UNIQUE("tenant_id", "organization_id", "owner_type", "owner_id"),
	CONSTRAINT "document_render_failures_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "document_render_failures_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "document_render_failures_owner_type_check" CHECK ("owner_type" IN ('invoice', 'purchase_order_version')),
	CONSTRAINT "document_render_failures_attempts_check" CHECK ("attempts" >= 1),
	CONSTRAINT "document_render_failures_kind_check" CHECK ("last_failure_kind" ~ '^[a-z0-9_]{1,64}$'),
	CONSTRAINT "document_render_failures_state_check" CHECK (("exhausted_at" IS NULL) <> ("next_attempt_at" IS NULL))
);
--> statement-breakpoint

-- The sweepers look for owners that may be tried now or that were given up.
CREATE INDEX "document_render_failures_due_idx" ON "app"."document_render_failures" USING btree ("owner_type", "next_attempt_at");
--> statement-breakpoint

SELECT audit.attach('app.document_render_failures');
