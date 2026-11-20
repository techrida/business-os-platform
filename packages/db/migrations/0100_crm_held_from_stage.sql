-- 0100_crm_held_from_stage: a lead or opportunity put On hold remembers the stage it was held at (F1-Q53), so
-- resuming returns it there instead of to a fixed stage (Contacted for a lead, Negotiation for an opportunity).
-- Set by the API in the same update that moves the row to on_hold, cleared by the update that moves it out. A row
-- that went on hold before this migration keeps NULL and resumes to the old fixed stage.
-- Schema only, additive. Runs as bos_owner, split at the breakpoint comments.

ALTER TABLE "app"."leads" ADD COLUMN "held_from_stage" text;
--> statement-breakpoint
ALTER TABLE "app"."leads" ADD CONSTRAINT "leads_held_from_stage_check" CHECK ("held_from_stage" IS NULL OR ("stage" = 'on_hold' AND "held_from_stage" in ('new', 'contacted', 'qualified')));
--> statement-breakpoint
ALTER TABLE "app"."opportunities" ADD COLUMN "held_from_stage" text;
--> statement-breakpoint
ALTER TABLE "app"."opportunities" ADD CONSTRAINT "opportunities_held_from_stage_check" CHECK ("held_from_stage" IS NULL OR ("stage" = 'on_hold' AND "held_from_stage" in ('qualified', 'requirement_received', 'proposal_sent', 'quotation_sent', 'negotiation')));
