-- 0176_party_import_batches: the record of a customer or vendor CSV import (round 5, K1; Kuu decision K-M3).
--   * One row per uploaded file. The API parses the upload, checks every line (missing name, bad PAN, bad email, a
--     duplicate of an existing record or of an earlier line) and stores the result in `rows`, status `previewed`.
--     Committing it creates the valid lines in one transaction and moves the batch to `committed`, so a reload of the
--     result page shows the same counts and the same error report. The file itself is not stored.
--   * rows: a jsonb array, one element per data line (at most 2000, the API's limit), holding the line number, the name
--     and PAN as read, the status, the problems, the normalised columns and, once created, the new record's id.
--   * Counts always describe the rows' current statuses: row_count = valid_count + created_count + duplicate_count +
--     error_count (valid_count is 0 after the commit).
--   * A committed batch is final: the guard trigger refuses UPDATE on it, and refuses DELETE on any batch, so the
--     record stays as the proof of who imported what and when.
-- Entity-owned (tenant_id + organization_id), composite FKs. Not attached to the row audit trigger: `rows` holds the
-- uploaded names, addresses, emails and phones, which the audit log (readable with audit.read) must not copy before the
-- commit; the service records `party_import.previewed` and `party_import.committed` events (counts, actor) instead, and
-- the created customers and vendors are audited by their own triggers. No GRANT: 0008's default privileges cover new
-- tables. The table starts empty, so no audit actor is needed.

CREATE TABLE "app"."party_import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'previewed' NOT NULL,
	"file_name" text NOT NULL,
	"row_count" integer NOT NULL,
	"valid_count" integer NOT NULL,
	"created_count" integer DEFAULT 0 NOT NULL,
	"duplicate_count" integer NOT NULL,
	"error_count" integer NOT NULL,
	"rows" jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"committed_by" uuid,
	"committed_at" timestamp with time zone,
	CONSTRAINT "party_import_batches_tenant_id_unique" UNIQUE("tenant_id", "id"),
	CONSTRAINT "party_import_batches_tenant_org_id_unique" UNIQUE("tenant_id", "organization_id", "id"),
	CONSTRAINT "party_import_batches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "party_import_batches_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "party_import_batches_created_by_fk" FOREIGN KEY ("tenant_id", "created_by") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "party_import_batches_committed_by_fk" FOREIGN KEY ("tenant_id", "committed_by") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "party_import_batches_kind_check" CHECK ("kind" in ('customer', 'vendor')),
	CONSTRAINT "party_import_batches_status_check" CHECK ("status" in ('previewed', 'committed')),
	CONSTRAINT "party_import_batches_file_name_check" CHECK (btrim("file_name") <> '' AND length("file_name") <= 200),
	CONSTRAINT "party_import_batches_counts_check" CHECK ("row_count" between 0 and 2000 AND "valid_count" >= 0 AND "created_count" >= 0 AND "duplicate_count" >= 0 AND "error_count" >= 0 AND "row_count" = "valid_count" + "created_count" + "duplicate_count" + "error_count"),
	CONSTRAINT "party_import_batches_rows_check" CHECK (jsonb_typeof("rows") = 'array' AND jsonb_array_length("rows") = "row_count"),
	CONSTRAINT "party_import_batches_committed_check" CHECK (("status" = 'committed') = ("committed_at" IS NOT NULL AND "committed_by" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX "party_import_batches_tenant_org_created_idx" ON "app"."party_import_batches" USING btree ("tenant_id","organization_id","created_at");
--> statement-breakpoint
CREATE FUNCTION "app"."party_import_batches_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'party_import_batches: an import record is never deleted'
			USING ERRCODE = 'check_violation', CONSTRAINT = 'party_import_batches_final';
	END IF;
	IF OLD.status = 'committed' THEN
		RAISE EXCEPTION 'party_import_batches: a committed import is final'
			USING ERRCODE = 'check_violation', CONSTRAINT = 'party_import_batches_final';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "app"."party_import_batches_guard"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "party_import_batches_guard" BEFORE UPDATE OR DELETE ON "app"."party_import_batches"
FOR EACH ROW EXECUTE FUNCTION "app"."party_import_batches_guard"();
