-- 0183_credit_override_quotation_version: a credit override covers exactly one quotation version (R5 FU10, FU4 Q1).
-- 0170 tied an override to the order value it was given for, but a second order on the same deal, or a new version
-- of the quotation, at or below that value still went through on the old override. The deal now also keeps the
-- quotation version the override was given for (opportunities.credit_override_quotation_version_id); the sales
-- order gate and the override action ask for a new override for any other version.
--   * The column is nullable: a deal with no override has none, and an override given before this migration has
--     none and is not backfilled. An override with no version covers nothing (fails closed).
--   * opportunities_credit_override_quotation_version_fk: composite with the entity, as the parent is entity-owned
--     (the same shape as opportunities_won_quotation_version_fk from 0016). Declared in SQL only, so that
--     schema/crm.ts does not import quotations.ts (which imports crm.ts).
--   * opportunities_credit_override_quotation_version_check: a version only ever sits beside an override.
-- Schema only: no row is read or written, so there is no audit actor to set. Runs as bos_owner, split at the
-- breakpoint comments. The short lock_timeout gives up (and fails the deploy) rather than queue behind a long
-- transaction on opportunities while holding the ALTER TABLE lock.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "app"."opportunities" ADD COLUMN "credit_override_quotation_version_id" uuid;
--> statement-breakpoint
ALTER TABLE "app"."opportunities" ADD CONSTRAINT "opportunities_credit_override_quotation_version_fk" FOREIGN KEY ("tenant_id", "organization_id", "credit_override_quotation_version_id") REFERENCES "app"."quotation_versions"("tenant_id", "organization_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."opportunities" ADD CONSTRAINT "opportunities_credit_override_quotation_version_check" CHECK ("credit_override_quotation_version_id" IS NULL OR "credit_override_at" IS NOT NULL);
