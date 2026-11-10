-- Keep discarded drafts for audit and references while releasing their reservations.
ALTER TABLE "app"."receipts" DROP CONSTRAINT "receipts_status_check";
--> statement-breakpoint
ALTER TABLE "app"."receipts" ADD CONSTRAINT "receipts_status_check" CHECK ("status" in ('draft', 'confirmed', 'reversed', 'discarded'));
--> statement-breakpoint
ALTER TABLE "app"."receipts" DROP CONSTRAINT "receipts_confirmed_check";
--> statement-breakpoint
ALTER TABLE "app"."receipts" ADD CONSTRAINT "receipts_confirmed_check" CHECK ("status" in ('draft', 'discarded') OR ("confirmed_by" IS NOT NULL AND "confirmed_at" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "app"."vendor_bills" DROP CONSTRAINT "vendor_bills_status_check";
--> statement-breakpoint
ALTER TABLE "app"."vendor_bills" ADD CONSTRAINT "vendor_bills_status_check" CHECK ("status" in ('draft', 'matching', 'variance', 'exception_pending', 'pending_approval', 'approved', 'partially_paid', 'paid', 'voided', 'rejected', 'discarded'));
--> statement-breakpoint
ALTER TABLE "app"."vendor_bills" DROP CONSTRAINT "vendor_bills_tenant_org_vendor_invoice_fy_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_bills_tenant_org_vendor_invoice_fy_unique" ON "app"."vendor_bills" USING btree ("tenant_id", "organization_id", "vendor_id", "invoice_no_norm", "fiscal_year") WHERE "status" <> 'discarded';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "app"."receipt_lines_guard"() RETURNS trigger
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
		 JOIN "app"."receipts" r ON r."tenant_id" = l."tenant_id" AND r."organization_id" = l."organization_id" AND r."id" = l."receipt_id"
		 WHERE l."tenant_id" = NEW."tenant_id" AND l."po_line_id" = NEW."po_line_id" AND l."id" <> NEW."id" AND r."status" <> 'discarded';
		IF v_received + NEW."quantity" > v_open THEN
			RAISE EXCEPTION '%: receiving % on PO line % takes the net received to %, above the % still open', TG_TABLE_NAME, NEW."quantity", NEW."po_line_id", v_received + NEW."quantity", v_open
				USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_over_receipt_check';
		END IF;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "app"."purchase_order_lines_open_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
	v_received numeric;
BEGIN
	IF NEW."ordered_quantity" - NEW."cancelled_quantity" < OLD."ordered_quantity" - OLD."cancelled_quantity" THEN
		SELECT COALESCE(sum(l."quantity"), 0) INTO v_received FROM "app"."receipt_lines" l
		 JOIN "app"."receipts" r ON r."tenant_id" = l."tenant_id" AND r."organization_id" = l."organization_id" AND r."id" = l."receipt_id"
		 WHERE l."tenant_id" = NEW."tenant_id" AND l."po_line_id" = NEW."id" AND r."status" <> 'discarded';
		IF NEW."ordered_quantity" - NEW."cancelled_quantity" < v_received THEN
			RAISE EXCEPTION '%: line % has % received, more than the % left open', TG_TABLE_NAME, NEW."id", v_received, NEW."ordered_quantity" - NEW."cancelled_quantity"
				USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_open_quantity_check';
		END IF;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE VIEW "app"."v_po_line_progress" WITH (security_invoker = true) AS
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
	WHERE bl."po_line_id" IS NOT NULL AND vb."status" NOT IN ('voided', 'rejected', 'discarded')
	GROUP BY bl."tenant_id", bl."organization_id", bl."po_line_id"
) b ON b."tenant_id" = pol."tenant_id" AND b."organization_id" = pol."organization_id" AND b."po_line_id" = pol."id";
