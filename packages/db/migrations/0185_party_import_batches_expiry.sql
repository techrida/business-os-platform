-- 0185_party_import_batches_expiry: a previewed CSV import that nobody committed expires after 7 days (round 5, FU11;
-- Kuu decision K1 Q5 b). The preview holds the uploaded names, addresses, emails and phones, so it must not wait forever.
--   * status gains `expired`: the daily worker job moves a `previewed` batch there once it is older than 7 days, and
--     clears its `rows` to an empty array, so the uploaded personal data goes with it. The counts and the file name stay,
--     as the record of the attempt. A batch's `rows` is only checked against `row_count` while it is not expired.
--   * an expired batch is final, like a committed one: the guard trigger refuses any UPDATE of it, and DELETE of any batch
--     stays refused. A committed batch is never touched by the job.
-- DDL only: no rows are written, so no audit actor is needed. The table is small and the statements are short; a lock_timeout
-- makes the migration fail fast instead of queueing behind a long transaction.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "app"."party_import_batches" DROP CONSTRAINT "party_import_batches_status_check";
--> statement-breakpoint
ALTER TABLE "app"."party_import_batches" ADD CONSTRAINT "party_import_batches_status_check" CHECK ("status" in ('previewed', 'committed', 'expired'));
--> statement-breakpoint
ALTER TABLE "app"."party_import_batches" DROP CONSTRAINT "party_import_batches_rows_check";
--> statement-breakpoint
ALTER TABLE "app"."party_import_batches" ADD CONSTRAINT "party_import_batches_rows_check" CHECK (jsonb_typeof("rows") = 'array' AND ("status" = 'expired' OR jsonb_array_length("rows") = "row_count"));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "app"."party_import_batches_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'party_import_batches: an import record is never deleted'
			USING ERRCODE = 'check_violation', CONSTRAINT = 'party_import_batches_final';
	END IF;
	IF OLD.status IN ('committed', 'expired') THEN
		RAISE EXCEPTION 'party_import_batches: a committed or expired import is final'
			USING ERRCODE = 'check_violation', CONSTRAINT = 'party_import_batches_final';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE INDEX "party_import_batches_previewed_created_idx" ON "app"."party_import_batches" USING btree ("created_at") WHERE "status" = 'previewed';
