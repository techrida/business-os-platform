-- 0020_sales_orders: the sales order and its billing schedule (P3 plan unit U1; decisions A2, A7, A8, A14, A15).
-- Money is numeric(18,2), quantities numeric(18,4), FX rates numeric(18,6) (ground rules).
--
-- Every table is entity-owned (ADR 0027): tenant_id + organization_id NOT NULL with (tenant_id, organization_id) ->
-- organizations (<table>_tenant_org_fk); a FK into another entity-owned table is (tenant_id, organization_id, x); a
-- FK into a tenant-level table (parties, customers, users, tax_codes) is (tenant_id, x).
--
-- The model:
--   * A sales order is the confirmed sale: one quotation version (quotation_version_fk points through
--     (tenant_id, organization_id, quotation_id, id), so the version belongs to the named quotation and entity),
--     with the totals copied from it and an inline NPR snapshot. That the version is Accepted and its evidence
--     policy is met is checked by the service at confirm (U9), not here.
--   * customer_party_id is the counterparty column of ADR 0027 section 5: nullable for check-tenancy, kind checked
--     through the stored generated 'customer' column, plus a FK to the CRM customer. sales_orders_customer_check
--     still requires it on every row.
--   * number, seq and fiscal_year come together from NumberingService at confirm (SO series, A15): never on a draft,
--     always on a confirmed or completed order. A draft cancelled before confirm has none.
--   * One live order per quotation (sales_orders_one_live_per_quotation): live is every status but cancelled, so a
--     double confirm makes one SO.
--   * billing_schedule_lines are VAT-inclusive slices of the SO total. At commit, the live (not cancelled) lines of
--     an order sum to its total (billing_schedule_lines_sum, a DEFERRABLE INITIALLY DEFERRED constraint trigger,
--     fired by the lines and by a change of the order's total or status), unless the order is cancelled or has no
--     schedule yet. One transaction may therefore re-split a schedule through an unbalanced state.
--   * A drafted or invoiced line names its invoice, and no other line does (billing_schedule_lines_invoice_check).
--     The FK of invoice_id is added by 0021, which creates invoices.
--   * Paid is derived from the ledger (A8): no paid or amount_paid column.
--
-- Every table is audited (audit.attach). No GRANT: 0008's default privileges give bos_app SELECT, INSERT, UPDATE,
-- DELETE on new tables. version is the optimistic lock; updated_at is set by the API.
-- Runs as bos_owner, split at the breakpoint comments. Names follow the K1-U2 convention, mirrored in
-- src/schema/sales.ts.

-- The confirmed sale. Totals are the accepted version's: taxable = subtotal - discount, total = taxable + tax.
-- NPR snapshot (C-11): fx_rate is NPR per unit (1 for NPR), amount_npr the NPR total; a foreign currency names its
-- rate source and date. credit_days is the due period of its invoices.
CREATE TABLE "app"."sales_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text,
	"seq" bigint,
	"fiscal_year" text,
	"customer_party_id" uuid,
	"customer_party_kind" text GENERATED ALWAYS AS ('customer') STORED,
	"quotation_id" uuid NOT NULL,
	"quotation_version_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"currency" char(3) NOT NULL,
	"subtotal" numeric(18, 2) NOT NULL,
	"discount_amount" numeric(18, 2) DEFAULT 0 NOT NULL,
	"taxable_amount" numeric(18, 2) NOT NULL,
	"tax_amount" numeric(18, 2) NOT NULL,
	"total" numeric(18, 2) NOT NULL,
	"fx_rate" numeric(18, 6) NOT NULL,
	"fx_source" text,
	"fx_date" date,
	"amount_npr" numeric(18, 2) NOT NULL,
	"calc_version" integer DEFAULT 1 NOT NULL,
	"credit_days" integer DEFAULT 0 NOT NULL,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_orders_tenant_id_unique" UNIQUE("tenant_id", "id"),
	CONSTRAINT "sales_orders_tenant_org_id_unique" UNIQUE("tenant_id", "organization_id", "id"),
	CONSTRAINT "sales_orders_tenant_org_number_unique" UNIQUE("tenant_id", "organization_id", "number"),
	CONSTRAINT "sales_orders_tenant_org_fy_seq_unique" UNIQUE("tenant_id", "organization_id", "fiscal_year", "seq"),
	CONSTRAINT "sales_orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "sales_orders_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "sales_orders_customer_party_fk" FOREIGN KEY ("tenant_id", "customer_party_id", "customer_party_kind") REFERENCES "app"."parties"("tenant_id", "id", "kind"),
	CONSTRAINT "sales_orders_customer_fk" FOREIGN KEY ("tenant_id", "customer_party_id") REFERENCES "app"."customers"("tenant_id", "id"),
	CONSTRAINT "sales_orders_quotation_version_fk" FOREIGN KEY ("tenant_id", "organization_id", "quotation_id", "quotation_version_id") REFERENCES "app"."quotation_versions"("tenant_id", "organization_id", "quotation_id", "id"),
	CONSTRAINT "sales_orders_confirmed_by_user_fk" FOREIGN KEY ("tenant_id", "confirmed_by") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "sales_orders_created_by_user_fk" FOREIGN KEY ("tenant_id", "created_by") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "sales_orders_status_check" CHECK ("status" in ('draft', 'confirmed', 'completed', 'cancelled')),
	CONSTRAINT "sales_orders_customer_check" CHECK ("customer_party_id" IS NOT NULL),
	CONSTRAINT "sales_orders_currency_check" CHECK ("currency" in ('NPR', 'INR', 'USD')),
	CONSTRAINT "sales_orders_amounts_check" CHECK ("subtotal" >= 0 AND "discount_amount" >= 0 AND "discount_amount" <= "subtotal" AND "tax_amount" >= 0 AND "total" > 0),
	CONSTRAINT "sales_orders_taxable_check" CHECK ("taxable_amount" = "subtotal" - "discount_amount"),
	CONSTRAINT "sales_orders_total_check" CHECK ("total" = "taxable_amount" + "tax_amount"),
	CONSTRAINT "sales_orders_fx_rate_check" CHECK ("fx_rate" > 0),
	CONSTRAINT "sales_orders_amount_npr_check" CHECK ("amount_npr" > 0),
	CONSTRAINT "sales_orders_npr_snapshot_check" CHECK ("currency" <> 'NPR' OR ("fx_rate" = 1 AND "amount_npr" = "total")),
	CONSTRAINT "sales_orders_fx_source_check" CHECK ("currency" = 'NPR' OR ("fx_source" IS NOT NULL AND "fx_date" IS NOT NULL)),
	CONSTRAINT "sales_orders_calc_version_check" CHECK ("calc_version" >= 1),
	CONSTRAINT "sales_orders_credit_days_check" CHECK ("credit_days" BETWEEN 0 AND 365),
	CONSTRAINT "sales_orders_number_parts_check" CHECK (("number" IS NULL) = ("seq" IS NULL) AND ("number" IS NULL) = ("fiscal_year" IS NULL) AND "seq" >= 1 AND "fiscal_year" ~ '^[0-9]{4}/[0-9]{2}$'),
	CONSTRAINT "sales_orders_number_status_check" CHECK (("status" <> 'draft' OR "number" IS NULL) AND ("status" NOT IN ('confirmed', 'completed') OR ("number" IS NOT NULL AND "confirmed_at" IS NOT NULL))),
	CONSTRAINT "sales_orders_cancel_check" CHECK (("status" = 'cancelled') = ("cancelled_at" IS NOT NULL) AND ("status" <> 'cancelled' OR "cancel_reason" IS NOT NULL)),
	CONSTRAINT "sales_orders_version_check" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "sales_orders_one_live_per_quotation" ON "app"."sales_orders" USING btree ("tenant_id", "organization_id", "quotation_id") WHERE "status" <> 'cancelled';
--> statement-breakpoint
CREATE INDEX "sales_orders_tenant_customer_party_idx" ON "app"."sales_orders" USING btree ("tenant_id", "customer_party_id");
--> statement-breakpoint
CREATE INDEX "sales_orders_tenant_org_status_idx" ON "app"."sales_orders" USING btree ("tenant_id", "organization_id", "status");
--> statement-breakpoint

-- A frozen copy of the accepted version's priced lines (same rules as quotation_lines): gross = round(quantity *
-- unit_price, 2), taxable = gross - discount_alloc.
CREATE TABLE "app"."sales_order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"sales_order_id" uuid NOT NULL,
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
	CONSTRAINT "sales_order_lines_tenant_id_unique" UNIQUE("tenant_id", "id"),
	CONSTRAINT "sales_order_lines_tenant_org_order_line_no_unique" UNIQUE("tenant_id", "organization_id", "sales_order_id", "line_no"),
	CONSTRAINT "sales_order_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "sales_order_lines_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "sales_order_lines_sales_order_fk" FOREIGN KEY ("tenant_id", "organization_id", "sales_order_id") REFERENCES "app"."sales_orders"("tenant_id", "organization_id", "id"),
	CONSTRAINT "sales_order_lines_tax_code_fk" FOREIGN KEY ("tenant_id", "tax_code_id") REFERENCES "app"."tax_codes"("tenant_id", "id"),
	CONSTRAINT "sales_order_lines_line_no_check" CHECK ("line_no" >= 1),
	CONSTRAINT "sales_order_lines_quantity_check" CHECK ("quantity" > 0),
	CONSTRAINT "sales_order_lines_unit_price_check" CHECK ("unit_price" >= 0),
	CONSTRAINT "sales_order_lines_gross_check" CHECK ("gross" = round("quantity" * "unit_price", 2)),
	CONSTRAINT "sales_order_lines_discount_alloc_check" CHECK ("discount_alloc" >= 0 AND "discount_alloc" <= "gross"),
	CONSTRAINT "sales_order_lines_taxable_check" CHECK ("taxable" = "gross" - "discount_alloc")
);
--> statement-breakpoint
CREATE INDEX "sales_order_lines_tenant_tax_code_idx" ON "app"."sales_order_lines" USING btree ("tenant_id", "tax_code_id");
--> statement-breakpoint

-- Tax per tax code, copied from the version's tax summary. rate is in percent, numeric(7,4).
CREATE TABLE "app"."sales_order_tax_summary" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"sales_order_id" uuid NOT NULL,
	"tax_code_id" uuid NOT NULL,
	"label" text NOT NULL,
	"rate" numeric(7, 4) NOT NULL,
	"base" numeric(18, 2) NOT NULL,
	"tax" numeric(18, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_order_tax_summary_tenant_id_unique" UNIQUE("tenant_id", "id"),
	CONSTRAINT "sales_order_tax_summary_tenant_org_order_tax_code_unique" UNIQUE("tenant_id", "organization_id", "sales_order_id", "tax_code_id"),
	CONSTRAINT "sales_order_tax_summary_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "sales_order_tax_summary_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "sales_order_tax_summary_sales_order_fk" FOREIGN KEY ("tenant_id", "organization_id", "sales_order_id") REFERENCES "app"."sales_orders"("tenant_id", "organization_id", "id"),
	CONSTRAINT "sales_order_tax_summary_tax_code_fk" FOREIGN KEY ("tenant_id", "tax_code_id") REFERENCES "app"."tax_codes"("tenant_id", "id"),
	CONSTRAINT "sales_order_tax_summary_rate_check" CHECK ("rate" BETWEEN 0 AND 100),
	CONSTRAINT "sales_order_tax_summary_amounts_check" CHECK ("base" >= 0 AND "tax" >= 0)
);
--> statement-breakpoint

-- The evidence the order was confirmed on (contract, PO, signed quotation; C-14): kernel documents of the entity.
CREATE TABLE "app"."sales_order_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"sales_order_id" uuid NOT NULL,
	"evidence_kind" text NOT NULL,
	"document_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_order_evidence_tenant_id_unique" UNIQUE("tenant_id", "id"),
	CONSTRAINT "sales_order_evidence_tenant_org_order_document_unique" UNIQUE("tenant_id", "organization_id", "sales_order_id", "document_id"),
	CONSTRAINT "sales_order_evidence_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "sales_order_evidence_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "sales_order_evidence_sales_order_fk" FOREIGN KEY ("tenant_id", "organization_id", "sales_order_id") REFERENCES "app"."sales_orders"("tenant_id", "organization_id", "id"),
	CONSTRAINT "sales_order_evidence_document_fk" FOREIGN KEY ("tenant_id", "organization_id", "document_id") REFERENCES "app"."documents"("tenant_id", "organization_id", "id"),
	CONSTRAINT "sales_order_evidence_created_by_user_fk" FOREIGN KEY ("tenant_id", "created_by") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "sales_order_evidence_kind_check" CHECK ("evidence_kind" in ('contract', 'purchase_order', 'signed_quote'))
);
--> statement-breakpoint

-- One VAT-inclusive slice of the SO total (A7: 60/20/20 by default). percent_bp is informational (6000 = 60%);
-- amount is what gets billed, amount_npr its NPR value at the SO's rate. trigger says what makes it billable; an
-- advance line starts billable at confirm (U9). invoice_id is set while drafted or invoiced (FK in 0021).
-- (tenant_id, organization_id, sales_order_id, id) is unique so an invoice can name a line of its own order.
CREATE TABLE "app"."billing_schedule_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"sales_order_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"label" text NOT NULL,
	"trigger" text NOT NULL,
	"percent_bp" integer,
	"amount" numeric(18, 2) NOT NULL,
	"amount_npr" numeric(18, 2) NOT NULL,
	"planned_date" date,
	"status" text DEFAULT 'planned' NOT NULL,
	"billable_evidence_document_id" uuid,
	"billable_marked_by" uuid,
	"billable_marked_at" timestamp with time zone,
	"invoice_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_schedule_lines_tenant_id_unique" UNIQUE("tenant_id", "id"),
	CONSTRAINT "billing_schedule_lines_tenant_org_id_unique" UNIQUE("tenant_id", "organization_id", "id"),
	CONSTRAINT "billing_schedule_lines_tenant_org_order_id_unique" UNIQUE("tenant_id", "organization_id", "sales_order_id", "id"),
	CONSTRAINT "billing_schedule_lines_tenant_org_order_seq_unique" UNIQUE("tenant_id", "organization_id", "sales_order_id", "seq"),
	CONSTRAINT "billing_schedule_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "billing_schedule_lines_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "billing_schedule_lines_sales_order_fk" FOREIGN KEY ("tenant_id", "organization_id", "sales_order_id") REFERENCES "app"."sales_orders"("tenant_id", "organization_id", "id"),
	CONSTRAINT "billing_schedule_lines_evidence_document_fk" FOREIGN KEY ("tenant_id", "organization_id", "billable_evidence_document_id") REFERENCES "app"."documents"("tenant_id", "organization_id", "id"),
	CONSTRAINT "billing_schedule_lines_billable_marked_by_user_fk" FOREIGN KEY ("tenant_id", "billable_marked_by") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "billing_schedule_lines_seq_check" CHECK ("seq" >= 1),
	CONSTRAINT "billing_schedule_lines_trigger_check" CHECK ("trigger" in ('advance', 'milestone', 'uat', 'delivery', 'date', 'manual')),
	CONSTRAINT "billing_schedule_lines_status_check" CHECK ("status" in ('planned', 'billable', 'drafted', 'invoiced', 'cancelled')),
	CONSTRAINT "billing_schedule_lines_percent_bp_check" CHECK ("percent_bp" BETWEEN 1 AND 10000),
	CONSTRAINT "billing_schedule_lines_amount_check" CHECK ("amount" > 0 AND "amount_npr" > 0),
	CONSTRAINT "billing_schedule_lines_invoice_check" CHECK (("status" IN ('drafted', 'invoiced')) = ("invoice_id" IS NOT NULL)),
	CONSTRAINT "billing_schedule_lines_version_check" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE INDEX "billing_schedule_lines_tenant_org_invoice_idx" ON "app"."billing_schedule_lines" USING btree ("tenant_id", "organization_id", "invoice_id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------
-- The schedule sum (S1). Checked at commit for every order a statement touched. The order row is locked first
-- (FOR NO KEY UPDATE, as 0019's cap: it must not wait on the KEY SHARE locks the lines' FKs hold), so two
-- transactions that change one schedule serialise and the second sums the first's committed rows.
-- Not SECURITY DEFINER: it reads only rows the writing role may read already. The helper is called from the two
-- trigger functions in the writer's role, so bos_app keeps EXECUTE on it.
-- ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION "app"."billing_schedule_check_sum"(p_tenant uuid, p_org uuid, p_order uuid) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
	v_status text;
	v_total numeric;
	v_lines bigint;
	v_live numeric;
BEGIN
	SELECT so."status", so."total" INTO v_status, v_total FROM "app"."sales_orders" so
	 WHERE so."tenant_id" = p_tenant AND so."organization_id" = p_org AND so."id" = p_order
	 FOR NO KEY UPDATE;
	IF NOT FOUND OR v_status = 'cancelled' THEN
		RETURN;
	END IF;
	SELECT count(*), COALESCE(sum(l."amount") FILTER (WHERE l."status" <> 'cancelled'), 0)
	  INTO v_lines, v_live
	  FROM "app"."billing_schedule_lines" l
	 WHERE l."tenant_id" = p_tenant AND l."organization_id" = p_org AND l."sales_order_id" = p_order;
	IF v_lines > 0 AND v_live <> v_total THEN
		RAISE EXCEPTION 'sales order %: live schedule lines sum to %, not the order total %', p_order, v_live, v_total
			USING ERRCODE = 'check_violation', CONSTRAINT = 'billing_schedule_lines_sum_check';
	END IF;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "app"."billing_schedule_check_sum"(uuid, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "app"."billing_schedule_check_sum"(uuid, uuid, uuid) TO "bos_app";
--> statement-breakpoint
CREATE FUNCTION "app"."billing_schedule_lines_sum"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
	IF TG_OP IN ('UPDATE', 'DELETE') THEN
		PERFORM "app"."billing_schedule_check_sum"(OLD."tenant_id", OLD."organization_id", OLD."sales_order_id");
	END IF;
	IF TG_OP IN ('INSERT', 'UPDATE') THEN
		PERFORM "app"."billing_schedule_check_sum"(NEW."tenant_id", NEW."organization_id", NEW."sales_order_id");
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "app"."billing_schedule_lines_sum"() FROM PUBLIC;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "billing_schedule_lines_sum" AFTER INSERT OR UPDATE OR DELETE ON "app"."billing_schedule_lines"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "app"."billing_schedule_lines_sum"();
--> statement-breakpoint
CREATE FUNCTION "app"."sales_orders_schedule_sum"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
	PERFORM "app"."billing_schedule_check_sum"(NEW."tenant_id", NEW."organization_id", NEW."id");
	RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "app"."sales_orders_schedule_sum"() FROM PUBLIC;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "sales_orders_schedule_sum" AFTER UPDATE OF "total", "status" ON "app"."sales_orders"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "app"."sales_orders_schedule_sum"();
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------
-- Audit: every write to these tables lands in the hash chain.
-- ---------------------------------------------------------------------------------------------------------------
SELECT audit.attach('app.sales_orders');
--> statement-breakpoint
SELECT audit.attach('app.sales_order_lines');
--> statement-breakpoint
SELECT audit.attach('app.sales_order_tax_summary');
--> statement-breakpoint
SELECT audit.attach('app.sales_order_evidence');
--> statement-breakpoint
SELECT audit.attach('app.billing_schedule_lines');
