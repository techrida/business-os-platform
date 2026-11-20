-- 0103_opportunity_credit_override: the override of a deal's credit hold (F1-Q20, F1-Q26). A deal whose customer owes
-- the acting entity more than its credit limit (party_accounts.credit_limit, NPR) is on credit hold: its accepted
-- quotation cannot become a sales order until someone holding `credit.override` (Management, Finance) overrides the
-- hold with a reason. The hold itself is derived from the ledger on every read, never stored; only the override is.
-- Who, when and why are kept on the deal and in the audit trail. All three are set together or not at all.
-- Schema only, additive. Runs as bos_owner, split at the breakpoint comments.

ALTER TABLE "app"."opportunities" ADD COLUMN "credit_override_reason" text;
--> statement-breakpoint
ALTER TABLE "app"."opportunities" ADD COLUMN "credit_override_by_user_id" uuid;
--> statement-breakpoint
ALTER TABLE "app"."opportunities" ADD COLUMN "credit_override_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "app"."opportunities" ADD CONSTRAINT "opportunities_credit_override_by_user_fk" FOREIGN KEY ("tenant_id", "credit_override_by_user_id") REFERENCES "app"."users"("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."opportunities" ADD CONSTRAINT "opportunities_credit_override_check" CHECK (("credit_override_reason" IS NULL AND "credit_override_by_user_id" IS NULL AND "credit_override_at" IS NULL) OR ("credit_override_reason" IS NOT NULL AND length(btrim("credit_override_reason")) > 0 AND "credit_override_by_user_id" IS NOT NULL AND "credit_override_at" IS NOT NULL));
