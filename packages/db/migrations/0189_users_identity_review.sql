-- 0189_users_identity_review: a flag that keeps a person out of the app while their ZITADEL state is unsure (FU8).
-- A failed or ambiguous write to ZITADEL (a status action, a role set, an invite, a timeout) closes the row and sets
-- identity_review_required. Sync never clears it and never reopens a flagged row; only an admin resolves it after
-- reading ZITADEL again. No data change: every existing row starts unflagged.
--
-- Runs as bos_owner, split at the breakpoint comments.

ALTER TABLE "app"."users" ADD COLUMN "identity_review_required" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "app"."users" ADD COLUMN "identity_review_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX "users_identity_review_idx" ON "app"."users" ("tenant_id") WHERE "identity_review_required";
