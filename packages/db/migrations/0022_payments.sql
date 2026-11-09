-- 0022_payments: customer receipts of P3 (plan unit U2, decisions A8, A9, A13, A15).
-- Money is numeric(18,2) and FX rates numeric(18,6) (ground rules). Both tables are entity-owned:
-- (tenant_id, organization_id) -> organizations (<table>_tenant_org_fk); a FK into another entity-owned table
-- (payments, documents) is (tenant_id, organization_id, x); a FK into a tenant-level table (parties, users,
-- withholding_codes) is (tenant_id, x[, kind]). No table is added to check-tenancy's TENANT_SCOPED list.
--
-- The model:
--   * A payment is cash a customer says it sent (submitted by staff or through the portal), until a second person
--     verifies it. Verifying numbers it (RCPT-{FY}-{seq:05}, A15) and freezes the NPR snapshot; the ledger open item
--     (source_type 'payment', amount = settles) is written by LedgerService, not here. A payment does not mark an
--     invoice paid: that comes only from allocations (A8), so there is no paid or allocated column.
--   * settles = amount + tds_withheld: what the payment clears on the customer's account. amount is the cash that
--     arrived, tds_withheld the tax the customer kept back (withholding_code_id names the TDS code, optional).
--   * Currency is NPR, INR or USD, and the allocation trigger of 0019 keeps it equal to the invoice's (A13).
--   * Customer (A9): customer_party_id with a stored generated kind, so the parties FK refuses a vendor. The column is
--     nullable because check-tenancy's counterparty rule demands it; payments_customer_party_check requires it.
--   * Segregation of duties: the verifier is never the submitter (payments_verifier_check).
--   * Number (A15): number, seq and fiscal_year are all NULL or all set, and set exactly when the payment is verified
--     or reversed (payments_number_status_check), so a submitted, rejected or withdrawn payment has none.
--   * NPR snapshot (C-11): a submitter cannot know the rate, so the snapshot (fx_rate, fx_source, fx_date,
--     amount_npr, tds_npr) may be empty while submitted and is required once verified or reversed
--     (payments_snapshot_status_check). An NPR payment's snapshot is rate 1 and equal amounts.
--   * Lifecycle: a payment is mutable only while submitted (version and updated_at serve updateVersioned). From
--     submitted it goes to verified, rejected or withdrawn; verified goes to reversed; nothing else moves
--     (payments_guard). After it leaves submitted, only status, version and updated_at may change. bos_app cannot
--     DELETE a payment: a mistaken one is withdrawn or rejected.
--   * payment_proofs links a payment to uploaded documents of the same entity (composite FKs). It is append-only
--     (the 0019 raise function plus REVOKE UPDATE, DELETE), so evidence is never swapped after the fact.
-- Both tables are audited (audit.attach). DDL only: no row is written. Runs as bos_owner, split at the breakpoints.
-- Names follow the K1-U2 convention, mirrored in src/schema/payments.ts.

CREATE TABLE "app"."payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_party_id" uuid,
	"customer_party_kind" text GENERATED ALWAYS AS ('customer') STORED,
	"status" text DEFAULT 'submitted' NOT NULL,
	"method" text NOT NULL,
	"currency" char(3) NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"tds_withheld" numeric(18, 2) DEFAULT 0 NOT NULL,
	"withholding_code_id" uuid,
	"settles" numeric(18, 2) GENERATED ALWAYS AS ("amount" + "tds_withheld") STORED,
	"received_on" date NOT NULL,
	"bank_reference" text,
	"fx_rate" numeric(18, 6),
	"fx_source" text,
	"fx_date" date,
	"amount_npr" numeric(18, 2),
	"tds_npr" numeric(18, 2),
	"settles_npr" numeric(18, 2) GENERATED ALWAYS AS ("amount_npr" + "tds_npr") STORED,
	"submitted_by" uuid NOT NULL,
	"channel" text NOT NULL,
	"verified_by" uuid,
	"verified_at" timestamp with time zone,
	"rejection_reason" text,
	"number" text,
	"seq" bigint,
	"fiscal_year" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_tenant_id_unique" UNIQUE("tenant_id", "id"),
	CONSTRAINT "payments_tenant_org_id_unique" UNIQUE("tenant_id", "organization_id", "id"),
	CONSTRAINT "payments_tenant_org_number_unique" UNIQUE("tenant_id", "organization_id", "number"),
	CONSTRAINT "payments_tenant_org_fy_seq_unique" UNIQUE("tenant_id", "organization_id", "fiscal_year", "seq"),
	CONSTRAINT "payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "payments_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "payments_customer_party_fk" FOREIGN KEY ("tenant_id", "customer_party_id", "customer_party_kind") REFERENCES "app"."parties"("tenant_id", "id", "kind"),
	CONSTRAINT "payments_withholding_code_fk" FOREIGN KEY ("tenant_id", "withholding_code_id") REFERENCES "app"."withholding_codes"("tenant_id", "id"),
	CONSTRAINT "payments_submitted_by_user_fk" FOREIGN KEY ("tenant_id", "submitted_by") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "payments_verified_by_user_fk" FOREIGN KEY ("tenant_id", "verified_by") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "payments_customer_party_check" CHECK ("customer_party_id" IS NOT NULL),
	CONSTRAINT "payments_status_check" CHECK ("status" in ('submitted', 'verified', 'rejected', 'withdrawn', 'reversed')),
	CONSTRAINT "payments_method_check" CHECK ("method" in ('bank_transfer', 'qr', 'wire', 'cheque', 'cash')),
	CONSTRAINT "payments_channel_check" CHECK ("channel" in ('staff', 'portal')),
	CONSTRAINT "payments_currency_check" CHECK ("currency" in ('NPR', 'INR', 'USD')),
	CONSTRAINT "payments_amount_check" CHECK ("amount" > 0),
	CONSTRAINT "payments_tds_withheld_check" CHECK ("tds_withheld" >= 0),
	CONSTRAINT "payments_bank_reference_check" CHECK ("bank_reference" IS NULL OR btrim("bank_reference") <> ''),
	CONSTRAINT "payments_fx_rate_check" CHECK ("fx_rate" IS NULL OR "fx_rate" > 0),
	CONSTRAINT "payments_npr_amounts_check" CHECK (("amount_npr" IS NULL OR "amount_npr" > 0) AND ("tds_npr" IS NULL OR "tds_npr" >= 0)),
	CONSTRAINT "payments_snapshot_complete_check" CHECK (("fx_rate" IS NULL) = ("amount_npr" IS NULL) AND ("fx_rate" IS NULL) = ("tds_npr" IS NULL)),
	CONSTRAINT "payments_npr_snapshot_check" CHECK ("fx_rate" IS NULL OR "currency" <> 'NPR' OR ("fx_rate" = 1 AND "amount_npr" = "amount" AND "tds_npr" = "tds_withheld")),
	CONSTRAINT "payments_fx_source_check" CHECK ("fx_rate" IS NULL OR "currency" = 'NPR' OR ("fx_source" IS NOT NULL AND "fx_date" IS NOT NULL)),
	CONSTRAINT "payments_snapshot_status_check" CHECK ("status" NOT IN ('verified', 'reversed') OR "fx_rate" IS NOT NULL),
	CONSTRAINT "payments_verifier_check" CHECK ("verified_by" IS NULL OR "verified_by" <> "submitted_by"),
	CONSTRAINT "payments_verification_status_check" CHECK (("status" IN ('verified', 'reversed')) = ("verified_by" IS NOT NULL AND "verified_at" IS NOT NULL) AND ("verified_by" IS NULL) = ("verified_at" IS NULL)),
	CONSTRAINT "payments_rejection_reason_check" CHECK ("status" <> 'rejected' OR ("rejection_reason" IS NOT NULL AND btrim("rejection_reason") <> '')),
	CONSTRAINT "payments_number_complete_check" CHECK (("number" IS NULL) = ("seq" IS NULL) AND ("number" IS NULL) = ("fiscal_year" IS NULL)),
	CONSTRAINT "payments_number_status_check" CHECK (("status" IN ('verified', 'reversed')) = ("number" IS NOT NULL)),
	CONSTRAINT "payments_number_format_check" CHECK ("number" IS NULL OR ("number" LIKE 'RCPT-%' AND "seq" >= 1)),
	CONSTRAINT "payments_version_check" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE INDEX "payments_tenant_customer_party_idx" ON "app"."payments" USING btree ("tenant_id", "customer_party_id");
--> statement-breakpoint
CREATE INDEX "payments_tenant_org_status_idx" ON "app"."payments" USING btree ("tenant_id", "organization_id", "status");
--> statement-breakpoint

-- Evidence for a payment (bank slip, QR screenshot, cheque photo): one row per (payment, document), both in the
-- same entity. Whether the file has been scanned clean is the documents module's business.
CREATE TABLE "app"."payment_proofs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_proofs_tenant_org_payment_document_unique" UNIQUE("tenant_id", "organization_id", "payment_id", "document_id"),
	CONSTRAINT "payment_proofs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "payment_proofs_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "payment_proofs_payment_fk" FOREIGN KEY ("tenant_id", "organization_id", "payment_id") REFERENCES "app"."payments"("tenant_id", "organization_id", "id"),
	CONSTRAINT "payment_proofs_document_fk" FOREIGN KEY ("tenant_id", "organization_id", "document_id") REFERENCES "app"."documents"("tenant_id", "organization_id", "id"),
	CONSTRAINT "payment_proofs_created_by_user_fk" FOREIGN KEY ("tenant_id", "created_by") REFERENCES "app"."users"("tenant_id", "id")
);
--> statement-breakpoint
CREATE INDEX "payment_proofs_tenant_org_document_idx" ON "app"."payment_proofs" USING btree ("tenant_id", "organization_id", "document_id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------
-- Triggers. Not SECURITY DEFINER. Errors are check_violation with the named pseudo-constraint, as 0019 does.
-- ---------------------------------------------------------------------------------------------------------------

-- The lifecycle (see the header). Generated columns are left out of the comparison: a BEFORE trigger does not see
-- them recomputed. customer_party_kind is constant; settles and settles_npr follow amount, tds_withheld and the
-- snapshot, which are compared themselves.
CREATE FUNCTION "app"."payments_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
	IF NEW."status" <> OLD."status" AND NOT (
		(OLD."status" = 'submitted' AND NEW."status" IN ('verified', 'rejected', 'withdrawn'))
		OR (OLD."status" = 'verified' AND NEW."status" = 'reversed')
	) THEN
		RAISE EXCEPTION 'payment %: status % cannot become %', OLD."id", OLD."status", NEW."status"
			USING ERRCODE = 'check_violation', CONSTRAINT = 'payments_status_transition_check';
	END IF;
	IF OLD."status" <> 'submitted'
		AND to_jsonb(NEW) - 'status' - 'version' - 'updated_at' - 'settles' - 'settles_npr' - 'customer_party_kind'
			IS DISTINCT FROM to_jsonb(OLD) - 'status' - 'version' - 'updated_at' - 'settles' - 'settles_npr' - 'customer_party_kind' THEN
		RAISE EXCEPTION 'payment %: a % payment keeps its content (only its status may change)', OLD."id", OLD."status"
			USING ERRCODE = 'check_violation', CONSTRAINT = 'payments_frozen_check';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "app"."payments_guard"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "payments_guard" BEFORE UPDATE ON "app"."payments"
FOR EACH ROW EXECUTE FUNCTION "app"."payments_guard"();
--> statement-breakpoint

-- Proof links are never rewritten or removed (the raise function is 0019's).
CREATE TRIGGER "payment_proofs_append_only" BEFORE UPDATE OR DELETE ON "app"."payment_proofs"
FOR EACH ROW EXECUTE FUNCTION "app"."ledger_append_only"();
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------
-- Privileges: 0008's default privileges granted bos_app all four statements on new tables.
-- ---------------------------------------------------------------------------------------------------------------
REVOKE DELETE ON "app"."payments" FROM "bos_app";
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "app"."payment_proofs" FROM "bos_app";
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------
-- Audit: every write to these tables lands in the hash chain.
-- ---------------------------------------------------------------------------------------------------------------
SELECT audit.attach('app.payments');
--> statement-breakpoint
SELECT audit.attach('app.payment_proofs');
