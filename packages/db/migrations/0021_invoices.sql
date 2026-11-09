-- 0021_invoices: tax invoices, proformas, credit and debit notes (P3 plan unit U1; decisions A2, A5, A8, A10-A12,
-- A15; done checks G3, G4). Money is numeric(18,2), quantities numeric(18,4), FX rates numeric(18,6).
--
-- Every table is entity-owned (ADR 0027): tenant_id + organization_id NOT NULL with (tenant_id, organization_id) ->
-- organizations; a FK into another entity-owned table is (tenant_id, organization_id, x); a FK into a tenant-level
-- table (parties, customers, users, tax_codes) is (tenant_id, x).
--
-- The model:
--   * kind: tax_invoice, proforma (A12: PI series, no open item), credit_note, debit_note. status: draft ->
--     submitted -> (returned ->) approved -> issued, or discarded. The service drives the transitions; the database
--     holds what must never break:
--       - an invoice is inserted as draft (invoices_insert_draft_check);
--       - issued <=> numbered (invoices_issued_check): number, seq and fiscal_year come together from
--         NumberingService at issue, never earlier. The BS issue date exists only on an issued document, and an
--         issued one carries its issue date, NPR snapshot, seller and buyer snapshots and content hash;
--       - G3: an issued invoice is immutable (invoices_guard compares the whole row, minus the optimistic-lock
--         columns version and updated_at, so a later column is frozen too unless a migration lists it); a
--         non-draft invoice cannot be deleted; lines and tax summary change only while the invoice is draft or
--         returned (invoice_children_guard);
--       - G4: one live (not discarded) tax invoice per schedule line (invoices_one_live_tax_invoice_per_schedule_line);
--       - a credit or debit note names an issued tax invoice of the same customer and currency, and the live (not
--         discarded) credit notes of an invoice never exceed its total (invoices_notes, a DEFERRABLE INITIALLY
--         DEFERRED constraint trigger that locks the original first, so concurrent credit notes serialise).
--   * A schedule line is named through (tenant_id, organization_id, sales_order_id, schedule_line_id), so it is a
--     line of the invoice's own order; billing_schedule_lines.invoice_id points back the same way (added below).
--   * A tax invoice comes from a sales order or carries manual_reason (A11). Totals by bucket: subtotal - discount =
--     taxable_vat + exempt + zero_rated, total = those buckets + tax. Amounts are positive; the kind gives the sign.
--   * NPR snapshot (C-11): fx_rate, fx_source, fx_date and amount_npr, frozen at issue (required from then on).
--   * Paid is derived from the ledger (A8): no paid or amount_paid column.
--   * invoice_print_log is append-only ("Copy of original (n)").
--
-- Every table is audited (audit.attach). 0008's default privileges give bos_app SELECT, INSERT, UPDATE, DELETE on new
-- tables; the print log loses UPDATE and DELETE. Runs as bos_owner, split at the breakpoint comments. Names follow the
-- K1-U2 convention, mirrored in src/schema/invoicing.ts.

CREATE TABLE "app"."invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"customer_party_id" uuid,
	"customer_party_kind" text GENERATED ALWAYS AS ('customer') STORED,
	"sales_order_id" uuid,
	"schedule_line_id" uuid,
	"original_invoice_id" uuid,
	"manual_reason" text,
	"note_reason" text,
	"number" text,
	"seq" bigint,
	"fiscal_year" text,
	"issue_date" date,
	"issue_date_bs" text,
	"due_date" date,
	"currency" char(3) NOT NULL,
	"subtotal" numeric(18, 2) DEFAULT 0 NOT NULL,
	"discount_amount" numeric(18, 2) DEFAULT 0 NOT NULL,
	"taxable_vat_amount" numeric(18, 2) DEFAULT 0 NOT NULL,
	"exempt_amount" numeric(18, 2) DEFAULT 0 NOT NULL,
	"zero_rated_amount" numeric(18, 2) DEFAULT 0 NOT NULL,
	"tax_amount" numeric(18, 2) DEFAULT 0 NOT NULL,
	"total" numeric(18, 2) DEFAULT 0 NOT NULL,
	"fx_rate" numeric(18, 6),
	"fx_source" text,
	"fx_date" date,
	"amount_npr" numeric(18, 2),
	"seller_snapshot" jsonb,
	"buyer_snapshot" jsonb,
	"calc_version" integer DEFAULT 1 NOT NULL,
	"content_hash" bytea,
	"approval_request_id" uuid,
	"issued_at" timestamp with time zone,
	"issued_by" uuid,
	"discarded_at" timestamp with time zone,
	"created_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_tenant_id_unique" UNIQUE("tenant_id", "id"),
	CONSTRAINT "invoices_tenant_org_id_unique" UNIQUE("tenant_id", "organization_id", "id"),
	CONSTRAINT "invoices_tenant_org_order_id_unique" UNIQUE("tenant_id", "organization_id", "sales_order_id", "id"),
	CONSTRAINT "invoices_tenant_org_number_unique" UNIQUE("tenant_id", "organization_id", "number"),
	CONSTRAINT "invoices_tenant_org_kind_fy_seq_unique" UNIQUE("tenant_id", "organization_id", "kind", "fiscal_year", "seq"),
	CONSTRAINT "invoices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "invoices_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "invoices_customer_party_fk" FOREIGN KEY ("tenant_id", "customer_party_id", "customer_party_kind") REFERENCES "app"."parties"("tenant_id", "id", "kind"),
	CONSTRAINT "invoices_customer_fk" FOREIGN KEY ("tenant_id", "customer_party_id") REFERENCES "app"."customers"("tenant_id", "id"),
	CONSTRAINT "invoices_sales_order_fk" FOREIGN KEY ("tenant_id", "organization_id", "sales_order_id") REFERENCES "app"."sales_orders"("tenant_id", "organization_id", "id"),
	CONSTRAINT "invoices_schedule_line_fk" FOREIGN KEY ("tenant_id", "organization_id", "sales_order_id", "schedule_line_id") REFERENCES "app"."billing_schedule_lines"("tenant_id", "organization_id", "sales_order_id", "id"),
	CONSTRAINT "invoices_original_invoice_fk" FOREIGN KEY ("tenant_id", "organization_id", "original_invoice_id") REFERENCES "app"."invoices"("tenant_id", "organization_id", "id"),
	CONSTRAINT "invoices_approval_request_fk" FOREIGN KEY ("tenant_id", "organization_id", "approval_request_id") REFERENCES "app"."approval_requests"("tenant_id", "organization_id", "id"),
	CONSTRAINT "invoices_issued_by_user_fk" FOREIGN KEY ("tenant_id", "issued_by") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "invoices_created_by_user_fk" FOREIGN KEY ("tenant_id", "created_by") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "invoices_kind_check" CHECK ("kind" in ('tax_invoice', 'proforma', 'credit_note', 'debit_note')),
	CONSTRAINT "invoices_status_check" CHECK ("status" in ('draft', 'submitted', 'returned', 'approved', 'issued', 'discarded')),
	CONSTRAINT "invoices_customer_check" CHECK ("customer_party_id" IS NOT NULL),
	CONSTRAINT "invoices_currency_check" CHECK ("currency" in ('NPR', 'INR', 'USD')),
	CONSTRAINT "invoices_amounts_check" CHECK ("subtotal" >= 0 AND "discount_amount" >= 0 AND "discount_amount" <= "subtotal" AND "taxable_vat_amount" >= 0 AND "exempt_amount" >= 0 AND "zero_rated_amount" >= 0 AND "tax_amount" >= 0),
	CONSTRAINT "invoices_taxable_check" CHECK ("subtotal" - "discount_amount" = "taxable_vat_amount" + "exempt_amount" + "zero_rated_amount"),
	CONSTRAINT "invoices_total_check" CHECK ("total" = "taxable_vat_amount" + "exempt_amount" + "zero_rated_amount" + "tax_amount"),
	CONSTRAINT "invoices_note_original_check" CHECK (("kind" IN ('credit_note', 'debit_note')) = ("original_invoice_id" IS NOT NULL) AND "original_invoice_id" <> "id"),
	CONSTRAINT "invoices_note_reason_check" CHECK ("kind" NOT IN ('credit_note', 'debit_note') OR "note_reason" IS NOT NULL),
	CONSTRAINT "invoices_source_check" CHECK ("kind" <> 'tax_invoice' OR "sales_order_id" IS NOT NULL OR "manual_reason" IS NOT NULL),
	CONSTRAINT "invoices_schedule_line_check" CHECK ("schedule_line_id" IS NULL OR ("sales_order_id" IS NOT NULL AND "kind" IN ('tax_invoice', 'proforma'))),
	CONSTRAINT "invoices_number_parts_check" CHECK (("number" IS NULL) = ("seq" IS NULL) AND ("number" IS NULL) = ("fiscal_year" IS NULL) AND "seq" >= 1 AND "fiscal_year" ~ '^[0-9]{4}/[0-9]{2}$'),
	CONSTRAINT "invoices_issued_check" CHECK (("status" = 'issued') = ("number" IS NOT NULL)),
	CONSTRAINT "invoices_issue_date_bs_check" CHECK (("status" = 'issued') = ("issue_date_bs" IS NOT NULL) AND "issue_date_bs" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
	CONSTRAINT "invoices_issued_snapshot_check" CHECK ("status" <> 'issued' OR ("issue_date" IS NOT NULL AND "issued_at" IS NOT NULL AND "fx_rate" IS NOT NULL AND "amount_npr" IS NOT NULL AND "seller_snapshot" IS NOT NULL AND "buyer_snapshot" IS NOT NULL AND "content_hash" IS NOT NULL)),
	CONSTRAINT "invoices_due_date_check" CHECK ("due_date" >= "issue_date"),
	CONSTRAINT "invoices_fx_rate_check" CHECK ("fx_rate" > 0 AND "amount_npr" >= 0),
	CONSTRAINT "invoices_npr_snapshot_check" CHECK ("currency" <> 'NPR' OR "fx_rate" IS NULL OR ("fx_rate" = 1 AND "amount_npr" = "total")),
	CONSTRAINT "invoices_fx_source_check" CHECK ("currency" = 'NPR' OR "fx_rate" IS NULL OR ("fx_source" IS NOT NULL AND "fx_date" IS NOT NULL)),
	CONSTRAINT "invoices_snapshots_check" CHECK (jsonb_typeof("seller_snapshot") = 'object' AND jsonb_typeof("buyer_snapshot") = 'object'),
	CONSTRAINT "invoices_content_hash_check" CHECK (octet_length("content_hash") = 32),
	CONSTRAINT "invoices_calc_version_check" CHECK ("calc_version" >= 1),
	CONSTRAINT "invoices_discarded_check" CHECK (("status" = 'discarded') = ("discarded_at" IS NOT NULL)),
	CONSTRAINT "invoices_version_check" CHECK ("version" >= 1)
);
--> statement-breakpoint
-- G4. Not deferrable (a partial unique index cannot be): a re-draft discards the old draft first.
CREATE UNIQUE INDEX "invoices_one_live_tax_invoice_per_schedule_line" ON "app"."invoices" USING btree ("tenant_id", "organization_id", "schedule_line_id") WHERE "kind" = 'tax_invoice' AND "status" <> 'discarded' AND "schedule_line_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "invoices_tenant_customer_party_idx" ON "app"."invoices" USING btree ("tenant_id", "customer_party_id");
--> statement-breakpoint
CREATE INDEX "invoices_tenant_org_status_idx" ON "app"."invoices" USING btree ("tenant_id", "organization_id", "status");
--> statement-breakpoint
CREATE INDEX "invoices_tenant_org_original_idx" ON "app"."invoices" USING btree ("tenant_id", "organization_id", "original_invoice_id");
--> statement-breakpoint

-- One line of an invoice (same rules as quotation_lines): gross = round(quantity * unit_price, 2), taxable = gross -
-- discount_alloc. An SO slice is typically one line of quantity 1.
CREATE TABLE "app"."invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"description" text NOT NULL,
	"uom" text NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"unit_price" numeric(18, 2) NOT NULL,
	"tax_code_id" uuid NOT NULL,
	"gross" numeric(18, 2) NOT NULL,
	"discount_alloc" numeric(18, 2) DEFAULT 0 NOT NULL,
	"taxable" numeric(18, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_lines_tenant_id_unique" UNIQUE("tenant_id", "id"),
	CONSTRAINT "invoice_lines_tenant_org_invoice_line_no_unique" UNIQUE("tenant_id", "organization_id", "invoice_id", "line_no"),
	CONSTRAINT "invoice_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "invoice_lines_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "invoice_lines_invoice_fk" FOREIGN KEY ("tenant_id", "organization_id", "invoice_id") REFERENCES "app"."invoices"("tenant_id", "organization_id", "id"),
	CONSTRAINT "invoice_lines_tax_code_fk" FOREIGN KEY ("tenant_id", "tax_code_id") REFERENCES "app"."tax_codes"("tenant_id", "id"),
	CONSTRAINT "invoice_lines_line_no_check" CHECK ("line_no" >= 1),
	CONSTRAINT "invoice_lines_quantity_check" CHECK ("quantity" > 0),
	CONSTRAINT "invoice_lines_unit_price_check" CHECK ("unit_price" >= 0),
	CONSTRAINT "invoice_lines_gross_check" CHECK ("gross" = round("quantity" * "unit_price", 2)),
	CONSTRAINT "invoice_lines_discount_alloc_check" CHECK ("discount_alloc" >= 0 AND "discount_alloc" <= "gross"),
	CONSTRAINT "invoice_lines_taxable_check" CHECK ("taxable" = "gross" - "discount_alloc")
);
--> statement-breakpoint
CREATE INDEX "invoice_lines_tenant_tax_code_idx" ON "app"."invoice_lines" USING btree ("tenant_id", "tax_code_id");
--> statement-breakpoint

-- Tax per tax code of an invoice, rounded once per code. label and rate are copied from the tax code when priced.
CREATE TABLE "app"."invoice_tax_summary" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"tax_code_id" uuid NOT NULL,
	"label" text NOT NULL,
	"rate" numeric(7, 4) NOT NULL,
	"base" numeric(18, 2) NOT NULL,
	"tax" numeric(18, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_tax_summary_tenant_id_unique" UNIQUE("tenant_id", "id"),
	CONSTRAINT "invoice_tax_summary_tenant_org_invoice_tax_code_unique" UNIQUE("tenant_id", "organization_id", "invoice_id", "tax_code_id"),
	CONSTRAINT "invoice_tax_summary_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "invoice_tax_summary_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "invoice_tax_summary_invoice_fk" FOREIGN KEY ("tenant_id", "organization_id", "invoice_id") REFERENCES "app"."invoices"("tenant_id", "organization_id", "id"),
	CONSTRAINT "invoice_tax_summary_tax_code_fk" FOREIGN KEY ("tenant_id", "tax_code_id") REFERENCES "app"."tax_codes"("tenant_id", "id"),
	CONSTRAINT "invoice_tax_summary_rate_check" CHECK ("rate" BETWEEN 0 AND 100),
	CONSTRAINT "invoice_tax_summary_amounts_check" CHECK ("base" >= 0 AND "tax" >= 0)
);
--> statement-breakpoint

-- One print of an issued invoice: print_no 1 is the original, later ones print "Copy of original (n)".
CREATE TABLE "app"."invoice_print_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"print_no" integer NOT NULL,
	"printed_by" uuid,
	"printed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_print_log_tenant_id_unique" UNIQUE("tenant_id", "id"),
	CONSTRAINT "invoice_print_log_tenant_org_invoice_print_no_unique" UNIQUE("tenant_id", "organization_id", "invoice_id", "print_no"),
	CONSTRAINT "invoice_print_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "invoice_print_log_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "invoice_print_log_invoice_fk" FOREIGN KEY ("tenant_id", "organization_id", "invoice_id") REFERENCES "app"."invoices"("tenant_id", "organization_id", "id"),
	CONSTRAINT "invoice_print_log_printed_by_user_fk" FOREIGN KEY ("tenant_id", "printed_by") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "invoice_print_log_print_no_check" CHECK ("print_no" >= 1)
);
--> statement-breakpoint

-- The schedule line's half of the cycle (0020 left it): the invoice of a drafted or invoiced line is an invoice of the
-- line's own order and entity. MATCH SIMPLE: not checked while invoice_id is NULL.
ALTER TABLE "app"."billing_schedule_lines" ADD CONSTRAINT "billing_schedule_lines_invoice_fk" FOREIGN KEY ("tenant_id", "organization_id", "sales_order_id", "invoice_id") REFERENCES "app"."invoices"("tenant_id", "organization_id", "sales_order_id", "id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------
-- Triggers. Not SECURITY DEFINER: they read only rows the writing role may read already. Errors are check_violation
-- with the named pseudo-constraint, as 0011, 0016 and 0019 do.
-- ---------------------------------------------------------------------------------------------------------------

-- invoices: inserted as draft; identity never changes; an issued invoice never changes at all (the whole row is
-- compared, minus version and updated_at, and minus the generated customer_party_kind, which a BEFORE trigger sees as
-- NULL); a discarded one stays discarded; only a draft may be deleted.
CREATE FUNCTION "app"."invoices_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
	v_ignored CONSTANT text[] := ARRAY['version', 'updated_at', 'customer_party_kind'];
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NEW."status" <> 'draft' THEN
			RAISE EXCEPTION 'invoice % must be created as draft, not %', NEW."id", NEW."status"
				USING ERRCODE = 'check_violation', CONSTRAINT = 'invoices_insert_draft_check';
		END IF;
		RETURN NEW;
	END IF;
	IF TG_OP = 'DELETE' THEN
		IF OLD."status" <> 'draft' THEN
			RAISE EXCEPTION 'invoice % is % and cannot be deleted', OLD."id", OLD."status"
				USING ERRCODE = 'check_violation', CONSTRAINT = 'invoices_frozen_check';
		END IF;
		RETURN OLD;
	END IF;
	IF OLD."id" IS DISTINCT FROM NEW."id"
		OR OLD."tenant_id" IS DISTINCT FROM NEW."tenant_id"
		OR OLD."organization_id" IS DISTINCT FROM NEW."organization_id"
		OR OLD."kind" IS DISTINCT FROM NEW."kind"
		OR OLD."created_at" IS DISTINCT FROM NEW."created_at" THEN
		RAISE EXCEPTION 'invoice %: identity columns cannot change', OLD."id"
			USING ERRCODE = 'check_violation', CONSTRAINT = 'invoices_identity_check';
	END IF;
	IF OLD."status" = 'issued' AND (to_jsonb(NEW) - v_ignored) IS DISTINCT FROM (to_jsonb(OLD) - v_ignored) THEN
		RAISE EXCEPTION 'invoice % is issued and immutable; correct it with a credit or debit note', OLD."id"
			USING ERRCODE = 'check_violation', CONSTRAINT = 'invoices_issued_immutable_check';
	END IF;
	IF OLD."status" = 'discarded' AND NEW."status" <> 'discarded' THEN
		RAISE EXCEPTION 'invoice % is discarded', OLD."id"
			USING ERRCODE = 'check_violation', CONSTRAINT = 'invoices_frozen_check';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "app"."invoices_guard"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "invoices_guard" BEFORE INSERT OR UPDATE OR DELETE ON "app"."invoices"
FOR EACH ROW EXECUTE FUNCTION "app"."invoices_guard"();
--> statement-breakpoint

-- Lines and tax summary: any INSERT, UPDATE or DELETE needs the invoice (the OLD and the NEW one) in draft or
-- returned. FOR SHARE locks the invoice, so a concurrent submit or issue waits for this write instead of hashing
-- content that is about to change. A missing invoice is left to the foreign key.
CREATE FUNCTION "app"."invoice_children_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
	v_status text;
BEGIN
	IF TG_OP IN ('UPDATE', 'DELETE') THEN
		SELECT i."status" INTO v_status FROM "app"."invoices" i
		 WHERE i."tenant_id" = OLD."tenant_id" AND i."id" = OLD."invoice_id" FOR SHARE;
		IF v_status NOT IN ('draft', 'returned') THEN
			RAISE EXCEPTION '%: invoice % is % and frozen', TG_TABLE_NAME, OLD."invoice_id", v_status
				USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_frozen_check';
		END IF;
	END IF;
	IF TG_OP IN ('INSERT', 'UPDATE') THEN
		SELECT i."status" INTO v_status FROM "app"."invoices" i
		 WHERE i."tenant_id" = NEW."tenant_id" AND i."id" = NEW."invoice_id" FOR SHARE;
		IF v_status NOT IN ('draft', 'returned') THEN
			RAISE EXCEPTION '%: invoice % is % and frozen', TG_TABLE_NAME, NEW."invoice_id", v_status
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
REVOKE EXECUTE ON FUNCTION "app"."invoice_children_guard"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "invoice_lines_guard" BEFORE INSERT OR UPDATE OR DELETE ON "app"."invoice_lines"
FOR EACH ROW EXECUTE FUNCTION "app"."invoice_children_guard"();
--> statement-breakpoint
CREATE TRIGGER "invoice_tax_summary_guard" BEFORE INSERT OR UPDATE OR DELETE ON "app"."invoice_tax_summary"
FOR EACH ROW EXECUTE FUNCTION "app"."invoice_children_guard"();
--> statement-breakpoint

-- Credit and debit notes, at commit: the original is an issued tax invoice of the same customer and currency, and the
-- live credit notes of it sum to at most its total. The original is locked first (FOR NO KEY UPDATE, which fires no
-- trigger and does not wait on FK KEY SHARE locks), so two transactions crediting one invoice serialise and the
-- second sums the first's committed notes.
CREATE FUNCTION "app"."invoices_notes"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
	v_original record;
	v_credited numeric;
BEGIN
	IF NEW."kind" NOT IN ('credit_note', 'debit_note') OR NEW."status" = 'discarded' THEN
		RETURN NULL;
	END IF;
	SELECT i."kind", i."status", i."currency", i."customer_party_id", i."total" INTO v_original
	  FROM "app"."invoices" i
	 WHERE i."tenant_id" = NEW."tenant_id" AND i."organization_id" = NEW."organization_id"
	   AND i."id" = NEW."original_invoice_id"
	 FOR NO KEY UPDATE;
	IF NOT FOUND THEN
		RETURN NULL;
	END IF;
	IF v_original."kind" <> 'tax_invoice' OR v_original."status" <> 'issued'
		OR v_original."currency" <> NEW."currency"
		OR v_original."customer_party_id" IS DISTINCT FROM NEW."customer_party_id" THEN
		RAISE EXCEPTION 'invoice %: a % must name an issued tax invoice of the same customer and currency', NEW."id", NEW."kind"
			USING ERRCODE = 'check_violation', CONSTRAINT = 'invoices_note_original_issued_check';
	END IF;
	IF NEW."kind" = 'credit_note' THEN
		SELECT COALESCE(sum(i."total"), 0) INTO v_credited FROM "app"."invoices" i
		 WHERE i."tenant_id" = NEW."tenant_id" AND i."organization_id" = NEW."organization_id"
		   AND i."original_invoice_id" = NEW."original_invoice_id"
		   AND i."kind" = 'credit_note' AND i."status" <> 'discarded';
		IF v_credited > v_original."total" THEN
			RAISE EXCEPTION 'invoice %: credit notes would total % of %', NEW."original_invoice_id", v_credited, v_original."total"
				USING ERRCODE = 'check_violation', CONSTRAINT = 'invoices_credit_cap_check';
		END IF;
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "app"."invoices_notes"() FROM PUBLIC;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "invoices_notes" AFTER INSERT OR UPDATE ON "app"."invoices"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "app"."invoices_notes"();
--> statement-breakpoint

-- The print log is a record of what happened: never rewritten or removed.
CREATE FUNCTION "app"."invoice_print_log_append_only"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
	RAISE EXCEPTION '%: rows are append-only (% refused)', TG_TABLE_NAME, TG_OP
		USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_append_only';
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "app"."invoice_print_log_append_only"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "invoice_print_log_append_only" BEFORE UPDATE OR DELETE ON "app"."invoice_print_log"
FOR EACH ROW EXECUTE FUNCTION "app"."invoice_print_log_append_only"();
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "app"."invoice_print_log" FROM "bos_app";
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------
-- Audit: every write to these tables lands in the hash chain.
-- ---------------------------------------------------------------------------------------------------------------
SELECT audit.attach('app.invoices');
--> statement-breakpoint
SELECT audit.attach('app.invoice_lines');
--> statement-breakpoint
SELECT audit.attach('app.invoice_tax_summary');
--> statement-breakpoint
SELECT audit.attach('app.invoice_print_log');
