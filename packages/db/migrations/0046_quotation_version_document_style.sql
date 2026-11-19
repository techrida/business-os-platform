-- 0046_quotation_version_document_style: the look of a sent quotation is frozen with its version.
--
-- The render job (system:quotation-render) captures the layout, brand colour, company profile and number system
-- from settings the first time it renders an approved version, and stores them here as a DocumentStyleSnapshot
-- (packages/contracts/src/document-style.ts). A later settings change, or a retry after a failed render, then
-- draws the same document.
--   * NULL until the first render of the version. Existing versions stay NULL and take the settings in force
--     at their first render after this migration.
--   * Not a material column (it is not part of the approval hash), so it is not in the freeze list of
--     quotation_versions_guard. A separate trigger enforces its own rule: it can only be set on a version that is
--     no longer draft or returned, and once set it never changes. The gate is OLD.status, as in the main guard.

ALTER TABLE "app"."quotation_versions" ADD COLUMN "document_style" jsonb;
--> statement-breakpoint

ALTER TABLE "app"."quotation_versions" ADD CONSTRAINT "quotation_versions_document_style_check" CHECK ("document_style" IS NULL OR jsonb_typeof("document_style") = 'object');
--> statement-breakpoint

CREATE FUNCTION "app"."quotation_versions_document_style_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NEW."document_style" IS NOT NULL THEN
			RAISE EXCEPTION 'quotation version %: the document style is captured at render, not at creation', NEW."id"
				USING ERRCODE = 'check_violation', CONSTRAINT = 'quotation_versions_document_style_frozen_check';
		END IF;
		RETURN NEW;
	END IF;
	IF OLD."document_style" IS NOT NULL THEN
		IF NEW."document_style" IS DISTINCT FROM OLD."document_style" THEN
			RAISE EXCEPTION 'quotation version %: the document style is frozen once captured', OLD."id"
				USING ERRCODE = 'check_violation', CONSTRAINT = 'quotation_versions_document_style_frozen_check';
		END IF;
	ELSIF NEW."document_style" IS NOT NULL AND OLD."status" IN ('draft', 'returned') THEN
		RAISE EXCEPTION 'quotation version %: the document style is captured only after approval', OLD."id"
			USING ERRCODE = 'check_violation', CONSTRAINT = 'quotation_versions_document_style_frozen_check';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint

REVOKE EXECUTE ON FUNCTION "app"."quotation_versions_document_style_guard"() FROM PUBLIC;
--> statement-breakpoint

CREATE TRIGGER "quotation_versions_document_style_guard" BEFORE INSERT OR UPDATE ON "app"."quotation_versions"
FOR EACH ROW EXECUTE FUNCTION "app"."quotation_versions_document_style_guard"();
