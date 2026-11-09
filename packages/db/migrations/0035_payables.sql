-- 0035_payables: the payables tables of P4 (plan unit S-AP; AD1, AD5, AD6 and AD14 of the P4 plan, with its
-- Reconciliation section; done checks 8, 9, 10 and 12). Vendor bills and their lines, the portal bill inbox, the
-- three-way match results and match exceptions, and payment requests (AD1: the approved instruction, never the
-- payout). Money is numeric(18,2), quantities numeric(18,4), FX rates numeric(18,6), as in 0016 and 0034.
--
-- Every table here is entity-owned: tenant_id and organization_id NOT NULL, (tenant_id, organization_id) ->
-- organizations, and a FK into another entity-owned table is (tenant_id, organization_id, x). A FK into a
-- tenant-level table (users, parties, tax_codes, withholding_codes, vendor_bank_accounts) is (tenant_id, x).
--
--   * withholding_codes is P3's (0019, tenant-level, effective-dated, applies_to receivable/payable/both). This file
--     does not create it; it only adds the FK that 0032 left out on vendor_accounts.default_withholding_code_id. A
--     code id names one effective period of a code, as tax_codes ids do.
--   * vendor_bills: one bill (or vendor credit note) of a vendor that has an account in the bill's entity
--     (vendor_bills_vendor_account_fk). purchase_order_id is optional (a non-PO bill is allowed, AD5) and, when set,
--     is a PO of the same vendor and entity (vendor_bills_purchase_order_fk). invoice_no_norm is generated from the
--     vendor's invoice number: upper case, spaces, hyphens and slashes removed, so INV-001, inv 001 and INV/001 are
--     one number; vendor_bills_tenant_org_vendor_invoice_fy_unique refuses the second (check 8, 23505). fiscal_year
--     is the fiscal year of the invoice date (the dedup key), not of the BILL number. The totals are what the
--     service computed from the lines; vendor_bills_payable_check holds payable = net + vat - tds. TDS is computed
--     at approval on net excluding VAT (AD14) from withholding_code_id. payable_total_npr with fx_rate is the NPR
--     snapshot. status is BILL_STATUSES of @bos/contracts (payables.ts) and match_status MATCH_STATUSES. There is no
--     paid or balance column (check 10): what is still owed is open_item_balances of the bill's payable open item
--     (P3's ledger, written only by LedgerService).
--   * vendor_bill_submissions: the portal inbox of bills a vendor uploaded (received, converted, rejected,
--     withdrawn), as vendor_quotation_submissions in 0033. vendor_party_id is the portal counterparty column of
--     check-tenancy: nullable uuid, a FK to parties that checks the kind, a tenant-leading index; it must also be a
--     vendor with an account in the entity (vendor_bill_submissions_vendor_account_fk). Nullable as the rule
--     requires; a row without it is visible to no vendor (fails closed). A converted submission names the bill it
--     became, which is the same vendor's when the vendor is set.
--   * vendor_bill_lines: one line of a bill. Its FK to the bill (tenant, organization, bill) is always checked; a
--     line that links to a PO repeats purchase_order_id, which must be the bill's own PO
--     (vendor_bill_lines_bill_po_fk), po_line_id must be a line of that PO in the same entity
--     (vendor_bill_lines_po_line_fk: a PO line of another entity is a 23503, check 12) and receipt_line_id a receipt
--     line of that PO line. A PO line needs its PO, and a receipt line its PO line (CHECKs), because a composite FK
--     with a NULL column is not checked (MATCH SIMPLE). A line with no PO link is a non-PO line.
--   * match_results: one row per bill line per match run (run_no): the quantities, the variances and whether the
--     line is within tolerance (AD6: 0% over on quantity, the lower of 2% and NPR 500 on price, tax to the paisa;
--     the tolerances used are snapshotted). The latest run counts; the service writes it.
--   * match_exceptions: a request to accept a bill outside tolerance. Finance decides (AD5); the decider is never
--     the requester (match_exceptions_approver_check). One pending exception per bill.
--   * payment_requests and payment_request_lines: a request to pay a vendor (settlement or advance; an advance names
--     its PO). Each line takes an amount > 0 of a payable open item of the same entity. The vendor's active verified
--     bank account is snapshotted as its id and last 4 digits; no account number is stored here. That the account is
--     this vendor's active one, that the open item is this vendor's, and that a line stays within the derived open
--     amount are the service's rules (A2).
--   * v_po_line_progress: per PO line, ordered, cancelled, received (confirmed receipts, net of reversals; drafts
--     left out) and billed (bills that are not voided or rejected, credit notes negative).
--
-- Columns that point at tables that do not exist yet have no FK: vendor_bill_lines.account_id, cost_center_id and
-- project_id (no chart of accounts, AD1), payment_requests.from_bank_account_id (no entity bank accounts table yet).
--
-- Every table is audited (audit.attach). No GRANT: 0008's default privileges give bos_app SELECT, INSERT, UPDATE,
-- DELETE on new app tables. version is the optimistic lock where a row is edited; updated_at is set by the API.
--
-- DDL only: no row is written, so no actor context is needed. Runs as bos_owner, split at the breakpoint
-- comments (same rule as 0000). Names follow the K1-U2 convention, mirrored in src/schema/payables.ts.

-- ---------------------------------------------------------------------------------------------------------------
-- The vendor account's default withholding code (0032 left the FK to S-AP)
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE "app"."vendor_accounts" ADD CONSTRAINT "vendor_accounts_default_withholding_code_fk" FOREIGN KEY ("tenant_id", "default_withholding_code_id") REFERENCES "app"."withholding_codes"("tenant_id", "id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------
-- Vendor bills
-- ---------------------------------------------------------------------------------------------------------------

-- A vendor bill. number is the BILL series number, set when the bill is numbered. A voided bill names who voided it,
-- when and why (the ledger side of a void is P3's vendor_debit_note).
CREATE TABLE "app"."vendor_bills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text DEFAULT 'bill' NOT NULL,
	"number" text,
	"vendor_id" uuid NOT NULL,
	"vendor_invoice_no" text NOT NULL,
	"invoice_no_norm" text GENERATED ALWAYS AS (upper(regexp_replace("vendor_invoice_no", '[[:space:]/-]', '', 'g'))) STORED,
	"invoice_date" date NOT NULL,
	"due_date" date,
	"fiscal_year" text NOT NULL,
	"currency" char(3) NOT NULL,
	"purchase_order_id" uuid,
	"document_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"match_status" text DEFAULT 'pending' NOT NULL,
	"net_total" numeric(18, 2) DEFAULT 0 NOT NULL,
	"vat_total" numeric(18, 2) DEFAULT 0 NOT NULL,
	"tds_total" numeric(18, 2) DEFAULT 0 NOT NULL,
	"payable_total" numeric(18, 2) DEFAULT 0 NOT NULL,
	"withholding_code_id" uuid,
	"fx_rate" numeric(18, 6) NOT NULL,
	"fx_source" text,
	"fx_date" date,
	"payable_total_npr" numeric(18, 2) NOT NULL,
	"entered_by" uuid NOT NULL,
	"approval_request_id" uuid,
	"voided_by" uuid,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_bills_tenant_org_id_unique" UNIQUE("tenant_id", "organization_id", "id"),
	CONSTRAINT "vendor_bills_tenant_org_id_po_unique" UNIQUE("tenant_id", "organization_id", "id", "purchase_order_id"),
	CONSTRAINT "vendor_bills_tenant_org_vendor_id_unique" UNIQUE("tenant_id", "organization_id", "vendor_id", "id"),
	CONSTRAINT "vendor_bills_tenant_org_number_unique" UNIQUE("tenant_id", "organization_id", "number"),
	CONSTRAINT "vendor_bills_tenant_org_vendor_invoice_fy_unique" UNIQUE("tenant_id", "organization_id", "vendor_id", "invoice_no_norm", "fiscal_year"),
	CONSTRAINT "vendor_bills_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "vendor_bills_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "vendor_bills_vendor_account_fk" FOREIGN KEY ("tenant_id", "organization_id", "vendor_id") REFERENCES "app"."vendor_accounts"("tenant_id", "organization_id", "vendor_id"),
	CONSTRAINT "vendor_bills_purchase_order_fk" FOREIGN KEY ("tenant_id", "organization_id", "vendor_id", "purchase_order_id") REFERENCES "app"."purchase_orders"("tenant_id", "organization_id", "vendor_id", "id"),
	CONSTRAINT "vendor_bills_document_fk" FOREIGN KEY ("tenant_id", "organization_id", "document_id") REFERENCES "app"."documents"("tenant_id", "organization_id", "id"),
	CONSTRAINT "vendor_bills_withholding_code_fk" FOREIGN KEY ("tenant_id", "withholding_code_id") REFERENCES "app"."withholding_codes"("tenant_id", "id"),
	CONSTRAINT "vendor_bills_entered_by_fk" FOREIGN KEY ("tenant_id", "entered_by") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "vendor_bills_approval_request_fk" FOREIGN KEY ("tenant_id", "organization_id", "approval_request_id") REFERENCES "app"."approval_requests"("tenant_id", "organization_id", "id"),
	CONSTRAINT "vendor_bills_voided_by_fk" FOREIGN KEY ("tenant_id", "voided_by") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "vendor_bills_kind_check" CHECK ("kind" in ('bill', 'vendor_credit_note')),
	CONSTRAINT "vendor_bills_status_check" CHECK ("status" in ('draft', 'matching', 'variance', 'exception_pending', 'pending_approval', 'approved', 'partially_paid', 'paid', 'voided', 'rejected')),
	CONSTRAINT "vendor_bills_match_status_check" CHECK ("match_status" in ('not_required', 'pending', 'matched', 'variance', 'exception_approved')),
	CONSTRAINT "vendor_bills_currency_check" CHECK ("currency" in ('NPR', 'INR', 'USD')),
	CONSTRAINT "vendor_bills_invoice_no_check" CHECK ("invoice_no_norm" <> ''),
	CONSTRAINT "vendor_bills_totals_check" CHECK ("net_total" >= 0 AND "vat_total" >= 0 AND "tds_total" >= 0 AND "payable_total" >= 0 AND "payable_total_npr" >= 0),
	CONSTRAINT "vendor_bills_payable_check" CHECK ("payable_total" = "net_total" + "vat_total" - "tds_total"),
	CONSTRAINT "vendor_bills_tds_code_check" CHECK ("tds_total" = 0 OR "withholding_code_id" IS NOT NULL),
	CONSTRAINT "vendor_bills_fx_rate_check" CHECK ("fx_rate" > 0),
	CONSTRAINT "vendor_bills_npr_snapshot_check" CHECK ("currency" <> 'NPR' OR ("fx_rate" = 1 AND "payable_total_npr" = "payable_total")),
	CONSTRAINT "vendor_bills_fx_source_check" CHECK ("currency" = 'NPR' OR ("fx_source" IS NOT NULL AND "fx_date" IS NOT NULL)),
	CONSTRAINT "vendor_bills_due_date_check" CHECK ("due_date" IS NULL OR "due_date" >= "invoice_date"),
	CONSTRAINT "vendor_bills_voided_check" CHECK ("status" <> 'voided' OR ("voided_by" IS NOT NULL AND "voided_at" IS NOT NULL AND "void_reason" IS NOT NULL AND btrim("void_reason") <> '')),
	CONSTRAINT "vendor_bills_version_check" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE INDEX "vendor_bills_tenant_org_status_idx" ON "app"."vendor_bills" USING btree ("tenant_id", "organization_id", "status");
--> statement-breakpoint
CREATE INDEX "vendor_bills_tenant_org_po_idx" ON "app"."vendor_bills" USING btree ("tenant_id", "organization_id", "purchase_order_id");
--> statement-breakpoint

-- A bill a vendor uploaded through the portal, waiting for staff. submitted_by is the vendor's portal user;
-- purchase_order_id is the PO the vendor named, if any (the vendor's own, in this entity). A converted submission
-- names the bill it became; a rejected one names its reason; both name the staff reviewer.
CREATE TABLE "app"."vendor_bill_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"vendor_party_id" uuid,
	"vendor_party_kind" text GENERATED ALWAYS AS ('vendor') STORED,
	"purchase_order_id" uuid,
	"submitted_by" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"vendor_invoice_no" text,
	"invoice_date" date,
	"note" text,
	"status" text DEFAULT 'received' NOT NULL,
	"converted_bill_id" uuid,
	"rejection_reason" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_bill_submissions_tenant_org_id_unique" UNIQUE("tenant_id", "organization_id", "id"),
	CONSTRAINT "vendor_bill_submissions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "vendor_bill_submissions_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "vendor_bill_submissions_vendor_party_fk" FOREIGN KEY ("tenant_id", "vendor_party_id", "vendor_party_kind") REFERENCES "app"."parties"("tenant_id", "id", "kind"),
	CONSTRAINT "vendor_bill_submissions_vendor_account_fk" FOREIGN KEY ("tenant_id", "organization_id", "vendor_party_id") REFERENCES "app"."vendor_accounts"("tenant_id", "organization_id", "vendor_id"),
	CONSTRAINT "vendor_bill_submissions_purchase_order_fk" FOREIGN KEY ("tenant_id", "organization_id", "vendor_party_id", "purchase_order_id") REFERENCES "app"."purchase_orders"("tenant_id", "organization_id", "vendor_id", "id"),
	CONSTRAINT "vendor_bill_submissions_submitted_by_fk" FOREIGN KEY ("tenant_id", "submitted_by") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "vendor_bill_submissions_document_fk" FOREIGN KEY ("tenant_id", "organization_id", "document_id") REFERENCES "app"."documents"("tenant_id", "organization_id", "id"),
	CONSTRAINT "vendor_bill_submissions_converted_bill_fk" FOREIGN KEY ("tenant_id", "organization_id", "converted_bill_id") REFERENCES "app"."vendor_bills"("tenant_id", "organization_id", "id"),
	CONSTRAINT "vendor_bill_submissions_converted_bill_vendor_fk" FOREIGN KEY ("tenant_id", "organization_id", "vendor_party_id", "converted_bill_id") REFERENCES "app"."vendor_bills"("tenant_id", "organization_id", "vendor_id", "id"),
	CONSTRAINT "vendor_bill_submissions_reviewed_by_fk" FOREIGN KEY ("tenant_id", "reviewed_by") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "vendor_bill_submissions_status_check" CHECK ("status" in ('received', 'converted', 'rejected', 'withdrawn')),
	CONSTRAINT "vendor_bill_submissions_converted_check" CHECK (("status" = 'converted') = ("converted_bill_id" IS NOT NULL)),
	CONSTRAINT "vendor_bill_submissions_rejected_check" CHECK ("status" <> 'rejected' OR ("rejection_reason" IS NOT NULL AND btrim("rejection_reason") <> '')),
	CONSTRAINT "vendor_bill_submissions_reviewed_check" CHECK ("status" NOT IN ('converted', 'rejected') OR "reviewed_by" IS NOT NULL),
	CONSTRAINT "vendor_bill_submissions_version_check" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE INDEX "vendor_bill_submissions_tenant_vendor_party_idx" ON "app"."vendor_bill_submissions" USING btree ("tenant_id", "vendor_party_id");
--> statement-breakpoint
CREATE INDEX "vendor_bill_submissions_tenant_org_status_idx" ON "app"."vendor_bill_submissions" USING btree ("tenant_id", "organization_id", "status");
--> statement-breakpoint

-- One line of a bill. net_amount = round(quantity * unit_price, 2); vat_amount comes from the tax code and
-- tds_amount from the withholding code (the service computes both). See the header for the PO links.
CREATE TABLE "app"."vendor_bill_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"vendor_bill_id" uuid NOT NULL,
	"purchase_order_id" uuid,
	"po_line_id" uuid,
	"receipt_line_id" uuid,
	"line_no" integer NOT NULL,
	"description" text NOT NULL,
	"account_id" uuid NOT NULL,
	"cost_center_id" uuid,
	"project_id" uuid,
	"quantity" numeric(18, 4) NOT NULL,
	"unit_price" numeric(18, 2) NOT NULL,
	"net_amount" numeric(18, 2) NOT NULL,
	"tax_code_id" uuid NOT NULL,
	"vat_amount" numeric(18, 2) NOT NULL,
	"withholding_code_id" uuid,
	"tds_amount" numeric(18, 2) DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_bill_lines_tenant_org_id_unique" UNIQUE("tenant_id", "organization_id", "id"),
	CONSTRAINT "vendor_bill_lines_tenant_org_bill_id_unique" UNIQUE("tenant_id", "organization_id", "vendor_bill_id", "id"),
	CONSTRAINT "vendor_bill_lines_tenant_bill_line_no_unique" UNIQUE("tenant_id", "vendor_bill_id", "line_no"),
	CONSTRAINT "vendor_bill_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "vendor_bill_lines_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "vendor_bill_lines_bill_fk" FOREIGN KEY ("tenant_id", "organization_id", "vendor_bill_id") REFERENCES "app"."vendor_bills"("tenant_id", "organization_id", "id"),
	CONSTRAINT "vendor_bill_lines_bill_po_fk" FOREIGN KEY ("tenant_id", "organization_id", "vendor_bill_id", "purchase_order_id") REFERENCES "app"."vendor_bills"("tenant_id", "organization_id", "id", "purchase_order_id"),
	CONSTRAINT "vendor_bill_lines_po_line_fk" FOREIGN KEY ("tenant_id", "organization_id", "purchase_order_id", "po_line_id") REFERENCES "app"."purchase_order_lines"("tenant_id", "organization_id", "purchase_order_id", "id"),
	CONSTRAINT "vendor_bill_lines_receipt_line_fk" FOREIGN KEY ("tenant_id", "organization_id", "po_line_id", "receipt_line_id") REFERENCES "app"."receipt_lines"("tenant_id", "organization_id", "po_line_id", "id"),
	CONSTRAINT "vendor_bill_lines_tax_code_fk" FOREIGN KEY ("tenant_id", "tax_code_id") REFERENCES "app"."tax_codes"("tenant_id", "id"),
	CONSTRAINT "vendor_bill_lines_withholding_code_fk" FOREIGN KEY ("tenant_id", "withholding_code_id") REFERENCES "app"."withholding_codes"("tenant_id", "id"),
	CONSTRAINT "vendor_bill_lines_line_no_check" CHECK ("line_no" >= 1),
	CONSTRAINT "vendor_bill_lines_quantity_check" CHECK ("quantity" > 0),
	CONSTRAINT "vendor_bill_lines_unit_price_check" CHECK ("unit_price" >= 0),
	CONSTRAINT "vendor_bill_lines_net_amount_check" CHECK ("net_amount" = round("quantity" * "unit_price", 2)),
	CONSTRAINT "vendor_bill_lines_vat_amount_check" CHECK ("vat_amount" >= 0),
	CONSTRAINT "vendor_bill_lines_tds_amount_check" CHECK ("tds_amount" >= 0 AND ("tds_amount" = 0 OR "withholding_code_id" IS NOT NULL)),
	CONSTRAINT "vendor_bill_lines_po_link_check" CHECK ("po_line_id" IS NULL OR "purchase_order_id" IS NOT NULL),
	CONSTRAINT "vendor_bill_lines_receipt_link_check" CHECK ("receipt_line_id" IS NULL OR "po_line_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX "vendor_bill_lines_tenant_org_po_line_idx" ON "app"."vendor_bill_lines" USING btree ("tenant_id", "organization_id", "po_line_id");
--> statement-breakpoint
CREATE INDEX "vendor_bill_lines_tenant_tax_code_idx" ON "app"."vendor_bill_lines" USING btree ("tenant_id", "tax_code_id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------
-- Matching (AD6)
-- ---------------------------------------------------------------------------------------------------------------

-- The match of one bill line in one run. The variances are bill minus PO/receipt (quantity over what was received,
-- price over the PO price, tax over the expected tax); within_tolerance says whether the line passed, and status
-- repeats it. price_tolerance_bp and price_tolerance_amount are the tolerances the run used (from settings).
CREATE TABLE "app"."match_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"vendor_bill_id" uuid NOT NULL,
	"vendor_bill_line_id" uuid NOT NULL,
	"po_line_id" uuid,
	"run_no" integer NOT NULL,
	"status" text NOT NULL,
	"ordered_quantity" numeric(18, 4),
	"received_quantity" numeric(18, 4),
	"billed_quantity" numeric(18, 4) NOT NULL,
	"quantity_variance" numeric(18, 4) DEFAULT 0 NOT NULL,
	"price_variance" numeric(18, 2) DEFAULT 0 NOT NULL,
	"tax_variance" numeric(18, 2) DEFAULT 0 NOT NULL,
	"within_tolerance" boolean NOT NULL,
	"price_tolerance_bp" integer NOT NULL,
	"price_tolerance_amount" numeric(18, 2) NOT NULL,
	"matched_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "match_results_tenant_line_run_unique" UNIQUE("tenant_id", "vendor_bill_line_id", "run_no"),
	CONSTRAINT "match_results_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "match_results_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "match_results_bill_line_fk" FOREIGN KEY ("tenant_id", "organization_id", "vendor_bill_id", "vendor_bill_line_id") REFERENCES "app"."vendor_bill_lines"("tenant_id", "organization_id", "vendor_bill_id", "id"),
	CONSTRAINT "match_results_po_line_fk" FOREIGN KEY ("tenant_id", "organization_id", "po_line_id") REFERENCES "app"."purchase_order_lines"("tenant_id", "organization_id", "id"),
	CONSTRAINT "match_results_matched_by_fk" FOREIGN KEY ("tenant_id", "matched_by") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "match_results_status_check" CHECK ("status" in ('matched', 'variance')),
	CONSTRAINT "match_results_run_no_check" CHECK ("run_no" >= 1),
	CONSTRAINT "match_results_status_tolerance_check" CHECK (("status" = 'matched') = "within_tolerance"),
	CONSTRAINT "match_results_tolerance_check" CHECK ("price_tolerance_bp" BETWEEN 0 AND 10000 AND "price_tolerance_amount" >= 0)
);
--> statement-breakpoint
CREATE INDEX "match_results_tenant_org_bill_idx" ON "app"."match_results" USING btree ("tenant_id", "organization_id", "vendor_bill_id");
--> statement-breakpoint

-- A request to accept a bill outside tolerance (AD5: Finance decides through the approval engine). A decided
-- exception names who decided and when; the decider is never the requester.
CREATE TABLE "app"."match_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"vendor_bill_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"evidence_document_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" uuid NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"approval_request_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "match_exceptions_tenant_org_id_unique" UNIQUE("tenant_id", "organization_id", "id"),
	CONSTRAINT "match_exceptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "match_exceptions_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "match_exceptions_bill_fk" FOREIGN KEY ("tenant_id", "organization_id", "vendor_bill_id") REFERENCES "app"."vendor_bills"("tenant_id", "organization_id", "id"),
	CONSTRAINT "match_exceptions_evidence_document_fk" FOREIGN KEY ("tenant_id", "organization_id", "evidence_document_id") REFERENCES "app"."documents"("tenant_id", "organization_id", "id"),
	CONSTRAINT "match_exceptions_requested_by_fk" FOREIGN KEY ("tenant_id", "requested_by") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "match_exceptions_decided_by_fk" FOREIGN KEY ("tenant_id", "decided_by") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "match_exceptions_approval_request_fk" FOREIGN KEY ("tenant_id", "organization_id", "approval_request_id") REFERENCES "app"."approval_requests"("tenant_id", "organization_id", "id"),
	CONSTRAINT "match_exceptions_status_check" CHECK ("status" in ('pending', 'approved', 'rejected')),
	CONSTRAINT "match_exceptions_reason_check" CHECK (btrim("reason") <> ''),
	CONSTRAINT "match_exceptions_approver_check" CHECK ("decided_by" IS NULL OR "decided_by" <> "requested_by"),
	CONSTRAINT "match_exceptions_decided_check" CHECK (("status" = 'pending' AND "decided_by" IS NULL AND "decided_at" IS NULL) OR ("status" <> 'pending' AND "decided_by" IS NOT NULL AND "decided_at" IS NOT NULL)),
	CONSTRAINT "match_exceptions_version_check" CHECK ("version" >= 1)
);
--> statement-breakpoint
-- One pending exception per bill.
CREATE UNIQUE INDEX "match_exceptions_tenant_bill_pending_unique" ON "app"."match_exceptions" USING btree ("tenant_id", "vendor_bill_id") WHERE "status" = 'pending';
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------
-- Payment requests (AD1: the request and its approval; no payout)
-- ---------------------------------------------------------------------------------------------------------------

-- A request to pay one vendor from one entity bank account. number, number_seq and fiscal_year come from the PAY
-- series, all three or none (a draft may not be numbered yet). total_amount is the sum of the lines (the service).
-- vendor_bank_account_id and bank_last4 snapshot the vendor's active verified account when the request is made.
CREATE TABLE "app"."payment_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text,
	"number_seq" integer,
	"fiscal_year" text,
	"vendor_id" uuid NOT NULL,
	"payment_type" text NOT NULL,
	"purchase_order_id" uuid,
	"currency" char(3) NOT NULL,
	"total_amount" numeric(18, 2) NOT NULL,
	"from_bank_account_id" uuid NOT NULL,
	"vendor_bank_account_id" uuid NOT NULL,
	"bank_last4" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"requested_by" uuid NOT NULL,
	"approval_request_id" uuid,
	"cancel_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_requests_tenant_org_id_unique" UNIQUE("tenant_id", "organization_id", "id"),
	CONSTRAINT "payment_requests_tenant_org_number_unique" UNIQUE("tenant_id", "organization_id", "number"),
	CONSTRAINT "payment_requests_tenant_org_fy_seq_unique" UNIQUE("tenant_id", "organization_id", "fiscal_year", "number_seq"),
	CONSTRAINT "payment_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "payment_requests_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "payment_requests_vendor_account_fk" FOREIGN KEY ("tenant_id", "organization_id", "vendor_id") REFERENCES "app"."vendor_accounts"("tenant_id", "organization_id", "vendor_id"),
	CONSTRAINT "payment_requests_purchase_order_fk" FOREIGN KEY ("tenant_id", "organization_id", "vendor_id", "purchase_order_id") REFERENCES "app"."purchase_orders"("tenant_id", "organization_id", "vendor_id", "id"),
	CONSTRAINT "payment_requests_vendor_bank_account_fk" FOREIGN KEY ("tenant_id", "vendor_bank_account_id") REFERENCES "app"."vendor_bank_accounts"("tenant_id", "id"),
	CONSTRAINT "payment_requests_requested_by_fk" FOREIGN KEY ("tenant_id", "requested_by") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "payment_requests_approval_request_fk" FOREIGN KEY ("tenant_id", "organization_id", "approval_request_id") REFERENCES "app"."approval_requests"("tenant_id", "organization_id", "id"),
	CONSTRAINT "payment_requests_status_check" CHECK ("status" in ('draft', 'pending_approval', 'approved', 'rejected', 'cancelled')),
	CONSTRAINT "payment_requests_payment_type_check" CHECK ("payment_type" in ('settlement', 'advance')),
	CONSTRAINT "payment_requests_currency_check" CHECK ("currency" in ('NPR', 'INR', 'USD')),
	CONSTRAINT "payment_requests_advance_check" CHECK ("payment_type" <> 'advance' OR "purchase_order_id" IS NOT NULL),
	CONSTRAINT "payment_requests_total_amount_check" CHECK ("total_amount" > 0),
	CONSTRAINT "payment_requests_bank_last4_check" CHECK ("bank_last4" ~ '^[0-9]{4}$'),
	CONSTRAINT "payment_requests_numbering_check" CHECK (("number" IS NULL AND "number_seq" IS NULL AND "fiscal_year" IS NULL) OR ("number" IS NOT NULL AND "number_seq" >= 1 AND "fiscal_year" IS NOT NULL)),
	CONSTRAINT "payment_requests_cancelled_check" CHECK ("status" <> 'cancelled' OR ("cancel_reason" IS NOT NULL AND btrim("cancel_reason") <> '')),
	CONSTRAINT "payment_requests_version_check" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE INDEX "payment_requests_tenant_org_status_idx" ON "app"."payment_requests" USING btree ("tenant_id", "organization_id", "status");
--> statement-breakpoint
CREATE INDEX "payment_requests_tenant_org_vendor_idx" ON "app"."payment_requests" USING btree ("tenant_id", "organization_id", "vendor_id");
--> statement-breakpoint

-- One line of a payment request: an amount > 0 of one payable open item of the same entity, once per request.
CREATE TABLE "app"."payment_request_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"payment_request_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"open_item_id" uuid NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_request_lines_tenant_request_line_no_unique" UNIQUE("tenant_id", "payment_request_id", "line_no"),
	CONSTRAINT "payment_request_lines_tenant_request_open_item_unique" UNIQUE("tenant_id", "payment_request_id", "open_item_id"),
	CONSTRAINT "payment_request_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "payment_request_lines_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "payment_request_lines_payment_request_fk" FOREIGN KEY ("tenant_id", "organization_id", "payment_request_id") REFERENCES "app"."payment_requests"("tenant_id", "organization_id", "id"),
	CONSTRAINT "payment_request_lines_open_item_fk" FOREIGN KEY ("tenant_id", "organization_id", "open_item_id") REFERENCES "app"."open_items"("tenant_id", "organization_id", "id"),
	CONSTRAINT "payment_request_lines_line_no_check" CHECK ("line_no" >= 1),
	CONSTRAINT "payment_request_lines_amount_check" CHECK ("amount" > 0)
);
--> statement-breakpoint
CREATE INDEX "payment_request_lines_tenant_org_open_item_idx" ON "app"."payment_request_lines" USING btree ("tenant_id", "organization_id", "open_item_id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------
-- Progress per PO line. security_invoker: the reader's own privileges on the underlying tables apply. Each side is
-- summed in its own subquery, so receipts and bills never multiply each other.
-- ---------------------------------------------------------------------------------------------------------------
CREATE VIEW "app"."v_po_line_progress" WITH (security_invoker = true) AS
SELECT
	pol."tenant_id",
	pol."organization_id",
	pol."purchase_order_id",
	pol."id" AS "po_line_id",
	pol."ordered_quantity",
	pol."cancelled_quantity",
	COALESCE(r."received", 0)::numeric(18, 4) AS "received_quantity",
	COALESCE(b."billed", 0)::numeric(18, 4) AS "billed_quantity"
FROM "app"."purchase_order_lines" pol
LEFT JOIN (
	SELECT l."tenant_id", l."organization_id", l."po_line_id", sum(l."quantity") AS "received"
	FROM "app"."receipt_lines" l
	JOIN "app"."receipts" rc
		ON rc."tenant_id" = l."tenant_id" AND rc."organization_id" = l."organization_id" AND rc."id" = l."receipt_id"
	WHERE rc."status" IN ('confirmed', 'reversed')
	GROUP BY l."tenant_id", l."organization_id", l."po_line_id"
) r ON r."tenant_id" = pol."tenant_id" AND r."organization_id" = pol."organization_id" AND r."po_line_id" = pol."id"
LEFT JOIN (
	SELECT bl."tenant_id", bl."organization_id", bl."po_line_id",
		sum(CASE WHEN vb."kind" = 'vendor_credit_note' THEN -bl."quantity" ELSE bl."quantity" END) AS "billed"
	FROM "app"."vendor_bill_lines" bl
	JOIN "app"."vendor_bills" vb
		ON vb."tenant_id" = bl."tenant_id" AND vb."organization_id" = bl."organization_id" AND vb."id" = bl."vendor_bill_id"
	WHERE bl."po_line_id" IS NOT NULL AND vb."status" NOT IN ('voided', 'rejected')
	GROUP BY bl."tenant_id", bl."organization_id", bl."po_line_id"
) b ON b."tenant_id" = pol."tenant_id" AND b."organization_id" = pol."organization_id" AND b."po_line_id" = pol."id";
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------
-- Audit: every write to these tables lands in the hash chain.
-- ---------------------------------------------------------------------------------------------------------------
SELECT audit.attach('app.vendor_bills');
--> statement-breakpoint
SELECT audit.attach('app.vendor_bill_submissions');
--> statement-breakpoint
SELECT audit.attach('app.vendor_bill_lines');
--> statement-breakpoint
SELECT audit.attach('app.match_results');
--> statement-breakpoint
SELECT audit.attach('app.match_exceptions');
--> statement-breakpoint
SELECT audit.attach('app.payment_requests');
--> statement-breakpoint
SELECT audit.attach('app.payment_request_lines');
