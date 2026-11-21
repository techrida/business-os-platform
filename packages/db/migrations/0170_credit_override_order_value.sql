-- 0170_credit_override_order_value: a credit override is tied to the order value it was given for (R5 FU4).
-- Until now an override on a deal let every later order of that deal through: one given for a 20,000 order still
-- passed a 500,000 one. The deal now keeps the gross NPR value of the order the override was given against
-- (opportunities.credit_override_order_value); the sales order gate and the override action ask for a new override
-- when the order to confirm is worth more than that.
--   * The column is nullable: a deal with no override has none, and an override given before this migration has
--     none until 0171 fills it from the audit trail. An override with no value covers nothing (fails closed).
--   * opportunities_credit_override_value_check: a value only ever sits beside an override, and is never negative.
-- Schema only. Runs as bos_owner, split at the breakpoint comments.

ALTER TABLE "app"."opportunities" ADD COLUMN "credit_override_order_value" numeric(18, 2);
--> statement-breakpoint
ALTER TABLE "app"."opportunities" ADD CONSTRAINT "opportunities_credit_override_value_check" CHECK ("credit_override_order_value" IS NULL OR ("credit_override_at" IS NOT NULL AND "credit_override_order_value" >= 0));
