-- 0107_quotation_evidence_confirmations: staff confirm the evidence behind a customer's portal acceptance (F1-Q28,
-- Kuu 2026-11-20: "the customer accepts in the portal, then staff confirm the evidence").
--
-- Until now a portal acceptance stood on its own, and when `sales.evidence_policy` asked for a contract or a
-- purchase order the portal refused the acceptance outright (F1 bug 32). From this migration on:
--   * the customer's acceptance is recorded whatever the policy (quotation_acceptances, unchanged);
--   * a staff member then records which evidence they hold here: the kinds (they must meet the policy in force when
--     they confirm), the files and an optional note. One row per accepted version, never changed or removed;
--   * an acceptance staff recorded themselves (actor_kind = 'staff') was checked against the policy when it was
--     recorded, so it counts as confirmed with no row here. Only a portal acceptance waits for one.
-- A sales order is confirmed only once the evidence of its version is confirmed (SalesOrdersService).
--
-- Existing data: no row is written. An older portal acceptance whose quotation has no sales order yet now waits for
-- a staff confirmation like a new one; orders already confirmed are untouched.
--
-- quotation_acceptances is append-only (0016), so this is a table of its own rather than columns there. It has no
-- foreign key to the acceptance (that table has no entity-wide key to point at); (tenant_id, version_id) is unique
-- in both tables, so the version names the acceptance. Runs as bos_owner, split at the breakpoint comments. No
-- GRANT: 0008's default privileges cover new tables. No data is changed, so no audit actor is set.

CREATE TABLE "app"."quotation_evidence_confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"evidence_kinds" text[] NOT NULL,
	"evidence_document_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"comment" text,
	"confirmed_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quotation_evidence_confirmations_tenant_id_unique" UNIQUE("tenant_id", "id"),
	CONSTRAINT "quotation_evidence_confirmations_tenant_version_unique" UNIQUE("tenant_id", "version_id"),
	CONSTRAINT "quotation_evidence_confirmations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "quotation_evidence_confirmations_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "quotation_evidence_confirmations_version_fk" FOREIGN KEY ("tenant_id", "organization_id", "version_id") REFERENCES "app"."quotation_versions"("tenant_id", "organization_id", "id"),
	CONSTRAINT "quotation_evidence_confirmations_confirmed_by_user_fk" FOREIGN KEY ("tenant_id", "confirmed_by") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "quotation_evidence_confirmations_evidence_kinds_check" CHECK ("evidence_kinds" <@ ARRAY['contract', 'purchase_order', 'signed_quote']::text[] AND array_position("evidence_kinds", NULL) IS NULL AND cardinality("evidence_kinds") >= 1),
	CONSTRAINT "quotation_evidence_confirmations_evidence_document_ids_check" CHECK (array_position("evidence_document_ids", NULL) IS NULL),
	CONSTRAINT "quotation_evidence_confirmations_comment_check" CHECK ("comment" IS NULL OR char_length("comment") <= 2000)
);
--> statement-breakpoint

-- Frozen once written, like the acceptance it confirms (0016's shared function).
CREATE TRIGGER "quotation_evidence_confirmations_append_only" BEFORE UPDATE OR DELETE ON "app"."quotation_evidence_confirmations"
FOR EACH ROW EXECUTE FUNCTION "app"."quotation_append_only"();
--> statement-breakpoint

SELECT audit.attach('app.quotation_evidence_confirmations');
