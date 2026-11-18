-- 0039_discard_memo_drafts: a creator can discard an unsubmitted memo (status draft or returned) without
-- deleting anything. The row keeps its number (the MEMO series stays gap-free on the books), its audit trail,
-- its approval history and its attachment evidence; the API stops showing it, editing it, submitting it and
-- serving its files. Discarding is final: no restore path exists, so a discarded memo cannot change again.
--
-- A nullable timestamp, not a new status value: the status vocabulary (and MEMO_STATUSES in @bos/contracts)
-- stays as it is, and the memo keeps the status it was discarded in.
--
-- Numbering: 0039 is the next free number across p1..p4-main (p4-main ends at 0038_discard_procurement_drafts,
-- the customer-document-review branches use 0040), and the journal `when` follows it, so the cascade keeps the
-- order whatever phase merges first.
ALTER TABLE "app"."test_memos" ADD COLUMN "discarded_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "app"."test_memos" ADD COLUMN "discarded_by_user_id" uuid;
--> statement-breakpoint
-- Both or neither: a discard always names who did it.
ALTER TABLE "app"."test_memos" ADD CONSTRAINT "test_memos_discarded_pair_check" CHECK (("discarded_at" IS NULL) = ("discarded_by_user_id" IS NULL));
--> statement-breakpoint
-- Only unsubmitted memos: a submitted, approved or rejected memo is evidence of a decision and stays.
ALTER TABLE "app"."test_memos" ADD CONSTRAINT "test_memos_discarded_status_check" CHECK ("discarded_at" IS NULL OR "status" IN ('draft', 'returned'));
--> statement-breakpoint
-- Creator only: the person who discards is the memo's owner (owner_user_id never changes).
ALTER TABLE "app"."test_memos" ADD CONSTRAINT "test_memos_discarded_by_owner_check" CHECK ("discarded_by_user_id" IS NULL OR "discarded_by_user_id" = "owner_user_id");
--> statement-breakpoint
-- MATCH SIMPLE: not checked while discarded_by_user_id is NULL.
ALTER TABLE "app"."test_memos" ADD CONSTRAINT "test_memos_discarded_by_fk" FOREIGN KEY ("tenant_id", "discarded_by_user_id") REFERENCES "app"."users"("tenant_id", "id");
--> statement-breakpoint

-- Backstop for "discarding is final": a service bug or hand-written UPDATE cannot edit, submit or un-discard a
-- discarded memo. BEFORE UPDATE only, so the audit trigger (AFTER ... FOR EACH ROW) still records the discard.
-- Not SECURITY DEFINER; it reads only the row being changed.
CREATE FUNCTION "app"."test_memos_discarded_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
	IF OLD."discarded_at" IS NOT NULL THEN
		RAISE EXCEPTION 'test_memos: memo % is discarded and cannot change', OLD."id"
			USING ERRCODE = 'check_violation', CONSTRAINT = 'test_memos_discarded_final_check';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint

REVOKE EXECUTE ON FUNCTION "app"."test_memos_discarded_guard"() FROM PUBLIC;
--> statement-breakpoint

CREATE TRIGGER "test_memos_discarded_guard" BEFORE UPDATE ON "app"."test_memos"
FOR EACH ROW EXECUTE FUNCTION "app"."test_memos_discarded_guard"();
