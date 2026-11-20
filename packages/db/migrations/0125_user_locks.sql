-- 0125_user_locks: a timed lock after failed sign-ins and an admin lock (F1-Q4, F1-Q5), schema only.
-- ZITADEL decides whether a person can sign in and locks them after too many wrong passwords or codes; app.users
-- mirrors it. These columns record why the person is locked and until when:
--   lock_reason 'failed_sign_ins': ZITADEL's lockout policy locked them. locked_until is when the app's lock-expiry
--     job unlocks them again (the window is the same for every deployment). An admin may unlock earlier.
--   lock_reason 'admin': an admin locked them in Settings > Users. No expiry; only an admin unlocks.
--   lock_reason NULL: not locked. A locked person's status is 'inactive' (ZITADEL's LOCKED state), and the app
--     clears these columns whenever the status leaves 'inactive'.
-- No data change: every existing row starts unlocked.
--
-- Runs as bos_owner, split at the breakpoint comments.

ALTER TABLE "app"."users" ADD COLUMN "lock_reason" text;
--> statement-breakpoint
ALTER TABLE "app"."users" ADD COLUMN "locked_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "app"."users" ADD COLUMN "locked_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "app"."users" ADD CONSTRAINT "users_lock_reason_check" CHECK ("lock_reason" IN ('failed_sign_ins', 'admin'));
--> statement-breakpoint
ALTER TABLE "app"."users" ADD CONSTRAINT "users_lock_shape_check" CHECK (
  ("lock_reason" IS NULL AND "locked_at" IS NULL AND "locked_until" IS NULL)
  OR ("lock_reason" = 'admin' AND "locked_at" IS NOT NULL AND "locked_until" IS NULL)
  OR ("lock_reason" = 'failed_sign_ins' AND "locked_at" IS NOT NULL AND "locked_until" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX "users_lock_expiry_idx" ON "app"."users" ("locked_until") WHERE "lock_reason" = 'failed_sign_ins';
