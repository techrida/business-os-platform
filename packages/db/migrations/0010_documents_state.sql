-- 0010_documents_state: a document version keeps its identity and only moves along known statuses. Owner: FIX-E.
--
-- 0004 froze a CLEAN version, but every other status could still be edited freely, and a version could be
-- renamed, re-hashed or moved to another tenant while it was still being scanned. This trigger holds for every
-- UPDATE whoever runs it, so the rules hold even if the API has a bug.
--
-- Rule 1, identity: tenant_id, organization_id, filename, storage_key never change after insert. sha256 is
-- NULL at insert and set once when the bytes have been received (documents.service.ts, step 4), so NULL ->
-- value is allowed and any later change is not.
--
-- Rule 2, status moves only along these transitions (the schema calls "uploading" `awaiting_content`):
--   awaiting_content -> quarantined   the upload was claimed
--   quarantined      -> clean         the scan passed
--   quarantined      -> infected      the scan found a virus
--   quarantined      -> scan_failed   the scanner kept failing
--   quarantined      -> rejected      the type check failed or the body was too large
--   scan_failed      -> quarantined   a rescan
--   quarantined      -> awaiting_content   only while sha256 IS NULL: an upload that broke off midway is reopened
--                                          so the client can send the content again (reopen() in the service)
-- Anything else raises, in particular clean, infected, rejected and a version whose bytes are recorded are
-- never put back to awaiting_content. An UPDATE that leaves the status as it is is not a transition.
--
-- Drizzle runs the whole file in one transaction and splits it at the breakpoint comments.

CREATE FUNCTION "app"."document_versions_guard_update"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
		OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
		OR NEW."filename" IS DISTINCT FROM OLD."filename"
		OR NEW."storage_key" IS DISTINCT FROM OLD."storage_key"
		OR (OLD."sha256" IS NOT NULL AND NEW."sha256" IS DISTINCT FROM OLD."sha256") THEN
		RAISE EXCEPTION 'document version % is immutable: tenant, organization, filename, sha256 and storage key cannot change', OLD."id"
			USING ERRCODE = 'restrict_violation';
	END IF;

	IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
		(OLD."status" = 'awaiting_content' AND NEW."status" = 'quarantined')
		OR (OLD."status" = 'quarantined' AND NEW."status" IN ('clean', 'infected', 'scan_failed', 'rejected'))
		OR (OLD."status" = 'scan_failed' AND NEW."status" = 'quarantined')
		OR (OLD."status" = 'quarantined' AND NEW."status" = 'awaiting_content' AND OLD."sha256" IS NULL)
	) THEN
		RAISE EXCEPTION 'document version %: status cannot move from % to %', OLD."id", OLD."status", NEW."status"
			USING ERRCODE = 'restrict_violation';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint

-- Named so it sorts after document_versions_clean_is_frozen (0004): a clean version is refused there first.
CREATE TRIGGER "document_versions_guard_update" BEFORE UPDATE ON "app"."document_versions"
FOR EACH ROW EXECUTE FUNCTION "app"."document_versions_guard_update"();
--> statement-breakpoint

-- removal state (FIX-E1) below
