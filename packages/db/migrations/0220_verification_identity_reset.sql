-- 0220_verification_identity_reset (R6AE, Kuu 2026-11-23): a change of a party's identity (legal name, PAN, country,
-- and a vendor's kind) before approval returns its verification case to draft with an empty checklist. The case
-- records when that happened and who did it, so the party's users read "Details changed on <date> by <name>; upload
-- the documents again", and a file uploaded before that moment cannot be put on the checklist again. Both columns are
-- set together or not at all. Existing cases keep NULL: none was reset. No data is written.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "app"."verification_cases" ADD COLUMN "identity_reset_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "app"."verification_cases" ADD COLUMN "identity_reset_by_user_id" uuid;
--> statement-breakpoint
ALTER TABLE "app"."verification_cases" ADD CONSTRAINT "verification_cases_identity_reset_check" CHECK (("identity_reset_at" IS NULL) = ("identity_reset_by_user_id" IS NULL));
--> statement-breakpoint
ALTER TABLE "app"."verification_cases" ADD CONSTRAINT "verification_cases_identity_reset_user_fk" FOREIGN KEY ("tenant_id", "identity_reset_by_user_id") REFERENCES "app"."users"("tenant_id", "id");
