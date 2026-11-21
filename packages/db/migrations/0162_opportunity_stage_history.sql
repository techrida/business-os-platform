-- 0162_opportunity_stage_history: every opportunity stage change, with who made it and when (round 5, P5 item 2,
-- R4a Q13).
--
-- * One row per change, written by the API in the same transaction as the stage update (applyStageChange in
--   opportunity-stage.ts), so a change that rolls back leaves no row.
-- * actor_kind is the transaction actor's kind (bos.actor_kind). A user's move, or a system move a user set off (a
--   quotation sent or accepted), records that user in actor_user_id. A move with no user behind it (a job) records
--   actor_kind 'system' and no user.
-- * created_at is the transaction time, so two moves in one transaction share it; seq orders them.
-- * Append-only: bos_app may insert and select only, and a trigger refuses UPDATE and DELETE for every role.
-- * No backfill: history starts with this migration. DDL only, so no audit actor is needed. No GRANT: 0008's default
--   privileges cover new tables, and the REVOKE below narrows them.

CREATE TABLE "app"."opportunity_stage_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"from_stage" text NOT NULL,
	"to_stage" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
	CONSTRAINT "opportunity_stage_history_tenant_id_unique" UNIQUE("tenant_id", "id"),
	CONSTRAINT "opportunity_stage_history_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "opportunity_stage_history_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "opportunity_stage_history_opportunity_fk" FOREIGN KEY ("tenant_id", "organization_id", "opportunity_id") REFERENCES "app"."opportunities"("tenant_id", "organization_id", "id"),
	CONSTRAINT "opportunity_stage_history_actor_user_fk" FOREIGN KEY ("tenant_id", "actor_user_id") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "opportunity_stage_history_from_stage_check" CHECK ("from_stage" in ('qualified', 'requirement_received', 'proposal_sent', 'quotation_sent', 'negotiation', 'won', 'lost', 'on_hold')),
	CONSTRAINT "opportunity_stage_history_to_stage_check" CHECK ("to_stage" in ('qualified', 'requirement_received', 'proposal_sent', 'quotation_sent', 'negotiation', 'won', 'lost', 'on_hold')),
	CONSTRAINT "opportunity_stage_history_change_check" CHECK ("from_stage" <> "to_stage"),
	CONSTRAINT "opportunity_stage_history_actor_check" CHECK ("actor_kind" in ('user', 'system', 'seed', 'zitadel') AND ("actor_kind" = 'user') = ("actor_user_id" IS NOT NULL))
);
--> statement-breakpoint

CREATE INDEX "opportunity_stage_history_opportunity_idx" ON "app"."opportunity_stage_history" ("tenant_id", "opportunity_id", "created_at", "seq");
--> statement-breakpoint

CREATE FUNCTION "app"."opportunity_stage_history_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Opportunity stage history is append-only'; END $$;
--> statement-breakpoint

CREATE TRIGGER "opportunity_stage_history_append_only" BEFORE UPDATE OR DELETE ON "app"."opportunity_stage_history"
FOR EACH ROW EXECUTE FUNCTION "app"."opportunity_stage_history_immutable"();
--> statement-breakpoint

REVOKE UPDATE, DELETE ON "app"."opportunity_stage_history" FROM "bos_app";
--> statement-breakpoint

SELECT audit.attach('app.opportunity_stage_history');
