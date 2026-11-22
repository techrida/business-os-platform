-- 0194_drop_owner_phone_e164: the single phone columns go; the phone tables of 0192 hold every number (FX9).
--   * customer_contacts.phone_e164, vendor_contacts.phone_e164 and leads.phone_e164 are dropped with their E.164
--     checks and their (tenant_id, phone_e164) indexes, and 0060's leads_phone_e164_trgm_idx. Lookups by number use
--     <owner>_phones (tenant_id, e164); the lead list search uses leads.phones_search.
--   * vendor_contacts had no phone index (0032).
-- Schema only: no row is read or written, so there is no audit actor to set. 0193 must have copied the numbers first
-- (the journal order guarantees it). The short lock_timeout gives up (and fails the deploy) rather than queue behind
-- a long transaction while holding the ALTER TABLE locks. Runs as bos_owner, split at the breakpoint comments.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "app"."customer_contacts_tenant_phone_e164_idx";
--> statement-breakpoint
ALTER TABLE "app"."customer_contacts" DROP CONSTRAINT "customer_contacts_phone_e164_check";
--> statement-breakpoint
ALTER TABLE "app"."customer_contacts" DROP COLUMN "phone_e164";
--> statement-breakpoint
ALTER TABLE "app"."vendor_contacts" DROP CONSTRAINT "vendor_contacts_phone_e164_check";
--> statement-breakpoint
ALTER TABLE "app"."vendor_contacts" DROP COLUMN "phone_e164";
--> statement-breakpoint
DROP INDEX IF EXISTS "app"."leads_tenant_phone_e164_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "app"."leads_phone_e164_trgm_idx";
--> statement-breakpoint
ALTER TABLE "app"."leads" DROP CONSTRAINT "leads_phone_e164_check";
--> statement-breakpoint
ALTER TABLE "app"."leads" DROP COLUMN "phone_e164";
--> statement-breakpoint
RESET lock_timeout;
