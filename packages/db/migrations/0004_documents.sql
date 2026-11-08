-- 0004_documents: uploaded files (k-docs). Owner: U4. See the P1 plan, section 4.
--
-- A `documents` row is one logical file attached to an owner record (owner_type + owner_id, for example a
-- test memo). Each `document_versions` row is one uploaded content with its own scan status. The bytes are
-- never in the database: storage_key points to FILES_ROOT/{quarantine,clean}/<storage_key> on the files volume.
--
-- NFRs served: "no unscanned file is ever served" (status gate, enforced by the API) and "a clean file is
-- never silently lost or altered" (the two triggers below, which hold even if the API has a bug).
--
-- Drizzle runs the whole file in one transaction and splits it at the breakpoint comments, so every statement
-- is followed by one (a function body with semicolons stays one statement).

CREATE TABLE "app"."documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" uuid NOT NULL,
	-- The newest clean version. NULL until the first version has passed the scan.
	"current_version_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "documents_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id")
);
--> statement-breakpoint

CREATE INDEX "documents_owner_idx" ON "app"."documents" USING btree ("tenant_id", "organization_id", "owner_type", "owner_id");
--> statement-breakpoint

CREATE TABLE "app"."document_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"filename" text NOT NULL,
	"declared_mime" text NOT NULL,
	-- What file-type found in the bytes. NULL until the content has been received and inspected.
	"detected_mime" text,
	-- Declared at create, then replaced by the byte count actually received. 25 MiB = MAX_UPLOAD_BYTES.
	"size_bytes" bigint NOT NULL,
	-- SHA-256 of the content, set once, when the bytes have been received.
	"sha256" bytea,
	-- "<tenant_id>/<version_id>": the same relative path under quarantine/ and clean/.
	"storage_key" text NOT NULL,
	"status" text DEFAULT 'awaiting_content' NOT NULL,
	"scan_signature" text,
	"scan_engine" text,
	"scanned_at" timestamp with time zone,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_versions_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "app"."documents"("id"),
	CONSTRAINT "document_versions_document_version_unique" UNIQUE ("document_id", "version"),
	CONSTRAINT "document_versions_size_check" CHECK ("size_bytes" >= 0 AND "size_bytes" <= 26214400),
	CONSTRAINT "document_versions_sha256_check" CHECK ("sha256" IS NULL OR octet_length("sha256") = 32),
	CONSTRAINT "document_versions_status_check" CHECK ("status" IN ('awaiting_content', 'quarantined', 'clean', 'infected', 'rejected', 'scan_failed'))
);
--> statement-breakpoint

CREATE INDEX "document_versions_document_idx" ON "app"."document_versions" USING btree ("tenant_id", "organization_id", "document_id");
--> statement-breakpoint

-- documents.current_version_id points at a version, and every version points at its document: a cycle. The
-- constraint is added after both tables exist. NO ACTION (the default) also means a document cannot be deleted
-- while a version row exists.
ALTER TABLE "app"."documents" ADD CONSTRAINT "documents_current_version_fk"
	FOREIGN KEY ("current_version_id") REFERENCES "app"."document_versions"("id");
--> statement-breakpoint

-- No hard delete of a clean version. A clean file may already be referenced by an approval snapshot, so removing
-- it would break the audit trail. Row-level BEFORE DELETE trigger: it fires for every DELETE, whoever runs it.
-- (TRUNCATE skips row triggers, but bos_app has no TRUNCATE privilege.)
CREATE FUNCTION "app"."document_versions_block_clean_delete"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'document version % is clean and cannot be deleted', OLD."id"
		USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "document_versions_block_clean_delete" BEFORE DELETE ON "app"."document_versions"
FOR EACH ROW WHEN (OLD."status" = 'clean')
EXECUTE FUNCTION "app"."document_versions_block_clean_delete"();
--> statement-breakpoint

-- Without this, "never delete a clean version" could be sidestepped in two UPDATEs: change the status to
-- 'rejected', then delete. Once clean, the content fields and the status are frozen.
CREATE FUNCTION "app"."document_versions_clean_is_frozen"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."status" IS DISTINCT FROM OLD."status"
		OR NEW."sha256" IS DISTINCT FROM OLD."sha256"
		OR NEW."size_bytes" IS DISTINCT FROM OLD."size_bytes"
		OR NEW."storage_key" IS DISTINCT FROM OLD."storage_key"
		OR NEW."detected_mime" IS DISTINCT FROM OLD."detected_mime"
		OR NEW."document_id" IS DISTINCT FROM OLD."document_id" THEN
		RAISE EXCEPTION 'document version % is clean and cannot be changed', OLD."id"
			USING ERRCODE = 'restrict_violation';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "document_versions_clean_is_frozen" BEFORE UPDATE ON "app"."document_versions"
FOR EACH ROW WHEN (OLD."status" = 'clean')
EXECUTE FUNCTION "app"."document_versions_clean_is_frozen"();
--> statement-breakpoint

-- Audit triggers (audit.attach comes from 0001_audit).
SELECT audit.attach('app.documents');
--> statement-breakpoint
SELECT audit.attach('app.document_versions');
