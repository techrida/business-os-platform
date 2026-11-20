-- 0101_opportunity_lead_creator: an opportunity remembers who entered the lead it was converted from (FX-Q1,
-- U20a2-Q5). Finance, Accountant and PMO enter leads for a Sales owner (D50) and read them through creator reach;
-- with this column the same reach covers the opportunity the lead became, so they can open it and draft its
-- quotations. Set by the convert action from leads.created_by_user_id; NULL for an opportunity with no lead, or
-- whose lead has no known creator. Existing converted rows are filled by 0102.
-- Schema only, additive. Runs as bos_owner, split at the breakpoint comments.

ALTER TABLE "app"."opportunities" ADD COLUMN "lead_creator_user_id" uuid;
--> statement-breakpoint
ALTER TABLE "app"."opportunities" ADD CONSTRAINT "opportunities_lead_creator_user_fk" FOREIGN KEY ("tenant_id", "lead_creator_user_id") REFERENCES "app"."users"("tenant_id", "id");
--> statement-breakpoint
CREATE INDEX "opportunities_tenant_lead_creator_idx" ON "app"."opportunities" USING btree ("tenant_id", "organization_id", "lead_creator_user_id");
