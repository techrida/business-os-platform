-- 0047_quotation_terms_conditions: a free-text "Terms and conditions" block on a quotation version.
--
-- The quotation PDF prints a Terms and conditions section next to Exclusions, and the quote form offers the saved
-- term presets (kind terms_conditions) for it. The text lives on the version, like scope, assumptions and exclusions.
--   * Nullable text, no default: every existing version stays NULL, so nothing already approved changes. The content
--     hash omits the key while it is NULL (quotation-approval-snapshot.ts), so existing content_sha256 values still verify.
--   * A material column: frozen once the version leaves draft or returned. The freeze trigger quotation_versions_guard
--     is replaced below with the 0016 body plus one comparison; the trigger itself (0016) is unchanged and keeps
--     pointing at the function by name. 0046's separate document_style guard is not touched.

ALTER TABLE "app"."quotation_versions" ADD COLUMN "terms_and_conditions" text;
--> statement-breakpoint

-- Same body as 0016 quotation_versions_guard with the terms_and_conditions comparison added to the frozen list.
-- The comparison lists are pinned to src/schema/quotations.ts by quotations-schema.test.ts.
CREATE OR REPLACE FUNCTION "app"."quotation_versions_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NEW."status" <> 'draft' THEN
			RAISE EXCEPTION 'quotation version % must be created as draft, not %', NEW."id", NEW."status"
				USING ERRCODE = 'check_violation', CONSTRAINT = 'quotation_versions_insert_draft_check';
		END IF;
		RETURN NEW;
	END IF;
	IF TG_OP = 'DELETE' THEN
		IF OLD."status" NOT IN ('draft', 'returned') THEN
			RAISE EXCEPTION 'quotation version % is % and cannot be deleted', OLD."id", OLD."status"
				USING ERRCODE = 'check_violation', CONSTRAINT = 'quotation_versions_frozen_check';
		END IF;
		RETURN OLD;
	END IF;
	-- identity: never changes, whatever the status.
	IF OLD."id" IS DISTINCT FROM NEW."id"
		OR OLD."tenant_id" IS DISTINCT FROM NEW."tenant_id"
		OR OLD."organization_id" IS DISTINCT FROM NEW."organization_id"
		OR OLD."quotation_id" IS DISTINCT FROM NEW."quotation_id"
		OR OLD."revision_no" IS DISTINCT FROM NEW."revision_no"
		OR OLD."supersedes_version_id" IS DISTINCT FROM NEW."supersedes_version_id"
		OR OLD."created_at" IS DISTINCT FROM NEW."created_at" THEN
		RAISE EXCEPTION 'quotation version %: identity columns cannot change', OLD."id"
			USING ERRCODE = 'check_violation', CONSTRAINT = 'quotation_versions_identity_check';
	END IF;
	-- transitions: draft is only ever the first status, submitted is reached only from draft or returned, and
	-- returned only from submitted, so a frozen version cannot be made editable again (not even in two hops).
	IF NEW."status" IS DISTINCT FROM OLD."status"
		AND (NEW."status" = 'draft'
			OR (NEW."status" = 'submitted' AND OLD."status" NOT IN ('draft', 'returned'))
			OR (NEW."status" = 'returned' AND OLD."status" <> 'submitted')) THEN
		RAISE EXCEPTION 'quotation version %: % -> % is not a transition', OLD."id", OLD."status", NEW."status"
			USING ERRCODE = 'check_violation', CONSTRAINT = 'quotation_versions_transition_check';
	END IF;
	IF OLD."status" IN ('draft', 'returned') THEN
		RETURN NEW;
	END IF;
	-- frozen: the material columns.
	IF OLD."contact_id" IS DISTINCT FROM NEW."contact_id"
		OR OLD."template_id" IS DISTINCT FROM NEW."template_id"
		OR OLD."currency" IS DISTINCT FROM NEW."currency"
		OR OLD."issue_date" IS DISTINCT FROM NEW."issue_date"
		OR OLD."valid_until" IS DISTINCT FROM NEW."valid_until"
		OR OLD."scope" IS DISTINCT FROM NEW."scope"
		OR OLD."assumptions" IS DISTINCT FROM NEW."assumptions"
		OR OLD."exclusions" IS DISTINCT FROM NEW."exclusions"
		OR OLD."terms_and_conditions" IS DISTINCT FROM NEW."terms_and_conditions"
		OR OLD."delivery_timeline" IS DISTINCT FROM NEW."delivery_timeline"
		OR OLD."payment_term_id" IS DISTINCT FROM NEW."payment_term_id"
		OR OLD."payment_schedule" IS DISTINCT FROM NEW."payment_schedule"
		OR OLD."discount_mode" IS DISTINCT FROM NEW."discount_mode"
		OR OLD."discount_input" IS DISTINCT FROM NEW."discount_input"
		OR OLD."subtotal" IS DISTINCT FROM NEW."subtotal"
		OR OLD."discount_amount" IS DISTINCT FROM NEW."discount_amount"
		OR OLD."taxable_amount" IS DISTINCT FROM NEW."taxable_amount"
		OR OLD."tax_amount" IS DISTINCT FROM NEW."tax_amount"
		OR OLD."total" IS DISTINCT FROM NEW."total"
		OR OLD."effective_discount_pct" IS DISTINCT FROM NEW."effective_discount_pct"
		OR OLD."fx_rate" IS DISTINCT FROM NEW."fx_rate"
		OR OLD."fx_source" IS DISTINCT FROM NEW."fx_source"
		OR OLD."fx_date" IS DISTINCT FROM NEW."fx_date"
		OR OLD."amount_npr" IS DISTINCT FROM NEW."amount_npr"
		OR OLD."npr_taxable_amount" IS DISTINCT FROM NEW."npr_taxable_amount"
		OR OLD."internal_cost_total" IS DISTINCT FROM NEW."internal_cost_total"
		OR OLD."margin_pct" IS DISTINCT FROM NEW."margin_pct"
		OR OLD."calc_version" IS DISTINCT FROM NEW."calc_version"
		OR OLD."content_sha256" IS DISTINCT FROM NEW."content_sha256"
		OR OLD."snapshot_sha256" IS DISTINCT FROM NEW."snapshot_sha256"
		OR OLD."revision_reason" IS DISTINCT FROM NEW."revision_reason" THEN
		RAISE EXCEPTION 'quotation version % is % and its content is frozen; revise it instead', OLD."id", OLD."status"
			USING ERRCODE = 'check_violation', CONSTRAINT = 'quotation_versions_frozen_check';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "app"."quotation_versions_guard"() FROM PUBLIC;
