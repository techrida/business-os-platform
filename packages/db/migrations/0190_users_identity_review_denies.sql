-- 0190_users_identity_review_denies: whatever writes the row, a flagged person is never 'active' (FU8).
-- The sync, the first-request upsert and the lock-expiry job each set 'active' from what they read; for a row with
-- identity_review_required the trigger turns that into 'inactive', so no writer can reopen access that an admin has
-- not resolved. An invited row stays invited (it is refused too).
--
-- Runs as bos_owner, split at the breakpoint comments.

CREATE OR REPLACE FUNCTION "app"."users_identity_review_denies"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
	IF NEW."identity_review_required" AND NEW."status" = 'active' THEN
		NEW."status" := 'inactive';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "app"."users_identity_review_denies"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "users_identity_review_denies" BEFORE INSERT OR UPDATE ON "app"."users"
FOR EACH ROW EXECUTE FUNCTION "app"."users_identity_review_denies"();
