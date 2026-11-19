-- 0090_opportunity_lost_reason: opportunities marked Lost use the tenant's lost-reason list (D49, D54-3), schema half.
-- An opportunity stores a reference to an option of app.lead_lost_reasons (opportunities.lost_reason_id), never the
-- words. The FK is (tenant_id, lost_reason_id), so an opportunity can only name an option of its own tenant.
-- Data half: 0091.
--
-- Runs as bos_owner, split at the breakpoint comments.

ALTER TABLE "app"."opportunities" ADD COLUMN "lost_reason_id" uuid;
--> statement-breakpoint
ALTER TABLE "app"."opportunities" ADD CONSTRAINT "opportunities_lost_reason_fk" FOREIGN KEY ("tenant_id", "lost_reason_id") REFERENCES "app"."lead_lost_reasons"("tenant_id", "id");
