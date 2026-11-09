-- 0023_invoice_credit_release: the credit-release marker (P3 plan unit U12 part A).
--
-- A tax invoice that a credit note has cancelled in full must give its billing schedule line back, so the line can be
-- invoiced again (G4 allows one live tax invoice per schedule line). The invoice itself stays issued and immutable
-- (G3); what changes is one fact about it, written once when the credit notes reach its total:
--   * invoices.credited_in_full_at, timestamptz, NULL until then. The service sets it; the database holds the rules:
--       - G3 (invoices_guard, recreated below) lets an issued invoice change in exactly one way: credited_in_full_at
--         goes from NULL to a value, once, with every other column unchanged (version and updated_at may move, as for
--         any issued invoice). A later change of it, even back to NULL, or any other change, even together with it,
--         is still refused (invoices_issued_immutable_check). The marker exists only on an issued invoice: setting it
--         on any other status, or inserting a row with it, is refused (invoices_credit_marker_check), so a live draft
--         can never free a schedule line by itself.
--       - G4: the one-live-tax-invoice index (0021) skips a marked invoice, so the freed line takes a new tax invoice.
--         Not deferrable (a partial unique index cannot be), as before.
-- audit stays attached to invoices (0021): CREATE OR REPLACE keeps the trigger, and audit.capture_row reads the whole
-- row, so the new column is in the hash chain with no further change. Runs as bos_owner, split at the breakpoints.
-- Names follow the K1-U2 convention, mirrored in src/schema/invoicing.ts.

ALTER TABLE "app"."invoices" ADD COLUMN "credited_in_full_at" timestamp with time zone;
--> statement-breakpoint

DROP INDEX "app"."invoices_one_live_tax_invoice_per_schedule_line";
--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_one_live_tax_invoice_per_schedule_line" ON "app"."invoices" USING btree ("tenant_id", "organization_id", "schedule_line_id") WHERE "kind" = 'tax_invoice' AND "status" <> 'discarded' AND "schedule_line_id" IS NOT NULL AND "credited_in_full_at" IS NULL;
--> statement-breakpoint

-- Same function as 0021 with the one allowed change. v_marking is true only for NULL -> value; then the marker leaves
-- the whole-row comparison, which still compares everything else (status included), so the marker cannot ride along
-- with any other change. For every other update the marker is compared like any column.
CREATE OR REPLACE FUNCTION "app"."invoices_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
	v_ignored CONSTANT text[] := ARRAY['version', 'updated_at', 'customer_party_kind'];
	v_marking boolean;
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NEW."status" <> 'draft' THEN
			RAISE EXCEPTION 'invoice % must be created as draft, not %', NEW."id", NEW."status"
				USING ERRCODE = 'check_violation', CONSTRAINT = 'invoices_insert_draft_check';
		END IF;
		IF NEW."credited_in_full_at" IS NOT NULL THEN
			RAISE EXCEPTION 'invoice %: credited_in_full_at is set only on an issued invoice', NEW."id"
				USING ERRCODE = 'check_violation', CONSTRAINT = 'invoices_credit_marker_check';
		END IF;
		RETURN NEW;
	END IF;
	IF TG_OP = 'DELETE' THEN
		IF OLD."status" <> 'draft' THEN
			RAISE EXCEPTION 'invoice % is % and cannot be deleted', OLD."id", OLD."status"
				USING ERRCODE = 'check_violation', CONSTRAINT = 'invoices_frozen_check';
		END IF;
		RETURN OLD;
	END IF;
	IF OLD."id" IS DISTINCT FROM NEW."id"
		OR OLD."tenant_id" IS DISTINCT FROM NEW."tenant_id"
		OR OLD."organization_id" IS DISTINCT FROM NEW."organization_id"
		OR OLD."kind" IS DISTINCT FROM NEW."kind"
		OR OLD."created_at" IS DISTINCT FROM NEW."created_at" THEN
		RAISE EXCEPTION 'invoice %: identity columns cannot change', OLD."id"
			USING ERRCODE = 'check_violation', CONSTRAINT = 'invoices_identity_check';
	END IF;
	v_marking := OLD."credited_in_full_at" IS NULL AND NEW."credited_in_full_at" IS NOT NULL;
	IF v_marking AND OLD."status" <> 'issued' THEN
		RAISE EXCEPTION 'invoice % is %: credited_in_full_at is set only on an issued invoice', OLD."id", OLD."status"
			USING ERRCODE = 'check_violation', CONSTRAINT = 'invoices_credit_marker_check';
	END IF;
	IF OLD."status" = 'issued' AND (
		to_jsonb(NEW) - CASE WHEN v_marking THEN v_ignored || 'credited_in_full_at'::text ELSE v_ignored END
	) IS DISTINCT FROM (
		to_jsonb(OLD) - CASE WHEN v_marking THEN v_ignored || 'credited_in_full_at'::text ELSE v_ignored END
	) THEN
		RAISE EXCEPTION 'invoice % is issued and immutable; correct it with a credit or debit note', OLD."id"
			USING ERRCODE = 'check_violation', CONSTRAINT = 'invoices_issued_immutable_check';
	END IF;
	IF OLD."status" = 'discarded' AND NEW."status" <> 'discarded' THEN
		RAISE EXCEPTION 'invoice % is discarded', OLD."id"
			USING ERRCODE = 'check_violation', CONSTRAINT = 'invoices_frozen_check';
	END IF;
	RETURN NEW;
END;
$$;
