-- 0062_activity_follow_ups: one model for follow-ups (D39), schema half. 0063 moves the data.
--
-- A follow-up is an activities row of kind call, meeting or email with due_at set and completed_at and
-- cancelled_at NULL ("planned"); everything else is "logged". planned is derived, never stored.
--   * cancelled_at: a planned activity that was called off. Cancelled rows never list.
--   * created_by_user_id: the staff user who wrote the row (NULL for system and migrated rows). A tenant-level
--     FK into users, like activities_assignee_user_fk.
--   * activities_tenant_org_lead_planned_idx: the planned rows of a lead, earliest first (the lead's follow-ups
--     card and LeadDto.nextFollowUpAt).
-- Additive only; activities is already audited (0015).

ALTER TABLE "app"."activities" ADD COLUMN "cancelled_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "app"."activities" ADD COLUMN "created_by_user_id" uuid;
--> statement-breakpoint
ALTER TABLE "app"."activities" ADD CONSTRAINT "activities_created_by_user_fk" FOREIGN KEY ("tenant_id", "created_by_user_id") REFERENCES "app"."users"("tenant_id", "id");
--> statement-breakpoint
CREATE INDEX "activities_tenant_org_lead_planned_idx" ON "app"."activities" USING btree ("tenant_id", "organization_id", "lead_id", "due_at") WHERE "due_at" IS NOT NULL AND "completed_at" IS NULL AND "cancelled_at" IS NULL;
