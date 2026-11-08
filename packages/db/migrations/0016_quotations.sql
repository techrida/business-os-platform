-- 0016_quotations: the quotation tables of P2 (plan unit S2; A2 sections 2.1 to 2.6, ADR 0027, delta C-1, C-2,
-- C-8, C-10 and C-11). Money is numeric(18,2), quantities numeric(18,4), FX rates numeric(18,6) (C-1, C-11).
--
-- Two scopes (ADR 0027 sections 6 and 8, and the "From P1" rules of the P2 build plan):
--   * Tenant-level (on check-tenancy's TENANT_SCOPED list): tax_codes, payment_terms. tenant_id NOT NULL with its
--     FK to app.tenants, no organization_id, unique keys led by tenant_id.
--   * Entity-owned: quotations and its six child tables. (tenant_id, organization_id) -> organizations
--     (<table>_tenant_org_fk); a FK into another entity-owned table is (tenant_id, organization_id, x); a FK into a
--     tenant-level table (customers, parties, users, tax_codes, payment_terms) is (tenant_id, x).
--
-- A quotation is a parent with numbered, immutable versions (A2 section 2.3):
--   * quotations.number is assigned when the quotation is created (C-10: not a tax document; gaps are allowed).
--   * customer_party_id is the counterparty column of ADR 0027 section 5: nullable (check-tenancy's counterparty
--     rule), with the kind checked through a stored generated 'customer' column, plus a FK to the CRM customer.
--     number, opportunity_id and customer_party_id are frozen once set (quotations_guard), because the customer
--     lives on the parent and every version shows it.
--   * current_version_id, supersedes_version_id and superseded_by_version_id point through
--     (tenant_id, organization_id, quotation_id, id), so they can only name a version of the same quotation.
--     quotations and quotation_versions reference each other; the parent's half is added after both exist.
--   * one_live_version: at most one version per quotation in a live status. "Live" is exactly the contracts'
--     QUOTATION_REVISION_RULES.liveStatuses: draft, submitted, returned, approved, sent. The terminal statuses
--     (accepted, rejected, expired, cancelled, superseded) are outside it. A revision of an Approved or Sent
--     version therefore writes, in one transaction: old status = 'superseded', INSERT the new draft (supersedes =
--     old), then old superseded_by_version_id = new.
--   * Freeze (quotation_versions_guard): a version is inserted as draft. Once its status is not draft or returned,
--     an UPDATE that changes a material column, or a DELETE, is refused; the status may move to submitted only
--     from draft or returned, to returned only from submitted, and never to draft. Lines, the tax summary and the editor list are frozen with their
--     version (quotation_children_guard, INSERT included). Acceptances and status history are append-only.
--     The submit UPDATE (draft/returned -> submitted) must also write the FX snapshot, the NPR amounts and both
--     hashes: afterwards they are frozen, and quotation_versions_snapshot_check requires them.
--   * Hashes are bytea of 32 bytes, as approval_requests.snapshot_sha256 and document_versions.sha256.
--
-- Columns of S1 tables that point here get their FKs at the end of this file. Every table is audited
-- (audit.attach). No GRANT: 0008's default privileges give bos_app SELECT, INSERT, UPDATE, DELETE on new tables.
-- version is the optimistic lock; updated_at is set by the API, as on every kernel table.
--
-- Runs as bos_owner, split at the breakpoint comments. bos_owner owns the database, so it may create the trusted
-- extension btree_gist (PostgreSQL 13+), which the tax-code EXCLUDE constraint needs for its uuid and text
-- equality. Names follow the K1-U2 convention, mirrored in src/schema/quotations.ts.

CREATE EXTENSION IF NOT EXISTS "btree_gist" WITH SCHEMA "public";
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------
-- Tenant-level tables
-- ---------------------------------------------------------------------------------------------------------------

-- A tax code period (C-8). One code (VAT13) has one row per effective period [effective_from, effective_to);
-- effective_to NULL is open-ended, and periods of one code never overlap (tax_codes_no_overlap). A line names the
-- row, so a rate change is a new period, never an edit. rate_bp is basis points (1300 = 13%); exempt and zero-rated
-- codes have rate 0, VAT and reverse-charge codes a positive one. creditable: input tax may be claimed back.
CREATE TABLE "app"."tax_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"rate_bp" integer NOT NULL,
	"creditable" boolean NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_codes_tenant_id_unique" UNIQUE("tenant_id", "id"),
	CONSTRAINT "tax_codes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "tax_codes_kind_check" CHECK ("kind" in ('vat', 'exempt', 'zero', 'reverse_charge')),
	CONSTRAINT "tax_codes_rate_bp_check" CHECK ("rate_bp" BETWEEN 0 AND 10000),
	CONSTRAINT "tax_codes_rate_kind_check" CHECK (("kind" IN ('exempt', 'zero')) = ("rate_bp" = 0)),
	CONSTRAINT "tax_codes_period_check" CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from"),
	CONSTRAINT "tax_codes_version_check" CHECK ("version" >= 1)
);
--> statement-breakpoint

-- No two periods of one code overlap within a tenant. '[)' makes effective_to exclusive, so a period may start on
-- the previous one's end date; a NULL effective_to is an unbounded upper end.
ALTER TABLE "app"."tax_codes" ADD CONSTRAINT "tax_codes_no_overlap" EXCLUDE USING gist ("tenant_id" WITH =, "code" WITH =, daterange("effective_from", "effective_to", '[)') WITH &&);
--> statement-breakpoint

-- A payment term (Net 15, 50% advance). net_days is the due period of an invoice; a schedule of milestones lives on
-- the quotation version. Tenant-level: one list for every legal entity.
CREATE TABLE "app"."payment_terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"net_days" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_terms_tenant_id_unique" UNIQUE("tenant_id", "id"),
	CONSTRAINT "payment_terms_tenant_code_unique" UNIQUE("tenant_id", "code"),
	CONSTRAINT "payment_terms_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "payment_terms_net_days_check" CHECK ("net_days" BETWEEN 0 AND 365),
	CONSTRAINT "payment_terms_version_check" CHECK ("version" >= 1)
);
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------
-- Entity-owned tables
-- ---------------------------------------------------------------------------------------------------------------

-- A quotation: the parent of its versions. Its status is derived from current_version_id, never stored (A2 D2).
-- current_version_id is NULL only between the INSERT of the parent and of its first version.
-- legacy_source = 'estimate' marks a D3 import (A2 section 3.5).
CREATE TABLE "app"."quotations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text NOT NULL,
	"customer_party_id" uuid,
	"customer_party_kind" text GENERATED ALWAYS AS ('customer') STORED,
	"opportunity_id" uuid NOT NULL,
	"current_version_id" uuid,
	"owner_user_id" uuid,
	"legacy_source" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quotations_tenant_id_unique" UNIQUE("tenant_id", "id"),
	CONSTRAINT "quotations_tenant_org_id_unique" UNIQUE("tenant_id", "organization_id", "id"),
	CONSTRAINT "quotations_tenant_org_number_unique" UNIQUE("tenant_id", "organization_id", "number"),
	CONSTRAINT "quotations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "quotations_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "quotations_customer_party_fk" FOREIGN KEY ("tenant_id", "customer_party_id", "customer_party_kind") REFERENCES "app"."parties"("tenant_id", "id", "kind"),
	CONSTRAINT "quotations_customer_fk" FOREIGN KEY ("tenant_id", "customer_party_id") REFERENCES "app"."customers"("tenant_id", "id"),
	CONSTRAINT "quotations_opportunity_fk" FOREIGN KEY ("tenant_id", "organization_id", "opportunity_id") REFERENCES "app"."opportunities"("tenant_id", "organization_id", "id"),
	CONSTRAINT "quotations_owner_user_fk" FOREIGN KEY ("tenant_id", "owner_user_id") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "quotations_legacy_source_check" CHECK ("legacy_source" in ('estimate')),
	CONSTRAINT "quotations_version_check" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE INDEX "quotations_tenant_customer_party_idx" ON "app"."quotations" USING btree ("tenant_id", "customer_party_id");
--> statement-breakpoint
CREATE INDEX "quotations_tenant_org_opportunity_idx" ON "app"."quotations" USING btree ("tenant_id", "organization_id", "opportunity_id");
--> statement-breakpoint

-- One numbered version of a quotation (A2 section 2.1). The material content (customer contact, currency, dates,
-- texts, payment term and schedule, discount, totals, FX snapshot, hashes) is frozen once the version leaves
-- draft/returned. Totals are the server's pricing result (A2 section 2.6): taxable = subtotal - discount,
-- total = taxable + tax, all in the document currency. FX (C-11): fx_rate is NPR per unit (1 for NPR), with its
-- source and date for a foreign currency; amount_npr is the NPR total and npr_taxable_amount the NPR taxable
-- amount the approval thresholds use. Both are required from submit on (quotation_versions_snapshot_check).
-- content_sha256 hashes the canonical material fields; snapshot_sha256 is the hash the approval request froze.
-- The rendered PDF is a kernel document of the same entity; its scan status lives on its document version.
CREATE TABLE "app"."quotation_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"quotation_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"rejection_source" text,
	"contact_id" uuid,
	"template_id" uuid,
	"currency" char(3) NOT NULL,
	"issue_date" date NOT NULL,
	"valid_until" date NOT NULL,
	"scope" text,
	"assumptions" text,
	"exclusions" text,
	"delivery_timeline" text,
	"payment_term_id" uuid,
	"payment_schedule" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"discount_mode" text,
	"discount_input" numeric(18, 4),
	"subtotal" numeric(18, 2) DEFAULT 0 NOT NULL,
	"discount_amount" numeric(18, 2) DEFAULT 0 NOT NULL,
	"taxable_amount" numeric(18, 2) DEFAULT 0 NOT NULL,
	"tax_amount" numeric(18, 2) DEFAULT 0 NOT NULL,
	"total" numeric(18, 2) DEFAULT 0 NOT NULL,
	"effective_discount_pct" numeric(9, 4) DEFAULT 0 NOT NULL,
	"fx_rate" numeric(18, 6),
	"fx_source" text,
	"fx_date" date,
	"amount_npr" numeric(18, 2),
	"npr_taxable_amount" numeric(18, 2),
	"internal_cost_total" numeric(18, 2),
	"margin_pct" numeric(9, 4),
	"calc_version" integer DEFAULT 1 NOT NULL,
	"content_sha256" bytea,
	"snapshot_sha256" bytea,
	"approval_request_id" uuid,
	"rendered_document_id" uuid,
	"rendered_sha256" bytea,
	"render_state" text DEFAULT 'none' NOT NULL,
	"supersedes_version_id" uuid,
	"superseded_by_version_id" uuid,
	"revision_reason" text,
	"cancel_reason" text,
	"submitted_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quotation_versions_tenant_id_unique" UNIQUE("tenant_id", "id"),
	CONSTRAINT "quotation_versions_tenant_org_id_unique" UNIQUE("tenant_id", "organization_id", "id"),
	CONSTRAINT "quotation_versions_tenant_org_quotation_id_unique" UNIQUE("tenant_id", "organization_id", "quotation_id", "id"),
	CONSTRAINT "quotation_versions_tenant_quotation_revision_unique" UNIQUE("tenant_id", "quotation_id", "revision_no"),
	CONSTRAINT "quotation_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "quotation_versions_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "quotation_versions_quotation_fk" FOREIGN KEY ("tenant_id", "organization_id", "quotation_id") REFERENCES "app"."quotations"("tenant_id", "organization_id", "id"),
	CONSTRAINT "quotation_versions_contact_fk" FOREIGN KEY ("tenant_id", "contact_id") REFERENCES "app"."customer_contacts"("tenant_id", "id"),
	CONSTRAINT "quotation_versions_payment_term_fk" FOREIGN KEY ("tenant_id", "payment_term_id") REFERENCES "app"."payment_terms"("tenant_id", "id"),
	CONSTRAINT "quotation_versions_approval_request_fk" FOREIGN KEY ("tenant_id", "organization_id", "approval_request_id") REFERENCES "app"."approval_requests"("tenant_id", "organization_id", "id"),
	CONSTRAINT "quotation_versions_rendered_document_fk" FOREIGN KEY ("tenant_id", "organization_id", "rendered_document_id") REFERENCES "app"."documents"("tenant_id", "organization_id", "id"),
	CONSTRAINT "quotation_versions_supersedes_fk" FOREIGN KEY ("tenant_id", "organization_id", "quotation_id", "supersedes_version_id") REFERENCES "app"."quotation_versions"("tenant_id", "organization_id", "quotation_id", "id"),
	CONSTRAINT "quotation_versions_superseded_by_fk" FOREIGN KEY ("tenant_id", "organization_id", "quotation_id", "superseded_by_version_id") REFERENCES "app"."quotation_versions"("tenant_id", "organization_id", "quotation_id", "id"),
	CONSTRAINT "quotation_versions_status_check" CHECK ("status" in ('draft', 'submitted', 'returned', 'approved', 'sent', 'accepted', 'rejected', 'expired', 'cancelled', 'superseded')),
	CONSTRAINT "quotation_versions_rejection_source_check" CHECK ("rejection_source" in ('internal', 'customer')),
	CONSTRAINT "quotation_versions_rejected_check" CHECK (("status" = 'rejected') = ("rejection_source" IS NOT NULL)),
	CONSTRAINT "quotation_versions_revision_no_check" CHECK ("revision_no" >= 1),
	CONSTRAINT "quotation_versions_revision_check" CHECK (("revision_no" = 1) = ("supersedes_version_id" IS NULL)),
	CONSTRAINT "quotation_versions_revision_reason_check" CHECK ("revision_no" = 1 OR "revision_reason" IS NOT NULL),
	CONSTRAINT "quotation_versions_supersedes_self_check" CHECK ("supersedes_version_id" <> "id" AND "superseded_by_version_id" <> "id"),
	CONSTRAINT "quotation_versions_cancel_reason_check" CHECK ("status" <> 'cancelled' OR "cancel_reason" IS NOT NULL),
	CONSTRAINT "quotation_versions_currency_check" CHECK ("currency" in ('NPR', 'INR', 'USD')),
	CONSTRAINT "quotation_versions_validity_check" CHECK ("valid_until" >= "issue_date"),
	CONSTRAINT "quotation_versions_payment_schedule_check" CHECK (jsonb_typeof("payment_schedule") = 'array'),
	CONSTRAINT "quotation_versions_discount_mode_check" CHECK ("discount_mode" in ('pct', 'amount')),
	CONSTRAINT "quotation_versions_discount_input_check" CHECK (("discount_mode" IS NULL) = ("discount_input" IS NULL) AND "discount_input" >= 0 AND ("discount_mode" <> 'pct' OR "discount_input" <= 100)),
	CONSTRAINT "quotation_versions_amounts_check" CHECK ("subtotal" >= 0 AND "discount_amount" >= 0 AND "discount_amount" <= "subtotal" AND "tax_amount" >= 0),
	CONSTRAINT "quotation_versions_taxable_check" CHECK ("taxable_amount" = "subtotal" - "discount_amount"),
	CONSTRAINT "quotation_versions_total_check" CHECK ("total" = "taxable_amount" + "tax_amount"),
	CONSTRAINT "quotation_versions_effective_discount_check" CHECK ("effective_discount_pct" BETWEEN 0 AND 100),
	CONSTRAINT "quotation_versions_fx_rate_check" CHECK ("fx_rate" > 0 AND ("currency" <> 'NPR' OR "fx_rate" = 1)),
	CONSTRAINT "quotation_versions_fx_source_check" CHECK (("fx_source" IS NULL) = ("fx_date" IS NULL)),
	CONSTRAINT "quotation_versions_npr_amounts_check" CHECK ("amount_npr" >= 0 AND "npr_taxable_amount" >= 0),
	CONSTRAINT "quotation_versions_internal_cost_check" CHECK ("internal_cost_total" >= 0),
	CONSTRAINT "quotation_versions_calc_version_check" CHECK ("calc_version" >= 1),
	CONSTRAINT "quotation_versions_sha256_check" CHECK (octet_length("content_sha256") = 32 AND octet_length("snapshot_sha256") = 32 AND octet_length("rendered_sha256") = 32),
	CONSTRAINT "quotation_versions_snapshot_check" CHECK ("status" IN ('draft', 'returned', 'cancelled') OR ("fx_rate" IS NOT NULL AND "amount_npr" IS NOT NULL AND "npr_taxable_amount" IS NOT NULL AND "content_sha256" IS NOT NULL AND "snapshot_sha256" IS NOT NULL AND ("currency" = 'NPR' OR "fx_source" IS NOT NULL))),
	CONSTRAINT "quotation_versions_render_state_check" CHECK ("render_state" in ('none', 'pending', 'rendered', 'failed')),
	CONSTRAINT "quotation_versions_rendered_check" CHECK ("render_state" <> 'rendered' OR ("rendered_document_id" IS NOT NULL AND "rendered_sha256" IS NOT NULL)),
	CONSTRAINT "quotation_versions_version_check" CHECK ("version" >= 1)
);
--> statement-breakpoint

-- At most one live version per quotation: the contracts' liveStatuses. Not deferrable (a partial unique index
-- cannot be), so a revision takes the old version out of the live set before it inserts the new draft.
CREATE UNIQUE INDEX "one_live_version" ON "app"."quotation_versions" USING btree ("tenant_id", "quotation_id") WHERE "status" IN ('draft', 'submitted', 'returned', 'approved', 'sent');
--> statement-breakpoint
-- Accepted is not revisable (A2 C15), so a quotation is accepted at most once.
CREATE UNIQUE INDEX "quotation_versions_one_accepted" ON "app"."quotation_versions" USING btree ("tenant_id", "quotation_id") WHERE "status" = 'accepted';
--> statement-breakpoint
CREATE INDEX "quotation_versions_tenant_org_status_idx" ON "app"."quotation_versions" USING btree ("tenant_id", "organization_id", "status");
--> statement-breakpoint

-- The parent's half of the cycle: the current version must be one of this quotation's versions.
-- MATCH SIMPLE: not checked while current_version_id is NULL.
ALTER TABLE "app"."quotations" ADD CONSTRAINT "quotations_current_version_fk" FOREIGN KEY ("tenant_id", "organization_id", "id", "current_version_id") REFERENCES "app"."quotation_versions"("tenant_id", "organization_id", "quotation_id", "id");
--> statement-breakpoint

-- One line of a version. No per-line discount (A2 C5): discount_alloc is the line's share of the quotation
-- discount. gross = round(quantity * unit_price, 2) (half up for positive amounts, A2 section 2.6 step 1) and
-- taxable = gross - discount_alloc. unit_cost is internal. catalog_item_id has no FK until a catalogue exists.
CREATE TABLE "app"."quotation_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"catalog_item_id" uuid,
	"description" text NOT NULL,
	"uom" text NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"unit_price" numeric(18, 2) NOT NULL,
	"unit_cost" numeric(18, 2),
	"tax_code_id" uuid NOT NULL,
	"gross" numeric(18, 2) NOT NULL,
	"discount_alloc" numeric(18, 2) DEFAULT 0 NOT NULL,
	"taxable" numeric(18, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quotation_lines_tenant_id_unique" UNIQUE("tenant_id", "id"),
	CONSTRAINT "quotation_lines_tenant_version_line_no_unique" UNIQUE("tenant_id", "version_id", "line_no"),
	CONSTRAINT "quotation_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "quotation_lines_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "quotation_lines_version_fk" FOREIGN KEY ("tenant_id", "organization_id", "version_id") REFERENCES "app"."quotation_versions"("tenant_id", "organization_id", "id"),
	CONSTRAINT "quotation_lines_tax_code_fk" FOREIGN KEY ("tenant_id", "tax_code_id") REFERENCES "app"."tax_codes"("tenant_id", "id"),
	CONSTRAINT "quotation_lines_line_no_check" CHECK ("line_no" >= 1),
	CONSTRAINT "quotation_lines_quantity_check" CHECK ("quantity" > 0),
	CONSTRAINT "quotation_lines_unit_price_check" CHECK ("unit_price" >= 0),
	CONSTRAINT "quotation_lines_unit_cost_check" CHECK ("unit_cost" >= 0),
	CONSTRAINT "quotation_lines_gross_check" CHECK ("gross" = round("quantity" * "unit_price", 2)),
	CONSTRAINT "quotation_lines_discount_alloc_check" CHECK ("discount_alloc" >= 0 AND "discount_alloc" <= "gross"),
	CONSTRAINT "quotation_lines_taxable_check" CHECK ("taxable" = "gross" - "discount_alloc")
);
--> statement-breakpoint
CREATE INDEX "quotation_lines_tenant_tax_code_idx" ON "app"."quotation_lines" USING btree ("tenant_id", "tax_code_id");
--> statement-breakpoint

-- Tax per tax code, rounded once per code (A2 section 2.6 step 5). label and rate are copied from the tax code
-- when priced, because a tax code row may later be closed or renamed; rate is in percent, numeric(7,4).
CREATE TABLE "app"."quotation_tax_summary" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"tax_code_id" uuid NOT NULL,
	"label" text NOT NULL,
	"rate" numeric(7, 4) NOT NULL,
	"base" numeric(18, 2) NOT NULL,
	"tax" numeric(18, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quotation_tax_summary_tenant_id_unique" UNIQUE("tenant_id", "id"),
	CONSTRAINT "quotation_tax_summary_tenant_version_tax_code_unique" UNIQUE("tenant_id", "version_id", "tax_code_id"),
	CONSTRAINT "quotation_tax_summary_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "quotation_tax_summary_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "quotation_tax_summary_version_fk" FOREIGN KEY ("tenant_id", "organization_id", "version_id") REFERENCES "app"."quotation_versions"("tenant_id", "organization_id", "id"),
	CONSTRAINT "quotation_tax_summary_tax_code_fk" FOREIGN KEY ("tenant_id", "tax_code_id") REFERENCES "app"."tax_codes"("tenant_id", "id"),
	CONSTRAINT "quotation_tax_summary_rate_check" CHECK ("rate" BETWEEN 0 AND 100),
	CONSTRAINT "quotation_tax_summary_amounts_check" CHECK ("base" >= 0 AND "tax" >= 0)
);
--> statement-breakpoint

-- The material editors of a version (A2 C6): everyone who saved a material field. Separation of duties reads it,
-- so it is frozen with the version like the lines.
CREATE TABLE "app"."quotation_version_editors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"first_edit_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quotation_version_editors_tenant_id_unique" UNIQUE("tenant_id", "id"),
	CONSTRAINT "quotation_version_editors_tenant_version_user_unique" UNIQUE("tenant_id", "version_id", "user_id"),
	CONSTRAINT "quotation_version_editors_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "quotation_version_editors_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "quotation_version_editors_version_fk" FOREIGN KEY ("tenant_id", "organization_id", "version_id") REFERENCES "app"."quotation_versions"("tenant_id", "organization_id", "id"),
	CONSTRAINT "quotation_version_editors_user_fk" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "app"."users"("tenant_id", "id")
);
--> statement-breakpoint

-- The customer's answer to a sent version: one per version. actor_kind is staff today, customer_user once the
-- portal records answers (A2 C9); either way actor_id is an app.users row. Accepting needs at least one evidence
-- kind (EVIDENCE_KINDS of the contracts); rejecting needs a comment. Evidence files are kernel documents.
CREATE TABLE "app"."quotation_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"decided_on" date NOT NULL,
	"comment" text,
	"evidence_kinds" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quotation_acceptances_tenant_id_unique" UNIQUE("tenant_id", "id"),
	CONSTRAINT "quotation_acceptances_tenant_version_unique" UNIQUE("tenant_id", "version_id"),
	CONSTRAINT "quotation_acceptances_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "quotation_acceptances_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "quotation_acceptances_version_fk" FOREIGN KEY ("tenant_id", "organization_id", "version_id") REFERENCES "app"."quotation_versions"("tenant_id", "organization_id", "id"),
	CONSTRAINT "quotation_acceptances_actor_user_fk" FOREIGN KEY ("tenant_id", "actor_id") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "quotation_acceptances_outcome_check" CHECK ("outcome" in ('accepted', 'rejected')),
	CONSTRAINT "quotation_acceptances_actor_kind_check" CHECK ("actor_kind" in ('staff', 'customer_user')),
	CONSTRAINT "quotation_acceptances_evidence_kinds_check" CHECK ("evidence_kinds" <@ ARRAY['contract', 'purchase_order', 'signed_quote']::text[] AND array_position("evidence_kinds", NULL) IS NULL),
	CONSTRAINT "quotation_acceptances_accepted_evidence_check" CHECK ("outcome" <> 'accepted' OR cardinality("evidence_kinds") >= 1),
	CONSTRAINT "quotation_acceptances_rejected_comment_check" CHECK ("outcome" <> 'rejected' OR "comment" IS NOT NULL)
);
--> statement-breakpoint

-- Every status change of a version, written by the service with the transition. from_status is NULL for the
-- first entry; actor_id is NULL for the system (the expiry job, the Lost cascade).
CREATE TABLE "app"."quotation_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor_id" uuid,
	"reason" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quotation_status_history_tenant_id_unique" UNIQUE("tenant_id", "id"),
	CONSTRAINT "quotation_status_history_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "quotation_status_history_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "quotation_status_history_version_fk" FOREIGN KEY ("tenant_id", "organization_id", "version_id") REFERENCES "app"."quotation_versions"("tenant_id", "organization_id", "id"),
	CONSTRAINT "quotation_status_history_actor_user_fk" FOREIGN KEY ("tenant_id", "actor_id") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "quotation_status_history_from_status_check" CHECK ("from_status" in ('draft', 'submitted', 'returned', 'approved', 'sent', 'accepted', 'rejected', 'expired', 'cancelled', 'superseded')),
	CONSTRAINT "quotation_status_history_to_status_check" CHECK ("to_status" in ('draft', 'submitted', 'returned', 'approved', 'sent', 'accepted', 'rejected', 'expired', 'cancelled', 'superseded'))
);
--> statement-breakpoint
CREATE INDEX "quotation_status_history_tenant_org_version_at_idx" ON "app"."quotation_status_history" USING btree ("tenant_id", "organization_id", "version_id", "at");
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------
-- Freeze triggers (A2 section 2.3 rule 3). The service checks status first; these refuse what slips past it.
-- Not SECURITY DEFINER: they read only rows the writing role may read already. Errors are check_violation with
-- the named pseudo-constraint, as 0011 does.
-- ---------------------------------------------------------------------------------------------------------------

-- quotation_versions: the gate is OLD.status, never NEW.status, so one UPDATE cannot set draft and change amounts.
-- The comparison lists below are pinned to src/schema/quotations.ts by quotations-schema.test.ts.
CREATE FUNCTION "app"."quotation_versions_guard"() RETURNS trigger
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
--> statement-breakpoint
CREATE TRIGGER "quotation_versions_guard" BEFORE INSERT OR UPDATE OR DELETE ON "app"."quotation_versions"
FOR EACH ROW EXECUTE FUNCTION "app"."quotation_versions_guard"();
--> statement-breakpoint

-- Lines, tax summary and editors: any INSERT, UPDATE or DELETE needs the parent version (the OLD and the NEW one)
-- in draft or returned. FOR SHARE locks the parent row, so a concurrent submit waits for this write to commit
-- instead of hashing content that is about to change. A missing parent is left to the foreign key.
CREATE FUNCTION "app"."quotation_children_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
	v_status text;
BEGIN
	IF TG_OP IN ('UPDATE', 'DELETE') THEN
		SELECT v."status" INTO v_status FROM "app"."quotation_versions" v
		 WHERE v."tenant_id" = OLD."tenant_id" AND v."id" = OLD."version_id" FOR SHARE;
		IF v_status NOT IN ('draft', 'returned') THEN
			RAISE EXCEPTION '%: quotation version % is % and frozen', TG_TABLE_NAME, OLD."version_id", v_status
				USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_frozen_check';
		END IF;
	END IF;
	IF TG_OP IN ('INSERT', 'UPDATE') THEN
		SELECT v."status" INTO v_status FROM "app"."quotation_versions" v
		 WHERE v."tenant_id" = NEW."tenant_id" AND v."id" = NEW."version_id" FOR SHARE;
		IF v_status NOT IN ('draft', 'returned') THEN
			RAISE EXCEPTION '%: quotation version % is % and frozen', TG_TABLE_NAME, NEW."version_id", v_status
				USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_frozen_check';
		END IF;
	END IF;
	IF TG_OP = 'DELETE' THEN
		RETURN OLD;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "app"."quotation_children_guard"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "quotation_lines_guard" BEFORE INSERT OR UPDATE OR DELETE ON "app"."quotation_lines"
FOR EACH ROW EXECUTE FUNCTION "app"."quotation_children_guard"();
--> statement-breakpoint
CREATE TRIGGER "quotation_tax_summary_guard" BEFORE INSERT OR UPDATE OR DELETE ON "app"."quotation_tax_summary"
FOR EACH ROW EXECUTE FUNCTION "app"."quotation_children_guard"();
--> statement-breakpoint
CREATE TRIGGER "quotation_version_editors_guard" BEFORE INSERT OR UPDATE OR DELETE ON "app"."quotation_version_editors"
FOR EACH ROW EXECUTE FUNCTION "app"."quotation_children_guard"();
--> statement-breakpoint

-- Acceptances and status history are records of what happened: never rewritten or removed.
CREATE FUNCTION "app"."quotation_append_only"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
	RAISE EXCEPTION '%: rows are append-only (% refused)', TG_TABLE_NAME, TG_OP
		USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_append_only';
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "app"."quotation_append_only"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "quotation_acceptances_append_only" BEFORE UPDATE OR DELETE ON "app"."quotation_acceptances"
FOR EACH ROW EXECUTE FUNCTION "app"."quotation_append_only"();
--> statement-breakpoint
CREATE TRIGGER "quotation_status_history_append_only" BEFORE UPDATE OR DELETE ON "app"."quotation_status_history"
FOR EACH ROW EXECUTE FUNCTION "app"."quotation_append_only"();
--> statement-breakpoint

-- quotations: the number, the opportunity and the entity never change; the customer may be set once (from NULL)
-- and then stays, because every version, sent or accepted, shows it.
CREATE FUNCTION "app"."quotations_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
	IF OLD."id" IS DISTINCT FROM NEW."id"
		OR OLD."tenant_id" IS DISTINCT FROM NEW."tenant_id"
		OR OLD."organization_id" IS DISTINCT FROM NEW."organization_id"
		OR OLD."number" IS DISTINCT FROM NEW."number"
		OR OLD."opportunity_id" IS DISTINCT FROM NEW."opportunity_id"
		OR (OLD."customer_party_id" IS NOT NULL AND OLD."customer_party_id" IS DISTINCT FROM NEW."customer_party_id") THEN
		RAISE EXCEPTION 'quotation %: number, opportunity, entity and customer cannot change', OLD."id"
			USING ERRCODE = 'check_violation', CONSTRAINT = 'quotations_identity_check';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "app"."quotations_guard"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "quotations_guard" BEFORE UPDATE ON "app"."quotations"
FOR EACH ROW EXECUTE FUNCTION "app"."quotations_guard"();
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------
-- The foreign keys 0015 left for this migration (S1 notes of the P2 build plan). MATCH SIMPLE: not checked while
-- the column is NULL.
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE "app"."party_accounts" ADD CONSTRAINT "party_accounts_payment_term_fk" FOREIGN KEY ("tenant_id", "payment_term_id") REFERENCES "app"."payment_terms"("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."opportunities" ADD CONSTRAINT "opportunities_won_quotation_version_fk" FOREIGN KEY ("tenant_id", "organization_id", "won_quotation_version_id") REFERENCES "app"."quotation_versions"("tenant_id", "organization_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."activities" ADD CONSTRAINT "activities_quotation_fk" FOREIGN KEY ("tenant_id", "organization_id", "quotation_id") REFERENCES "app"."quotations"("tenant_id", "organization_id", "id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------
-- Audit: every write to these tables lands in the hash chain. The tenant-level two take the acting entity.
-- ---------------------------------------------------------------------------------------------------------------
SELECT audit.attach('app.tax_codes');
--> statement-breakpoint
SELECT audit.attach('app.payment_terms');
--> statement-breakpoint
SELECT audit.attach('app.quotations');
--> statement-breakpoint
SELECT audit.attach('app.quotation_versions');
--> statement-breakpoint
SELECT audit.attach('app.quotation_lines');
--> statement-breakpoint
SELECT audit.attach('app.quotation_tax_summary');
--> statement-breakpoint
SELECT audit.attach('app.quotation_version_editors');
--> statement-breakpoint
SELECT audit.attach('app.quotation_acceptances');
--> statement-breakpoint
SELECT audit.attach('app.quotation_status_history');
