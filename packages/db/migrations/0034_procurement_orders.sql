-- 0034_procurement_orders: the order and receipt tables of P4 (plan unit S-PR2; AD7 and AD16 of the P4 plan; the P4
-- architect's purchase-order and receipt sketch, rewritten to the money rules of ADR 0024 and the tenancy rules of
-- ADR 0027).
--
-- Every table here is entity-owned: tenant_id and organization_id NOT NULL, (tenant_id, organization_id) ->
-- organizations, and a FK into another entity-owned table is (tenant_id, organization_id, x). A FK into a
-- tenant-level table (users, tax_codes) is (tenant_id, x). Every table has its own uuid id (the audit trigger names a
-- changed row by it); the natural keys (a PO's number, a version of a PO, a serial of a receipt line) are UNIQUE keys
-- that lead with tenant_id. Money is numeric(18,2), quantities numeric(18,4), FX rates numeric(18,6), as in 0016.
--
--   * purchase_orders: raised from a purchase request and, normally, the RFQ and the recommended quotation of that
--     request. The source chain runs through the composite keys of 0033, so the RFQ is the request's own, the
--     quotation is the RFQ's own, and the quotation is the PO vendor's own (purchase_orders_rfq_fk,
--     purchase_orders_quotation_fk, purchase_orders_quotation_vendor_fk). That the quotation is the RFQ's
--     *recommended* one is the service's rule (it would need a change to rfqs). A PO is for a vendor that has an
--     account in the same entity (purchase_orders_vendor_account_fk, as rfq_vendors in 0033): a vendor with no account
--     here is a foreign-key violation (23503). At most one live (not cancelled) PO exists per quotation. Status is the
--     business status of PO_TRANSITIONS in @bos/contracts; the approval engine owns the workflow state. approved_total
--     (vendor currency), its FX snapshot and approved_total_npr are what the commitment route approved;
--     approved_band is the band they fall in (PO_APPROVED_BANDS: base, management, founder) and an amendment needs
--     re-approval only if its band is higher (AD7). number, number_seq and fiscal_year come from NumberingService.
--     current_version is 0 while the PO is a draft; issuing writes version 1 and sets it to 1, an amendment writes
--     version N+1 and moves it (the service; the version rows are immutable).
--   * purchase_order_versions: one immutable snapshot per issued version. A trigger refuses UPDATE and DELETE, and
--     bos_app holds neither privilege. The rendered document hangs off the version through the documents owner
--     (owner_type, owner_id), not through a column, because the row cannot be updated once the render finishes.
--   * purchase_order_lines: the current state of a line; its id is stable across versions (the versions hold the
--     history). ordered_quantity is changed by an amendment, cancelled_quantity by a short-close or cancel. The line
--     repeats purchase_request_id so that it can only price a line of the PO's own request.
--     purchase_order_lines_open_guard refuses to shrink ordered - cancelled below what has been received.
--   * receipts and receipt_lines: a goods receipt or service confirmation (kind), numbered with a GRN number. A
--     negative quantity exists only on a reversal line: a receipt that reverses another (reverses_receipt_id) holds
--     one negative line per line of the reversed receipt, each naming the line it reverses
--     (receipt_lines_reversal_check, receipt_lines_guard). A reversal is always a full reversal of a positive line
--     (AD16: no vendor returns beyond that) and each receipt and each line is reversed at most once. A receipt line
--     repeats purchase_order_id, so it can only receive against a line of its own PO.
--   * A reversal line is never deleted, because that would reopen the reversed quantity: receipt_lines_guard
--     refuses the DELETE of a negative line (a reversal is a new negative receipt, never an edit).
--   * Over-receipt: receipt_lines_guard refuses a positive line when the net quantity received on the PO line
--     (every receipt line of it, whatever the receipt status, so a reversed receipt nets to zero against its
--     reversal and two drafts cannot both claim the same units) would exceed ordered - cancelled, unless the line
--     carries over_receipt_exception_id. The guard locks the PO line row (FOR UPDATE), so two receivers of the same
--     line are serialised. Not modelled: no stock ledger, no GRNI accrual (AD16).
--   * receipt_serials: the serial numbers a goods line took in, unique per receipt line.
--
-- Columns that point at tables that do not exist yet have no FK:
--   * receipt_lines.over_receipt_exception_id (no exceptions table yet; the service validates the id).
--
-- The vendor columns are called vendor_id, as in 0032 and 0033 (staff data; vendor_party_id is the portal
-- counterparty column of check-tenancy, and a vendor sees POs through the portal views of PV2).
--
-- Every table is audited (audit.attach). No GRANT: 0008's default privileges give bos_app SELECT, INSERT, UPDATE,
-- DELETE on new app tables; purchase_order_versions has UPDATE and DELETE revoked below. version is the optimistic
-- lock where a row is edited; updated_at is set by the API.
--
-- DDL only: no row is written, so no actor context is needed. Runs as bos_owner, split at the breakpoint
-- comments (same rule as 0000). Names follow the K1-U2 convention, mirrored in src/schema/procurement-orders.ts.

-- ---------------------------------------------------------------------------------------------------------------
-- Purchase orders
-- ---------------------------------------------------------------------------------------------------------------

-- A purchase order. rfq_id and vendor_quotation_id are both set or both NULL (purchase_orders_source_check), and when
-- set they are the request's own RFQ, that RFQ's own quotation, and the vendor's own quotation. fx_rate is NPR per
-- unit (1 for NPR) with its source and date for a foreign currency; approved_total_npr is rounded by the service.
-- A PO that has left draft has an issue stamp and a current version.
CREATE TABLE "app"."purchase_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text NOT NULL,
	"number_seq" integer NOT NULL,
	"fiscal_year" text NOT NULL,
	"purchase_request_id" uuid NOT NULL,
	"rfq_id" uuid,
	"vendor_quotation_id" uuid,
	"vendor_id" uuid NOT NULL,
	"currency" char(3) NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"payment_terms_days" integer NOT NULL,
	"advance_percent" numeric(5, 2) DEFAULT 0 NOT NULL,
	"approved_total" numeric(18, 2) NOT NULL,
	"fx_rate" numeric(18, 6) NOT NULL,
	"fx_source" text,
	"fx_date" date,
	"approved_total_npr" numeric(18, 2) NOT NULL,
	"approved_band" text NOT NULL,
	"current_version" integer DEFAULT 0 NOT NULL,
	"issued_at" timestamp with time zone,
	"issued_by" uuid,
	"closed_reason" text,
	"created_by" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_orders_tenant_org_id_unique" UNIQUE("tenant_id", "organization_id", "id"),
	CONSTRAINT "purchase_orders_tenant_org_pr_id_unique" UNIQUE("tenant_id", "organization_id", "purchase_request_id", "id"),
	CONSTRAINT "purchase_orders_tenant_org_vendor_id_unique" UNIQUE("tenant_id", "organization_id", "vendor_id", "id"),
	CONSTRAINT "purchase_orders_tenant_org_number_unique" UNIQUE("tenant_id", "organization_id", "number"),
	CONSTRAINT "purchase_orders_tenant_org_fy_seq_unique" UNIQUE("tenant_id", "organization_id", "fiscal_year", "number_seq"),
	CONSTRAINT "purchase_orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "purchase_orders_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "purchase_orders_purchase_request_fk" FOREIGN KEY ("tenant_id", "organization_id", "purchase_request_id") REFERENCES "app"."purchase_requests"("tenant_id", "organization_id", "id"),
	CONSTRAINT "purchase_orders_rfq_fk" FOREIGN KEY ("tenant_id", "organization_id", "purchase_request_id", "rfq_id") REFERENCES "app"."rfqs"("tenant_id", "organization_id", "purchase_request_id", "id"),
	CONSTRAINT "purchase_orders_quotation_fk" FOREIGN KEY ("tenant_id", "organization_id", "rfq_id", "vendor_quotation_id") REFERENCES "app"."vendor_quotations"("tenant_id", "organization_id", "rfq_id", "id"),
	CONSTRAINT "purchase_orders_quotation_vendor_fk" FOREIGN KEY ("tenant_id", "organization_id", "vendor_id", "vendor_quotation_id") REFERENCES "app"."vendor_quotations"("tenant_id", "organization_id", "vendor_id", "id"),
	CONSTRAINT "purchase_orders_vendor_account_fk" FOREIGN KEY ("tenant_id", "organization_id", "vendor_id") REFERENCES "app"."vendor_accounts"("tenant_id", "organization_id", "vendor_id"),
	CONSTRAINT "purchase_orders_issued_by_fk" FOREIGN KEY ("tenant_id", "issued_by") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "purchase_orders_created_by_fk" FOREIGN KEY ("tenant_id", "created_by") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "purchase_orders_status_check" CHECK ("status" in ('draft', 'issued', 'partially_received', 'fully_received', 'amendment_pending', 'closed', 'short_closed', 'cancelled')),
	CONSTRAINT "purchase_orders_approved_band_check" CHECK ("approved_band" in ('base', 'management', 'founder')),
	CONSTRAINT "purchase_orders_currency_check" CHECK ("currency" in ('NPR', 'INR', 'USD')),
	CONSTRAINT "purchase_orders_source_check" CHECK (("rfq_id" IS NULL) = ("vendor_quotation_id" IS NULL)),
	CONSTRAINT "purchase_orders_number_seq_check" CHECK ("number_seq" >= 1),
	CONSTRAINT "purchase_orders_payment_terms_days_check" CHECK ("payment_terms_days" >= 0),
	CONSTRAINT "purchase_orders_advance_percent_check" CHECK ("advance_percent" BETWEEN 0 AND 100),
	CONSTRAINT "purchase_orders_approved_total_check" CHECK ("approved_total" >= 0 AND "approved_total_npr" >= 0),
	CONSTRAINT "purchase_orders_fx_rate_check" CHECK ("fx_rate" > 0),
	CONSTRAINT "purchase_orders_npr_snapshot_check" CHECK ("currency" <> 'NPR' OR ("fx_rate" = 1 AND "approved_total_npr" = "approved_total")),
	CONSTRAINT "purchase_orders_fx_source_check" CHECK ("currency" = 'NPR' OR ("fx_source" IS NOT NULL AND "fx_date" IS NOT NULL)),
	CONSTRAINT "purchase_orders_current_version_check" CHECK ("current_version" >= 0),
	CONSTRAINT "purchase_orders_issued_check" CHECK ("status" = 'draft' OR ("issued_at" IS NOT NULL AND "issued_by" IS NOT NULL AND "current_version" >= 1)),
	CONSTRAINT "purchase_orders_closed_reason_check" CHECK ("status" NOT IN ('short_closed', 'cancelled') OR ("closed_reason" IS NOT NULL AND btrim("closed_reason") <> '')),
	CONSTRAINT "purchase_orders_version_check" CHECK ("version" >= 1)
);
--> statement-breakpoint

-- At most one live PO per quotation; a cancelled one does not count.
CREATE UNIQUE INDEX "purchase_orders_tenant_quotation_live_unique" ON "app"."purchase_orders" USING btree ("tenant_id", "vendor_quotation_id") WHERE "status" <> 'cancelled' AND "vendor_quotation_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "purchase_orders_tenant_org_status_idx" ON "app"."purchase_orders" USING btree ("tenant_id", "organization_id", "status");
--> statement-breakpoint
CREATE INDEX "purchase_orders_tenant_org_vendor_idx" ON "app"."purchase_orders" USING btree ("tenant_id", "organization_id", "vendor_id");
--> statement-breakpoint

-- One issued version of a PO (AD7): the totals at that version, the approval band they fall in, the full snapshot
-- (header and lines) and, from version 2 on, the reason for the amendment. approval_request_id is the approval of a
-- re-approved amendment, if there was one. Immutable: see the trigger below.
CREATE TABLE "app"."purchase_order_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"reason" text,
	"total" numeric(18, 2) NOT NULL,
	"total_npr" numeric(18, 2) NOT NULL,
	"band" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"approval_request_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_order_versions_tenant_org_po_version_unique" UNIQUE("tenant_id", "organization_id", "purchase_order_id", "version"),
	CONSTRAINT "purchase_order_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "purchase_order_versions_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "purchase_order_versions_purchase_order_fk" FOREIGN KEY ("tenant_id", "organization_id", "purchase_order_id") REFERENCES "app"."purchase_orders"("tenant_id", "organization_id", "id"),
	CONSTRAINT "purchase_order_versions_approval_request_fk" FOREIGN KEY ("tenant_id", "organization_id", "approval_request_id") REFERENCES "app"."approval_requests"("tenant_id", "organization_id", "id"),
	CONSTRAINT "purchase_order_versions_created_by_fk" FOREIGN KEY ("tenant_id", "created_by") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "purchase_order_versions_version_check" CHECK ("version" >= 1),
	CONSTRAINT "purchase_order_versions_reason_check" CHECK ("version" = 1 OR ("reason" IS NOT NULL AND btrim("reason") <> '')),
	CONSTRAINT "purchase_order_versions_total_check" CHECK ("total" >= 0 AND "total_npr" >= 0),
	CONSTRAINT "purchase_order_versions_band_check" CHECK ("band" in ('base', 'management', 'founder'))
);
--> statement-breakpoint

-- One line of a PO. gross = round(ordered_quantity * unit_price, 2); line_total = gross + tax_amount (the service
-- computes tax_amount from the tax code's rate). purchase_request_id is the PO's own (purchase_order_lines_purchase_order_fk),
-- so pr_line_id can only be a line of that request. Services have no serials.
CREATE TABLE "app"."purchase_order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"purchase_request_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"pr_line_id" uuid,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"uom" text NOT NULL,
	"ordered_quantity" numeric(18, 4) NOT NULL,
	"cancelled_quantity" numeric(18, 4) DEFAULT 0 NOT NULL,
	"unit_price" numeric(18, 2) NOT NULL,
	"tax_code_id" uuid NOT NULL,
	"gross" numeric(18, 2) NOT NULL,
	"tax_amount" numeric(18, 2) NOT NULL,
	"line_total" numeric(18, 2) NOT NULL,
	"requires_serials" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_order_lines_tenant_org_id_unique" UNIQUE("tenant_id", "organization_id", "id"),
	CONSTRAINT "purchase_order_lines_tenant_org_po_id_unique" UNIQUE("tenant_id", "organization_id", "purchase_order_id", "id"),
	CONSTRAINT "purchase_order_lines_tenant_po_line_no_unique" UNIQUE("tenant_id", "purchase_order_id", "line_no"),
	CONSTRAINT "purchase_order_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "purchase_order_lines_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "purchase_order_lines_purchase_order_fk" FOREIGN KEY ("tenant_id", "organization_id", "purchase_request_id", "purchase_order_id") REFERENCES "app"."purchase_orders"("tenant_id", "organization_id", "purchase_request_id", "id"),
	CONSTRAINT "purchase_order_lines_pr_line_fk" FOREIGN KEY ("tenant_id", "organization_id", "purchase_request_id", "pr_line_id") REFERENCES "app"."purchase_request_lines"("tenant_id", "organization_id", "purchase_request_id", "id"),
	CONSTRAINT "purchase_order_lines_tax_code_fk" FOREIGN KEY ("tenant_id", "tax_code_id") REFERENCES "app"."tax_codes"("tenant_id", "id"),
	CONSTRAINT "purchase_order_lines_kind_check" CHECK ("kind" in ('goods', 'service')),
	CONSTRAINT "purchase_order_lines_line_no_check" CHECK ("line_no" >= 1),
	CONSTRAINT "purchase_order_lines_ordered_quantity_check" CHECK ("ordered_quantity" > 0),
	CONSTRAINT "purchase_order_lines_cancelled_check" CHECK ("cancelled_quantity" >= 0 AND "cancelled_quantity" <= "ordered_quantity"),
	CONSTRAINT "purchase_order_lines_unit_price_check" CHECK ("unit_price" >= 0),
	CONSTRAINT "purchase_order_lines_gross_check" CHECK ("gross" = round("ordered_quantity" * "unit_price", 2)),
	CONSTRAINT "purchase_order_lines_tax_amount_check" CHECK ("tax_amount" >= 0),
	CONSTRAINT "purchase_order_lines_line_total_check" CHECK ("line_total" = "gross" + "tax_amount"),
	CONSTRAINT "purchase_order_lines_serials_check" CHECK ("requires_serials" = false OR "kind" = 'goods')
);
--> statement-breakpoint
CREATE INDEX "purchase_order_lines_tenant_tax_code_idx" ON "app"."purchase_order_lines" USING btree ("tenant_id", "tax_code_id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------
-- Receipts
-- ---------------------------------------------------------------------------------------------------------------

-- A goods receipt or service confirmation of one PO, with its GRN number (number, number_seq, fiscal_year). A draft
-- is not confirmed yet; a confirmed or reversed one names who confirmed it and when. A receipt that reverses another
-- (reverses_receipt_id, of the same PO) names the reason; each receipt is reversed at most once. The original moves
-- to 'reversed' when its reversal is confirmed (the service); the reversal receipt itself is confirmed.
CREATE TABLE "app"."receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text NOT NULL,
	"number_seq" integer NOT NULL,
	"fiscal_year" text NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"received_at" date NOT NULL,
	"location" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by" uuid NOT NULL,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	"reverses_receipt_id" uuid,
	"reversal_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipts_tenant_org_id_unique" UNIQUE("tenant_id", "organization_id", "id"),
	CONSTRAINT "receipts_tenant_org_po_id_unique" UNIQUE("tenant_id", "organization_id", "purchase_order_id", "id"),
	CONSTRAINT "receipts_tenant_org_number_unique" UNIQUE("tenant_id", "organization_id", "number"),
	CONSTRAINT "receipts_tenant_org_fy_seq_unique" UNIQUE("tenant_id", "organization_id", "fiscal_year", "number_seq"),
	CONSTRAINT "receipts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "receipts_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "receipts_purchase_order_fk" FOREIGN KEY ("tenant_id", "organization_id", "purchase_order_id") REFERENCES "app"."purchase_orders"("tenant_id", "organization_id", "id"),
	CONSTRAINT "receipts_reverses_fk" FOREIGN KEY ("tenant_id", "organization_id", "purchase_order_id", "reverses_receipt_id") REFERENCES "app"."receipts"("tenant_id", "organization_id", "purchase_order_id", "id"),
	CONSTRAINT "receipts_created_by_fk" FOREIGN KEY ("tenant_id", "created_by") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "receipts_confirmed_by_fk" FOREIGN KEY ("tenant_id", "confirmed_by") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "receipts_kind_check" CHECK ("kind" in ('goods', 'service')),
	CONSTRAINT "receipts_status_check" CHECK ("status" in ('draft', 'confirmed', 'reversed')),
	CONSTRAINT "receipts_number_seq_check" CHECK ("number_seq" >= 1),
	CONSTRAINT "receipts_confirmed_check" CHECK ("status" = 'draft' OR ("confirmed_by" IS NOT NULL AND "confirmed_at" IS NOT NULL)),
	CONSTRAINT "receipts_reversal_check" CHECK ("reverses_receipt_id" IS NULL OR ("reverses_receipt_id" <> "id" AND "reversal_reason" IS NOT NULL AND btrim("reversal_reason") <> '')),
	CONSTRAINT "receipts_version_check" CHECK ("version" >= 1)
);
--> statement-breakpoint

-- Each receipt is reversed at most once.
CREATE UNIQUE INDEX "receipts_tenant_org_reverses_unique" ON "app"."receipts" USING btree ("tenant_id", "organization_id", "reverses_receipt_id") WHERE "reverses_receipt_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "receipts_tenant_org_po_idx" ON "app"."receipts" USING btree ("tenant_id", "organization_id", "purchase_order_id");
--> statement-breakpoint

-- One line of a receipt: quantity of one PO line. Positive, except on a reversal line, which is negative and names
-- the line it reverses (same PO line: receipt_lines_reverses_fk). The symmetric receipt_lines_reversal_check keeps a
-- negative quantity from standing alone and a reference from sitting on a positive one; the trigger below checks the
-- rest. One line per PO line per receipt. over_receipt_exception_id lets a line pass the over-receipt guard.
CREATE TABLE "app"."receipt_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"po_line_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"reverses_receipt_line_id" uuid,
	"inspection" text,
	"discrepancy_note" text,
	"over_receipt_exception_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipt_lines_tenant_org_id_unique" UNIQUE("tenant_id", "organization_id", "id"),
	CONSTRAINT "receipt_lines_tenant_org_po_line_id_unique" UNIQUE("tenant_id", "organization_id", "po_line_id", "id"),
	CONSTRAINT "receipt_lines_tenant_receipt_line_no_unique" UNIQUE("tenant_id", "receipt_id", "line_no"),
	CONSTRAINT "receipt_lines_tenant_receipt_po_line_unique" UNIQUE("tenant_id", "receipt_id", "po_line_id"),
	CONSTRAINT "receipt_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "receipt_lines_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "receipt_lines_receipt_fk" FOREIGN KEY ("tenant_id", "organization_id", "purchase_order_id", "receipt_id") REFERENCES "app"."receipts"("tenant_id", "organization_id", "purchase_order_id", "id"),
	CONSTRAINT "receipt_lines_po_line_fk" FOREIGN KEY ("tenant_id", "organization_id", "purchase_order_id", "po_line_id") REFERENCES "app"."purchase_order_lines"("tenant_id", "organization_id", "purchase_order_id", "id"),
	CONSTRAINT "receipt_lines_reverses_fk" FOREIGN KEY ("tenant_id", "organization_id", "po_line_id", "reverses_receipt_line_id") REFERENCES "app"."receipt_lines"("tenant_id", "organization_id", "po_line_id", "id"),
	CONSTRAINT "receipt_lines_line_no_check" CHECK ("line_no" >= 1),
	CONSTRAINT "receipt_lines_quantity_check" CHECK ("quantity" <> 0),
	CONSTRAINT "receipt_lines_reversal_check" CHECK (("reverses_receipt_line_id" IS NULL) = ("quantity" > 0)),
	CONSTRAINT "receipt_lines_reverses_self_check" CHECK ("reverses_receipt_line_id" IS NULL OR "reverses_receipt_line_id" <> "id")
);
--> statement-breakpoint

-- Each line is reversed at most once.
CREATE UNIQUE INDEX "receipt_lines_tenant_org_reverses_unique" ON "app"."receipt_lines" USING btree ("tenant_id", "organization_id", "reverses_receipt_line_id") WHERE "reverses_receipt_line_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "receipt_lines_tenant_org_po_line_idx" ON "app"."receipt_lines" USING btree ("tenant_id", "organization_id", "po_line_id");
--> statement-breakpoint

-- A serial number a goods line took in. One row per serial, unique per receipt line. batch_no and warranty_until are
-- optional. Whether a line needs serials is purchase_order_lines.requires_serials (the service checks the count).
CREATE TABLE "app"."receipt_serials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"receipt_line_id" uuid NOT NULL,
	"serial_no" text NOT NULL,
	"batch_no" text,
	"warranty_until" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipt_serials_tenant_line_serial_unique" UNIQUE("tenant_id", "receipt_line_id", "serial_no"),
	CONSTRAINT "receipt_serials_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "receipt_serials_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "receipt_serials_receipt_line_fk" FOREIGN KEY ("tenant_id", "organization_id", "receipt_line_id") REFERENCES "app"."receipt_lines"("tenant_id", "organization_id", "id"),
	CONSTRAINT "receipt_serials_serial_no_check" CHECK (btrim("serial_no") <> '')
);
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------
-- Triggers. Not SECURITY DEFINER: they read only rows the writing role may read already. Errors are check_violation
-- with the named pseudo-constraint, as 0016 and 0033 do.
-- ---------------------------------------------------------------------------------------------------------------

-- A PO version is a record of what was issued: never rewritten or removed, not even by the owner.
CREATE FUNCTION "app"."purchase_order_versions_immutable"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
	RAISE EXCEPTION '%: rows are immutable (% refused)', TG_TABLE_NAME, TG_OP
		USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_immutable';
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "app"."purchase_order_versions_immutable"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "purchase_order_versions_immutable" BEFORE UPDATE OR DELETE ON "app"."purchase_order_versions"
FOR EACH ROW EXECUTE FUNCTION "app"."purchase_order_versions_immutable"();
--> statement-breakpoint

-- receipt_lines: the rules a CHECK cannot hold.
--   * Delete: a reversal line (negative quantity) cannot be deleted; the quantity it took off would come back and
--     the line could be received again. Positive lines (a draft's, say) may still be deleted.
--   * Reversal: a line that reverses another must reverse the whole of it (NEW.quantity = -the original), and sit in
--     the receipt that reverses the original's receipt; a line of a reversal receipt must be a reversal line.
--   * Over-receipt: a positive line may not take the net quantity received on its PO line above ordered - cancelled
--     unless it carries over_receipt_exception_id. The PO line row is locked first, so concurrent receivers of one
--     line queue and each sees the other's committed lines. Every receipt line of the PO line counts, whatever its
--     receipt's status, and the line itself (on UPDATE) is left out of the sum.
-- A missing parent row is left to the foreign keys.
CREATE FUNCTION "app"."receipt_lines_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
	v_reverses_receipt uuid;
	v_original_quantity numeric;
	v_original_receipt uuid;
	v_open numeric;
	v_received numeric;
BEGIN
	IF TG_OP = 'DELETE' THEN
		IF OLD."quantity" < 0 THEN
			RAISE EXCEPTION '%: reversal line % cannot be deleted', TG_TABLE_NAME, OLD."id"
				USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_reversal_delete_check';
		END IF;
		RETURN OLD;
	END IF;
	SELECT r."reverses_receipt_id" INTO v_reverses_receipt FROM "app"."receipts" r
	 WHERE r."tenant_id" = NEW."tenant_id" AND r."id" = NEW."receipt_id";
	IF NEW."reverses_receipt_line_id" IS NOT NULL THEN
		SELECT l."quantity", l."receipt_id" INTO v_original_quantity, v_original_receipt FROM "app"."receipt_lines" l
		 WHERE l."tenant_id" = NEW."tenant_id" AND l."id" = NEW."reverses_receipt_line_id";
		IF v_reverses_receipt IS DISTINCT FROM v_original_receipt OR NEW."quantity" <> -v_original_quantity THEN
			RAISE EXCEPTION '%: line % must reverse the whole of line % in the receipt that reverses its receipt', TG_TABLE_NAME, NEW."id", NEW."reverses_receipt_line_id"
				USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_reversal_match_check';
		END IF;
	ELSIF v_reverses_receipt IS NOT NULL THEN
		RAISE EXCEPTION '%: receipt % is a reversal, so line % must be a reversal line', TG_TABLE_NAME, NEW."receipt_id", NEW."id"
			USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_reversal_match_check';
	END IF;
	IF NEW."quantity" > 0 AND NEW."over_receipt_exception_id" IS NULL THEN
		SELECT p."ordered_quantity" - p."cancelled_quantity" INTO v_open FROM "app"."purchase_order_lines" p
		 WHERE p."tenant_id" = NEW."tenant_id" AND p."id" = NEW."po_line_id" FOR UPDATE;
		SELECT COALESCE(sum(l."quantity"), 0) INTO v_received FROM "app"."receipt_lines" l
		 WHERE l."tenant_id" = NEW."tenant_id" AND l."po_line_id" = NEW."po_line_id" AND l."id" <> NEW."id";
		IF v_received + NEW."quantity" > v_open THEN
			RAISE EXCEPTION '%: receiving % on PO line % takes the net received to %, above the % still open', TG_TABLE_NAME, NEW."quantity", NEW."po_line_id", v_received + NEW."quantity", v_open
				USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_over_receipt_check';
		END IF;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "app"."receipt_lines_guard"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "receipt_lines_guard" BEFORE INSERT OR UPDATE OR DELETE ON "app"."receipt_lines"
FOR EACH ROW EXECUTE FUNCTION "app"."receipt_lines_guard"();
--> statement-breakpoint

-- purchase_order_lines: an amendment or a short-close may not shrink the open quantity (ordered - cancelled) below
-- what was received. Raising it, or changing anything else, is not checked (a line received over its exception stays
-- editable). The UPDATE has the line row locked already, so a concurrent receipt waits for it.
CREATE FUNCTION "app"."purchase_order_lines_open_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
	v_received numeric;
BEGIN
	IF NEW."ordered_quantity" - NEW."cancelled_quantity" < OLD."ordered_quantity" - OLD."cancelled_quantity" THEN
		SELECT COALESCE(sum(l."quantity"), 0) INTO v_received FROM "app"."receipt_lines" l
		 WHERE l."tenant_id" = NEW."tenant_id" AND l."po_line_id" = NEW."id";
		IF NEW."ordered_quantity" - NEW."cancelled_quantity" < v_received THEN
			RAISE EXCEPTION '%: line % has % received, more than the % left open', TG_TABLE_NAME, NEW."id", v_received, NEW."ordered_quantity" - NEW."cancelled_quantity"
				USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_open_quantity_check';
		END IF;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "app"."purchase_order_lines_open_guard"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "purchase_order_lines_open_guard" BEFORE UPDATE OF "ordered_quantity", "cancelled_quantity" ON "app"."purchase_order_lines"
FOR EACH ROW EXECUTE FUNCTION "app"."purchase_order_lines_open_guard"();
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------
-- Privileges: the versions are append-only for the app (as approval_actions in 0006 and the ledger in 0019).
-- ---------------------------------------------------------------------------------------------------------------
REVOKE UPDATE, DELETE ON "app"."purchase_order_versions" FROM "bos_app";
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------
-- Audit: every write to these tables lands in the hash chain.
-- ---------------------------------------------------------------------------------------------------------------
SELECT audit.attach('app.purchase_orders');
--> statement-breakpoint
SELECT audit.attach('app.purchase_order_versions');
--> statement-breakpoint
SELECT audit.attach('app.purchase_order_lines');
--> statement-breakpoint
SELECT audit.attach('app.receipts');
--> statement-breakpoint
SELECT audit.attach('app.receipt_lines');
--> statement-breakpoint
SELECT audit.attach('app.receipt_serials');
