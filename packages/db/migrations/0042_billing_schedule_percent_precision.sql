-- Convert basis points (6000 = 60%) to exact percentages. The nullable column stays nullable
-- for lines entered by amount. Existing line amounts and invoice links are untouched.
ALTER TABLE "app"."billing_schedule_lines"
  DROP CONSTRAINT "billing_schedule_lines_percent_bp_check",
  ALTER COLUMN "percent_bp" TYPE numeric(7, 4) USING ("percent_bp"::numeric / 100);
--> statement-breakpoint
ALTER TABLE "app"."billing_schedule_lines" RENAME COLUMN "percent_bp" TO "percent";
--> statement-breakpoint
ALTER TABLE "app"."billing_schedule_lines"
  ADD CONSTRAINT "billing_schedule_lines_percent_check" CHECK ("percent" BETWEEN 0.0001 AND 100);
