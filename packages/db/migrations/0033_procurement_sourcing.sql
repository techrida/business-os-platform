-- 0033_procurement_sourcing: the sourcing tables of P4 (plan unit S-PR1; AD10, AD12 and AD13 of the P4 plan; the
-- P4 architect's purchase-request, RFQ and quotation sketch, rewritten to the money rules of ADR 0024).
--
-- Every table here is entity-owned: tenant_id and organization_id NOT NULL, (tenant_id, organization_id) ->
-- organizations, and a FK into another entity-owned table is (tenant_id, organization_id, x). A FK into a
-- tenant-level table (users, tax_codes, vendors) is (tenant_id, x). Every table has its own uuid id (the audit
-- trigger names a changed row by it); the natural keys (an RFQ's vendor, a quotation's line) are UNIQUE keys that
-- lead with tenant_id. Money is numeric(18,2), quantities numeric(18,4), FX rates numeric(18,6), as in 0016.
--
--   * purchase_requests and purchase_request_lines: a need, raised by a requester of a department. Status is the
--     business status of PR_TRANSITIONS in @bos/contracts; the approval engine owns the workflow state
--     (approval_request_id). An emergency request must say why (AD12: it adds a Management step). The estimate
--     carries its own FX snapshot, as quotation_versions does: rate, source and date for a foreign currency, and
--     the NPR total the approval thresholds read. They are optional while the request is a draft or returned and
--     required from submit on (purchase_requests_snapshot_check). number is assigned by the service (the draft
--     reference of P3 U0-C), so it may be NULL for a draft; it is unique per entity once set.
--     purchase_request_lines_guard freezes the lines once the request leaves draft or returned (the twin of
--     quotation_children_guard in 0016).
--   * rfqs and rfq_vendors: the request for quotations. A vendor is invited only through its vendor_accounts row in
--     the same entity (rfq_vendors_vendor_account_fk), so a vendor that does not trade with the entity cannot be
--     invited and a cross-entity invitation is a foreign-key violation (23503). At most one RFQ per request is live
--     (not cancelled); a commitment that is sent back reopens that RFQ (RFQ_TRANSITIONS), it does not start a
--     second one. rfqs.recommended_quotation_id points through (tenant_id, organization_id, rfq_id, id), so an RFQ
--     can only recommend one of its own quotations (added after vendor_quotations exists: the tables reference
--     each other).
--   * vendor_quotations and vendor_quotation_lines: what a vendor quoted, recorded by Procurement (portal bidding is
--     later). A quotation hangs off rfq_vendors, so only an invited vendor can quote, once per RFQ (the count
--     of quotes for AD13 is the count of rows). purchase_request_id is repeated on the quotation and its lines so
--     that a line can only price a line of the RFQ's own request. The NPR total is the snapshot of the
--     quotation's total; tax_code_id is the tax code of the line (tenant-level, effective-dated like 0016's lines).
--   * vendor_quotation_submissions: the inbox of quotations a vendor uploaded; staff convert one into a
--     vendor_quotations row (or reject it) and it never posts anything. received -> converted | rejected |
--     withdrawn (INBOX_SUBMISSION_STATUSES). The vendor needs an account in the entity, and the converted quotation
--     must be the same vendor's.
--   * vendor_comparison_scores: the internal scores of the comparison. Never in a portal view.
--
-- Columns that point at tables that do not exist yet have no FK:
--   * purchase_requests.cost_center_id and project_id (no cost-centre or project table yet).
--
-- The vendor columns are called vendor_id, as in 0032: these tables are staff data, and vendor_party_id is the
-- portal counterparty column of check-tenancy. The inbox is the table a vendor will read; PV2 decides whether it
-- needs one.
--
-- Every table is audited (audit.attach). No GRANT: 0008's default privileges give bos_app SELECT, INSERT, UPDATE,
-- DELETE on new app tables. version is the optimistic lock where a row is edited; updated_at is set by the API.
--
-- DDL only: no row is written, so no actor context is needed. Runs as bos_owner, split at the breakpoint
-- comments (same rule as 0000). Names follow the K1-U2 convention, mirrored in src/schema/procurement.ts.

-- ---------------------------------------------------------------------------------------------------------------
-- Purchase requests
-- ---------------------------------------------------------------------------------------------------------------

-- A purchase request. requester_user_id is the staff user who raised it; department_id is the department whose head
-- approves it (AD10). estimated_total is the sum of the lines' estimated_amount (the service sums, a CHECK cannot).
-- fx_rate is NPR per unit (1 for NPR); estimated_total_npr is the NPR amount, rounded by the service.
CREATE TABLE "app"."purchase_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text,
	"request_type" text NOT NULL,
	"department_id" uuid NOT NULL,
	"requester_user_id" uuid NOT NULL,
	"cost_center_id" uuid NOT NULL,
	"justification" text NOT NULL,
	"required_by" date NOT NULL,
	"delivery_location" text,
	"budget_code" text NOT NULL,
	"project_id" uuid,
	"currency" char(3) DEFAULT 'NPR' NOT NULL,
	"estimated_total" numeric(18, 2) DEFAULT 0 NOT NULL,
	"fx_rate" numeric(18, 6),
	"fx_source" text,
	"fx_date" date,
	"estimated_total_npr" numeric(18, 2),
	"is_emergency" boolean DEFAULT false NOT NULL,
	"emergency_reason" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"approval_request_id" uuid,
	"submitted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_requests_tenant_org_id_unique" UNIQUE("tenant_id", "organization_id", "id"),
	CONSTRAINT "purchase_requests_tenant_org_number_unique" UNIQUE("tenant_id", "organization_id", "number"),
	CONSTRAINT "purchase_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "purchase_requests_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "purchase_requests_department_fk" FOREIGN KEY ("tenant_id", "organization_id", "department_id") REFERENCES "app"."departments"("tenant_id", "organization_id", "id"),
	CONSTRAINT "purchase_requests_requester_user_fk" FOREIGN KEY ("tenant_id", "requester_user_id") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "purchase_requests_approval_request_fk" FOREIGN KEY ("tenant_id", "organization_id", "approval_request_id") REFERENCES "app"."approval_requests"("tenant_id", "organization_id", "id"),
	CONSTRAINT "purchase_requests_request_type_check" CHECK ("request_type" in ('goods', 'service', 'mixed')),
	CONSTRAINT "purchase_requests_status_check" CHECK ("status" in ('draft', 'submitted', 'returned', 'dept_approved', 'sourcing', 'commitment_pending', 'approved', 'po_issued', 'closed', 'rejected', 'cancelled')),
	CONSTRAINT "purchase_requests_currency_check" CHECK ("currency" in ('NPR', 'INR', 'USD')),
	CONSTRAINT "purchase_requests_emergency_reason_check" CHECK ("is_emergency" = false OR ("emergency_reason" IS NOT NULL AND btrim("emergency_reason") <> '')),
	CONSTRAINT "purchase_requests_estimated_total_check" CHECK ("estimated_total" >= 0 AND "estimated_total_npr" >= 0),
	CONSTRAINT "purchase_requests_fx_rate_check" CHECK ("fx_rate" > 0),
	CONSTRAINT "purchase_requests_npr_snapshot_check" CHECK ("currency" <> 'NPR' OR "fx_rate" IS NULL OR ("fx_rate" = 1 AND "estimated_total_npr" = "estimated_total")),
	CONSTRAINT "purchase_requests_fx_source_check" CHECK ("currency" = 'NPR' OR "fx_rate" IS NULL OR ("fx_source" IS NOT NULL AND "fx_date" IS NOT NULL)),
	CONSTRAINT "purchase_requests_snapshot_check" CHECK ("status" IN ('draft', 'returned', 'cancelled') OR ("fx_rate" IS NOT NULL AND "estimated_total_npr" IS NOT NULL)),
	CONSTRAINT "purchase_requests_version_check" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE INDEX "purchase_requests_tenant_org_status_idx" ON "app"."purchase_requests" USING btree ("tenant_id", "organization_id", "status");
--> statement-breakpoint
CREATE INDEX "purchase_requests_tenant_requester_idx" ON "app"."purchase_requests" USING btree ("tenant_id", "requester_user_id");
--> statement-breakpoint

-- One line of a request. estimated_amount = round(quantity * estimated_unit_price, 2). (tenant_id, organization_id,
-- purchase_request_id, id) is the parent key a quotation line uses to price this line and no other request's.
CREATE TABLE "app"."purchase_request_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"purchase_request_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"description" text NOT NULL,
	"specification" text,
	"uom" text NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"estimated_unit_price" numeric(18, 2) NOT NULL,
	"estimated_amount" numeric(18, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_request_lines_tenant_org_id_unique" UNIQUE("tenant_id", "organization_id", "id"),
	CONSTRAINT "purchase_request_lines_tenant_org_pr_id_unique" UNIQUE("tenant_id", "organization_id", "purchase_request_id", "id"),
	CONSTRAINT "purchase_request_lines_tenant_pr_line_no_unique" UNIQUE("tenant_id", "purchase_request_id", "line_no"),
	CONSTRAINT "purchase_request_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "purchase_request_lines_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "purchase_request_lines_purchase_request_fk" FOREIGN KEY ("tenant_id", "organization_id", "purchase_request_id") REFERENCES "app"."purchase_requests"("tenant_id", "organization_id", "id"),
	CONSTRAINT "purchase_request_lines_line_no_check" CHECK ("line_no" >= 1),
	CONSTRAINT "purchase_request_lines_quantity_check" CHECK ("quantity" > 0),
	CONSTRAINT "purchase_request_lines_unit_price_check" CHECK ("estimated_unit_price" >= 0),
	CONSTRAINT "purchase_request_lines_amount_check" CHECK ("estimated_amount" = round("quantity" * "estimated_unit_price", 2))
);
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------
-- RFQs
-- ---------------------------------------------------------------------------------------------------------------

-- An RFQ for one request. recommended_quotation_id, fewer_than_three_reason (AD13) and recommendation_rationale are
-- written when Procurement recommends; commitment_approval_request_id is the approval request of the commitment
-- route (pr.commitment) on the recommended total. The FK of recommended_quotation_id is added below.
CREATE TABLE "app"."rfqs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"purchase_request_id" uuid NOT NULL,
	"number" text NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"recommended_quotation_id" uuid,
	"fewer_than_three_reason" text,
	"recommendation_rationale" text,
	"commitment_approval_request_id" uuid,
	"created_by" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rfqs_tenant_org_id_unique" UNIQUE("tenant_id", "organization_id", "id"),
	CONSTRAINT "rfqs_tenant_org_pr_id_unique" UNIQUE("tenant_id", "organization_id", "purchase_request_id", "id"),
	CONSTRAINT "rfqs_tenant_org_number_unique" UNIQUE("tenant_id", "organization_id", "number"),
	CONSTRAINT "rfqs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "rfqs_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "rfqs_purchase_request_fk" FOREIGN KEY ("tenant_id", "organization_id", "purchase_request_id") REFERENCES "app"."purchase_requests"("tenant_id", "organization_id", "id"),
	CONSTRAINT "rfqs_commitment_approval_request_fk" FOREIGN KEY ("tenant_id", "organization_id", "commitment_approval_request_id") REFERENCES "app"."approval_requests"("tenant_id", "organization_id", "id"),
	CONSTRAINT "rfqs_created_by_fk" FOREIGN KEY ("tenant_id", "created_by") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "rfqs_status_check" CHECK ("status" in ('open', 'closed', 'recommended', 'cancelled')),
	CONSTRAINT "rfqs_recommended_check" CHECK ("status" <> 'recommended' OR ("recommended_quotation_id" IS NOT NULL AND "recommendation_rationale" IS NOT NULL)),
	CONSTRAINT "rfqs_version_check" CHECK ("version" >= 1)
);
--> statement-breakpoint

-- At most one live RFQ per request; a cancelled one does not count.
CREATE UNIQUE INDEX "rfqs_tenant_purchase_request_live_unique" ON "app"."rfqs" USING btree ("tenant_id", "purchase_request_id") WHERE "status" <> 'cancelled';
--> statement-breakpoint
CREATE INDEX "rfqs_tenant_org_status_idx" ON "app"."rfqs" USING btree ("tenant_id", "organization_id", "status");
--> statement-breakpoint

-- A vendor invited to an RFQ. The vendor must have a vendor account in the RFQ's entity: the FK runs through
-- vendor_accounts' (tenant_id, organization_id, vendor_id) key, so a vendor with no account in this entity is a
-- 23503, whatever it has in the other entities of the tenant.
CREATE TABLE "app"."rfq_vendors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"rfq_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"invited_by" uuid NOT NULL,
	"invited_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rfq_vendors_tenant_org_rfq_vendor_unique" UNIQUE("tenant_id", "organization_id", "rfq_id", "vendor_id"),
	CONSTRAINT "rfq_vendors_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "rfq_vendors_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "rfq_vendors_rfq_fk" FOREIGN KEY ("tenant_id", "organization_id", "rfq_id") REFERENCES "app"."rfqs"("tenant_id", "organization_id", "id"),
	CONSTRAINT "rfq_vendors_vendor_account_fk" FOREIGN KEY ("tenant_id", "organization_id", "vendor_id") REFERENCES "app"."vendor_accounts"("tenant_id", "organization_id", "vendor_id"),
	CONSTRAINT "rfq_vendors_invited_by_fk" FOREIGN KEY ("tenant_id", "invited_by") REFERENCES "app"."users"("tenant_id", "id")
);
--> statement-breakpoint
CREATE INDEX "rfq_vendors_tenant_org_vendor_idx" ON "app"."rfq_vendors" USING btree ("tenant_id", "organization_id", "vendor_id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------
-- Vendor quotations
-- ---------------------------------------------------------------------------------------------------------------

-- A quotation of an invited vendor, recorded by Procurement from the vendor's document. subtotal + tax_amount =
-- total, all in the vendor's currency; fx_rate is NPR per unit (1 for NPR) with its source and date for a foreign
-- currency, and total_npr is the NPR amount (rounded by the service) the commitment route's bands read.
-- One quotation per vendor per RFQ. purchase_request_id must be the RFQ's own (vendor_quotations_rfq_fk).
CREATE TABLE "app"."vendor_quotations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"rfq_id" uuid NOT NULL,
	"purchase_request_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"vendor_ref" text,
	"valid_until" date,
	"currency" char(3) NOT NULL,
	"subtotal" numeric(18, 2) NOT NULL,
	"tax_amount" numeric(18, 2) NOT NULL,
	"total" numeric(18, 2) NOT NULL,
	"fx_rate" numeric(18, 6) NOT NULL,
	"fx_source" text,
	"fx_date" date,
	"total_npr" numeric(18, 2) NOT NULL,
	"delivery_days" integer,
	"warranty" text,
	"terms" text,
	"document_id" uuid NOT NULL,
	"recorded_by" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_quotations_tenant_org_id_unique" UNIQUE("tenant_id", "organization_id", "id"),
	CONSTRAINT "vendor_quotations_tenant_org_rfq_id_unique" UNIQUE("tenant_id", "organization_id", "rfq_id", "id"),
	CONSTRAINT "vendor_quotations_tenant_org_pr_id_unique" UNIQUE("tenant_id", "organization_id", "purchase_request_id", "id"),
	CONSTRAINT "vendor_quotations_tenant_org_vendor_id_unique" UNIQUE("tenant_id", "organization_id", "vendor_id", "id"),
	CONSTRAINT "vendor_quotations_tenant_org_rfq_vendor_unique" UNIQUE("tenant_id", "organization_id", "rfq_id", "vendor_id"),
	CONSTRAINT "vendor_quotations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "vendor_quotations_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "vendor_quotations_rfq_fk" FOREIGN KEY ("tenant_id", "organization_id", "purchase_request_id", "rfq_id") REFERENCES "app"."rfqs"("tenant_id", "organization_id", "purchase_request_id", "id"),
	CONSTRAINT "vendor_quotations_rfq_vendor_fk" FOREIGN KEY ("tenant_id", "organization_id", "rfq_id", "vendor_id") REFERENCES "app"."rfq_vendors"("tenant_id", "organization_id", "rfq_id", "vendor_id"),
	CONSTRAINT "vendor_quotations_document_fk" FOREIGN KEY ("tenant_id", "organization_id", "document_id") REFERENCES "app"."documents"("tenant_id", "organization_id", "id"),
	CONSTRAINT "vendor_quotations_recorded_by_fk" FOREIGN KEY ("tenant_id", "recorded_by") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "vendor_quotations_currency_check" CHECK ("currency" in ('NPR', 'INR', 'USD')),
	CONSTRAINT "vendor_quotations_amounts_check" CHECK ("subtotal" >= 0 AND "tax_amount" >= 0 AND "total_npr" >= 0),
	CONSTRAINT "vendor_quotations_total_check" CHECK ("total" = "subtotal" + "tax_amount"),
	CONSTRAINT "vendor_quotations_fx_rate_check" CHECK ("fx_rate" > 0),
	CONSTRAINT "vendor_quotations_npr_snapshot_check" CHECK ("currency" <> 'NPR' OR ("fx_rate" = 1 AND "total_npr" = "total")),
	CONSTRAINT "vendor_quotations_fx_source_check" CHECK ("currency" = 'NPR' OR ("fx_source" IS NOT NULL AND "fx_date" IS NOT NULL)),
	CONSTRAINT "vendor_quotations_delivery_days_check" CHECK ("delivery_days" >= 0),
	CONSTRAINT "vendor_quotations_version_check" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE INDEX "vendor_quotations_tenant_org_vendor_idx" ON "app"."vendor_quotations" USING btree ("tenant_id", "organization_id", "vendor_id");
--> statement-breakpoint

-- The RFQ's half of the cycle: the recommended quotation must be one of this RFQ's quotations.
-- MATCH SIMPLE: not checked while recommended_quotation_id is NULL.
ALTER TABLE "app"."rfqs" ADD CONSTRAINT "rfqs_recommended_quotation_fk" FOREIGN KEY ("tenant_id", "organization_id", "id", "recommended_quotation_id") REFERENCES "app"."vendor_quotations"("tenant_id", "organization_id", "rfq_id", "id");
--> statement-breakpoint

-- What a vendor quoted for one line of the request. gross = round(quantity * unit_price, 2); line_total = gross +
-- tax_amount. The service computes tax_amount from the tax code's rate (the tax code row is effective-dated).
CREATE TABLE "app"."vendor_quotation_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"vendor_quotation_id" uuid NOT NULL,
	"purchase_request_id" uuid NOT NULL,
	"pr_line_id" uuid NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"unit_price" numeric(18, 2) NOT NULL,
	"tax_code_id" uuid NOT NULL,
	"gross" numeric(18, 2) NOT NULL,
	"tax_amount" numeric(18, 2) NOT NULL,
	"line_total" numeric(18, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_quotation_lines_tenant_org_id_unique" UNIQUE("tenant_id", "organization_id", "id"),
	CONSTRAINT "vendor_quotation_lines_tenant_quotation_pr_line_unique" UNIQUE("tenant_id", "vendor_quotation_id", "pr_line_id"),
	CONSTRAINT "vendor_quotation_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "vendor_quotation_lines_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "vendor_quotation_lines_quotation_fk" FOREIGN KEY ("tenant_id", "organization_id", "purchase_request_id", "vendor_quotation_id") REFERENCES "app"."vendor_quotations"("tenant_id", "organization_id", "purchase_request_id", "id"),
	CONSTRAINT "vendor_quotation_lines_pr_line_fk" FOREIGN KEY ("tenant_id", "organization_id", "purchase_request_id", "pr_line_id") REFERENCES "app"."purchase_request_lines"("tenant_id", "organization_id", "purchase_request_id", "id"),
	CONSTRAINT "vendor_quotation_lines_tax_code_fk" FOREIGN KEY ("tenant_id", "tax_code_id") REFERENCES "app"."tax_codes"("tenant_id", "id"),
	CONSTRAINT "vendor_quotation_lines_quantity_check" CHECK ("quantity" > 0),
	CONSTRAINT "vendor_quotation_lines_unit_price_check" CHECK ("unit_price" >= 0),
	CONSTRAINT "vendor_quotation_lines_gross_check" CHECK ("gross" = round("quantity" * "unit_price", 2)),
	CONSTRAINT "vendor_quotation_lines_tax_amount_check" CHECK ("tax_amount" >= 0),
	CONSTRAINT "vendor_quotation_lines_line_total_check" CHECK ("line_total" = "gross" + "tax_amount")
);
--> statement-breakpoint
CREATE INDEX "vendor_quotation_lines_tenant_tax_code_idx" ON "app"."vendor_quotation_lines" USING btree ("tenant_id", "tax_code_id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------
-- The portal inbox and the comparison
-- ---------------------------------------------------------------------------------------------------------------

-- A quotation a vendor uploaded, waiting for Procurement. submitted_by is the vendor's portal user; rfq_id is NULL
-- for an upload that names no RFQ (then the FK to rfq_vendors is not checked: MATCH SIMPLE). A converted submission
-- names the quotation it became, which must be the same vendor's; a rejected one names its reason; both name the
-- staff reviewer.
CREATE TABLE "app"."vendor_quotation_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"rfq_id" uuid,
	"submitted_by" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"vendor_ref" text,
	"note" text,
	"status" text DEFAULT 'received' NOT NULL,
	"converted_quotation_id" uuid,
	"rejection_reason" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_quotation_submissions_tenant_org_id_unique" UNIQUE("tenant_id", "organization_id", "id"),
	CONSTRAINT "vendor_quotation_submissions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "vendor_quotation_submissions_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "vendor_quotation_submissions_vendor_account_fk" FOREIGN KEY ("tenant_id", "organization_id", "vendor_id") REFERENCES "app"."vendor_accounts"("tenant_id", "organization_id", "vendor_id"),
	CONSTRAINT "vendor_quotation_submissions_rfq_vendor_fk" FOREIGN KEY ("tenant_id", "organization_id", "rfq_id", "vendor_id") REFERENCES "app"."rfq_vendors"("tenant_id", "organization_id", "rfq_id", "vendor_id"),
	CONSTRAINT "vendor_quotation_submissions_submitted_by_fk" FOREIGN KEY ("tenant_id", "submitted_by") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "vendor_quotation_submissions_document_fk" FOREIGN KEY ("tenant_id", "organization_id", "document_id") REFERENCES "app"."documents"("tenant_id", "organization_id", "id"),
	CONSTRAINT "vendor_quotation_submissions_converted_quotation_fk" FOREIGN KEY ("tenant_id", "organization_id", "vendor_id", "converted_quotation_id") REFERENCES "app"."vendor_quotations"("tenant_id", "organization_id", "vendor_id", "id"),
	CONSTRAINT "vendor_quotation_submissions_reviewed_by_fk" FOREIGN KEY ("tenant_id", "reviewed_by") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "vendor_quotation_submissions_status_check" CHECK ("status" in ('received', 'converted', 'rejected', 'withdrawn')),
	CONSTRAINT "vendor_quotation_submissions_converted_check" CHECK (("status" = 'converted') = ("converted_quotation_id" IS NOT NULL)),
	CONSTRAINT "vendor_quotation_submissions_rejected_check" CHECK ("status" <> 'rejected' OR ("rejection_reason" IS NOT NULL AND btrim("rejection_reason") <> '')),
	CONSTRAINT "vendor_quotation_submissions_reviewed_check" CHECK ("status" NOT IN ('converted', 'rejected') OR "reviewed_by" IS NOT NULL),
	CONSTRAINT "vendor_quotation_submissions_version_check" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE INDEX "vendor_quotation_submissions_tenant_org_status_idx" ON "app"."vendor_quotation_submissions" USING btree ("tenant_id", "organization_id", "status");
--> statement-breakpoint
CREATE INDEX "vendor_quotation_submissions_tenant_org_vendor_idx" ON "app"."vendor_quotation_submissions" USING btree ("tenant_id", "organization_id", "vendor_id");
--> statement-breakpoint

-- One internal score of one criterion of a quotation (0 to 100). Never in a portal view.
CREATE TABLE "app"."vendor_comparison_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"vendor_quotation_id" uuid NOT NULL,
	"criterion" text NOT NULL,
	"score" numeric(5, 2) NOT NULL,
	"comment" text,
	"scored_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_comparison_scores_tenant_quotation_criterion_unique" UNIQUE("tenant_id", "vendor_quotation_id", "criterion"),
	CONSTRAINT "vendor_comparison_scores_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "vendor_comparison_scores_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "vendor_comparison_scores_quotation_fk" FOREIGN KEY ("tenant_id", "organization_id", "vendor_quotation_id") REFERENCES "app"."vendor_quotations"("tenant_id", "organization_id", "id"),
	CONSTRAINT "vendor_comparison_scores_scored_by_fk" FOREIGN KEY ("tenant_id", "scored_by") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "vendor_comparison_scores_criterion_check" CHECK (btrim("criterion") <> ''),
	CONSTRAINT "vendor_comparison_scores_score_check" CHECK ("score" BETWEEN 0 AND 100)
);
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------
-- Freeze trigger. The service checks the status first; this refuses what slips past it.
-- Not SECURITY DEFINER: it reads only rows the writing role may read already. The error is check_violation with
-- the named pseudo-constraint, as 0016 does.
-- ---------------------------------------------------------------------------------------------------------------

-- purchase_request_lines: any INSERT, UPDATE or DELETE needs the parent request (the OLD and the NEW one) in draft
-- or returned. FOR SHARE locks the parent row, so a concurrent submit waits for this write to commit instead of
-- snapshotting lines that are about to change. A missing parent is left to the foreign key.
CREATE FUNCTION "app"."purchase_request_lines_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
	v_status text;
BEGIN
	IF TG_OP IN ('UPDATE', 'DELETE') THEN
		SELECT p."status" INTO v_status FROM "app"."purchase_requests" p
		 WHERE p."tenant_id" = OLD."tenant_id" AND p."id" = OLD."purchase_request_id" FOR SHARE;
		IF v_status NOT IN ('draft', 'returned') THEN
			RAISE EXCEPTION '%: purchase request % is % and its lines are frozen', TG_TABLE_NAME, OLD."purchase_request_id", v_status
				USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_frozen_check';
		END IF;
	END IF;
	IF TG_OP IN ('INSERT', 'UPDATE') THEN
		SELECT p."status" INTO v_status FROM "app"."purchase_requests" p
		 WHERE p."tenant_id" = NEW."tenant_id" AND p."id" = NEW."purchase_request_id" FOR SHARE;
		IF v_status NOT IN ('draft', 'returned') THEN
			RAISE EXCEPTION '%: purchase request % is % and its lines are frozen', TG_TABLE_NAME, NEW."purchase_request_id", v_status
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
REVOKE EXECUTE ON FUNCTION "app"."purchase_request_lines_guard"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "purchase_request_lines_guard" BEFORE INSERT OR UPDATE OR DELETE ON "app"."purchase_request_lines"
FOR EACH ROW EXECUTE FUNCTION "app"."purchase_request_lines_guard"();
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------
-- Audit: every write to these tables lands in the hash chain.
-- ---------------------------------------------------------------------------------------------------------------
SELECT audit.attach('app.purchase_requests');
--> statement-breakpoint
SELECT audit.attach('app.purchase_request_lines');
--> statement-breakpoint
SELECT audit.attach('app.rfqs');
--> statement-breakpoint
SELECT audit.attach('app.rfq_vendors');
--> statement-breakpoint
SELECT audit.attach('app.vendor_quotations');
--> statement-breakpoint
SELECT audit.attach('app.vendor_quotation_lines');
--> statement-breakpoint
SELECT audit.attach('app.vendor_quotation_submissions');
--> statement-breakpoint
SELECT audit.attach('app.vendor_comparison_scores');
