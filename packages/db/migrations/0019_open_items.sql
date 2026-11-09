-- 0019_open_items: the AR/AP subledger of P3 (plan unit U0-A, decisions A1, A4, A8, A9; reused by P4's payables).
-- Money is numeric(18,2) and FX rates numeric(18,6) (ground rules). There are no journals and no chart of accounts.
--
-- Two scopes (ADR 0027 sections 6 and 8):
--   * Tenant-level (on check-tenancy's TENANT_SCOPED list): withholding_codes. tenant_id NOT NULL with its FK to
--     app.tenants, no organization_id, unique keys led by tenant_id. Effective-dated like tax_codes (0016).
--   * Entity-owned: open_items, open_item_allocations, posting_events. (tenant_id, organization_id) ->
--     organizations (<table>_tenant_org_fk); a FK into another entity-owned table is (tenant_id, organization_id, x);
--     a FK into a tenant-level table (parties, users) is (tenant_id, x).
--
-- The model (A1, A8):
--   * An open item is one amount a document leaves owed: a tax invoice or debit note is a receivable debit, a
--     credit note or verified payment a receivable credit; a vendor bill is a payable credit, a vendor payment or
--     vendor debit note a payable debit. One item per source document (open_items_tenant_org_source_unique), so
--     LedgerService.openItem can be replayed: a second INSERT fails or is ON CONFLICT DO NOTHING.
--   * The counterparty (A9) is customer_party_id on the receivable side and vendor_party_id on the payable side,
--     never both (open_items_party_side_check). Each has a stored generated kind column, so the parties FK refuses a
--     vendor in the customer column and the reverse (check-tenancy's counterparty rule).
--   * An allocation settles a debit item against a credit item of the same side, party and currency
--     (open_item_allocations_match, BEFORE INSERT). A deallocation is a new row with the negative amount that names
--     the row it reverses, once (open_item_allocations_tenant_reverses_unique), with the same two items.
--   * Paid is derived, never stored: open_item_balances = amount - net allocated. Each item's net allocated stays
--     within [0, amount] (open_item_allocations_cap, a DEFERRABLE INITIALLY DEFERRED constraint trigger, so one
--     transaction may release an allocation and re-allocate before it commits).
--   * posting_events records each business event once per source (posting_events_tenant_org_source_event_unique), with
--     its payload (amounts, FX difference); allocation events are keyed by the allocation id.
--
-- Append-only (ground rules): the three entity-owned tables get a BEFORE UPDATE OR DELETE trigger that raises, and
-- bos_app loses UPDATE and DELETE (0008's default privileges granted all four). open_items keeps a column UPDATE
-- grant on "id" only, because SELECT ... FOR UPDATE needs UPDATE privilege on one column and the money commands
-- lock open items (ground rules, lock order); the trigger still refuses every UPDATE.
--
-- The cap trigger locks both items (ascending id, the commands' lock order) before it sums, so two transactions
-- that allocate against one item serialise at commit and the second sees the first's rows. withholding_codes is
-- edited like tax_codes (a rate change is a new period). Every table is audited (audit.attach).
--
-- DDL only: no row is written. Runs as bos_owner, split at the breakpoint comments. btree_gist exists since 0016.
-- Names follow the K1-U2 convention, mirrored in src/schema/ledger.ts.

-- ---------------------------------------------------------------------------------------------------------------
-- Tenant-level table
-- ---------------------------------------------------------------------------------------------------------------

-- A withholding (TDS) code period (A4). One code has one row per effective period [effective_from, effective_to);
-- periods of one code never overlap (withholding_codes_no_overlap). rate_bp is basis points; the seed is 0 until
-- the accountant signs. applies_to: receivable (tax the customer withholds from us), payable (tax we withhold from a
-- vendor) or both.
CREATE TABLE "app"."withholding_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"applies_to" text NOT NULL,
	"rate_bp" integer NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "withholding_codes_tenant_id_unique" UNIQUE("tenant_id", "id"),
	CONSTRAINT "withholding_codes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "withholding_codes_applies_to_check" CHECK ("applies_to" in ('receivable', 'payable', 'both')),
	CONSTRAINT "withholding_codes_rate_bp_check" CHECK ("rate_bp" BETWEEN 0 AND 10000),
	CONSTRAINT "withholding_codes_period_check" CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from"),
	CONSTRAINT "withholding_codes_version_check" CHECK ("version" >= 1)
);
--> statement-breakpoint

-- No two periods of one code overlap within a tenant ('[)': a period may start on the previous one's end date).
ALTER TABLE "app"."withholding_codes" ADD CONSTRAINT "withholding_codes_no_overlap" EXCLUDE USING gist ("tenant_id" WITH =, "code" WITH =, daterange("effective_from", "effective_to", '[)') WITH &&);
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------
-- Entity-owned tables
-- ---------------------------------------------------------------------------------------------------------------

-- One amount a source document leaves owed (or paid in advance). source_id is the document's id; there is no FK,
-- because the source table depends on source_type. amount is positive in the document currency; the direction says
-- which way it counts. NPR snapshot (C-11): fx_rate is NPR per unit (1 for NPR), amount_npr the NPR amount, and a
-- foreign currency names its rate source and date. created_by is NULL for a system actor (a worker posting).
CREATE TABLE "app"."open_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"side" text NOT NULL,
	"direction" text NOT NULL,
	"customer_party_id" uuid,
	"customer_party_kind" text GENERATED ALWAYS AS ('customer') STORED,
	"vendor_party_id" uuid,
	"vendor_party_kind" text GENERATED ALWAYS AS ('vendor') STORED,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"currency" char(3) NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"amount_npr" numeric(18, 2) NOT NULL,
	"fx_rate" numeric(18, 6) NOT NULL,
	"fx_source" text,
	"fx_date" date,
	"document_date" date NOT NULL,
	"due_date" date,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "open_items_tenant_id_unique" UNIQUE("tenant_id", "id"),
	CONSTRAINT "open_items_tenant_org_id_unique" UNIQUE("tenant_id", "organization_id", "id"),
	CONSTRAINT "open_items_tenant_org_source_unique" UNIQUE("tenant_id", "organization_id", "source_type", "source_id"),
	CONSTRAINT "open_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "open_items_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "open_items_customer_party_fk" FOREIGN KEY ("tenant_id", "customer_party_id", "customer_party_kind") REFERENCES "app"."parties"("tenant_id", "id", "kind"),
	CONSTRAINT "open_items_vendor_party_fk" FOREIGN KEY ("tenant_id", "vendor_party_id", "vendor_party_kind") REFERENCES "app"."parties"("tenant_id", "id", "kind"),
	CONSTRAINT "open_items_created_by_user_fk" FOREIGN KEY ("tenant_id", "created_by") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "open_items_side_check" CHECK ("side" in ('receivable', 'payable')),
	CONSTRAINT "open_items_direction_check" CHECK ("direction" in ('debit', 'credit')),
	CONSTRAINT "open_items_party_side_check" CHECK (("side" = 'receivable' AND "customer_party_id" IS NOT NULL AND "vendor_party_id" IS NULL) OR ("side" = 'payable' AND "vendor_party_id" IS NOT NULL AND "customer_party_id" IS NULL)),
	CONSTRAINT "open_items_source_type_check" CHECK ("source_type" in ('tax_invoice', 'debit_note', 'credit_note', 'payment', 'vendor_bill', 'vendor_payment', 'vendor_debit_note')),
	CONSTRAINT "open_items_source_side_check" CHECK (("side" = 'receivable') = ("source_type" in ('tax_invoice', 'debit_note', 'credit_note', 'payment'))),
	CONSTRAINT "open_items_currency_check" CHECK ("currency" in ('NPR', 'INR', 'USD')),
	CONSTRAINT "open_items_amount_check" CHECK ("amount" > 0),
	CONSTRAINT "open_items_amount_npr_check" CHECK ("amount_npr" > 0),
	CONSTRAINT "open_items_fx_rate_check" CHECK ("fx_rate" > 0),
	CONSTRAINT "open_items_npr_snapshot_check" CHECK ("currency" <> 'NPR' OR ("fx_rate" = 1 AND "amount_npr" = "amount")),
	CONSTRAINT "open_items_fx_source_check" CHECK ("currency" = 'NPR' OR ("fx_source" IS NOT NULL AND "fx_date" IS NOT NULL)),
	CONSTRAINT "open_items_due_date_check" CHECK ("due_date" IS NULL OR "due_date" >= "document_date")
);
--> statement-breakpoint
CREATE INDEX "open_items_tenant_customer_party_idx" ON "app"."open_items" USING btree ("tenant_id", "customer_party_id");
--> statement-breakpoint
CREATE INDEX "open_items_tenant_vendor_party_idx" ON "app"."open_items" USING btree ("tenant_id", "vendor_party_id");
--> statement-breakpoint

-- One allocation of a credit item against a debit item, in their (shared) currency. A positive amount allocates;
-- a reversal is negative and names the allocation it undoes. reason is required on a reversal.
CREATE TABLE "app"."open_item_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"debit_item_id" uuid NOT NULL,
	"credit_item_id" uuid NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"reverses_allocation_id" uuid,
	"reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "open_item_allocations_tenant_id_unique" UNIQUE("tenant_id", "id"),
	CONSTRAINT "open_item_allocations_tenant_org_id_unique" UNIQUE("tenant_id", "organization_id", "id"),
	CONSTRAINT "open_item_allocations_tenant_reverses_unique" UNIQUE("tenant_id", "reverses_allocation_id"),
	CONSTRAINT "open_item_allocations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "open_item_allocations_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "open_item_allocations_debit_item_fk" FOREIGN KEY ("tenant_id", "organization_id", "debit_item_id") REFERENCES "app"."open_items"("tenant_id", "organization_id", "id"),
	CONSTRAINT "open_item_allocations_credit_item_fk" FOREIGN KEY ("tenant_id", "organization_id", "credit_item_id") REFERENCES "app"."open_items"("tenant_id", "organization_id", "id"),
	CONSTRAINT "open_item_allocations_reverses_fk" FOREIGN KEY ("tenant_id", "organization_id", "reverses_allocation_id") REFERENCES "app"."open_item_allocations"("tenant_id", "organization_id", "id"),
	CONSTRAINT "open_item_allocations_created_by_user_fk" FOREIGN KEY ("tenant_id", "created_by") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "open_item_allocations_amount_check" CHECK ("amount" <> 0),
	CONSTRAINT "open_item_allocations_reversal_sign_check" CHECK (("amount" < 0) = ("reverses_allocation_id" IS NOT NULL)),
	CONSTRAINT "open_item_allocations_reversal_reason_check" CHECK ("reverses_allocation_id" IS NULL OR "reason" IS NOT NULL),
	CONSTRAINT "open_item_allocations_items_check" CHECK ("debit_item_id" <> "credit_item_id")
);
--> statement-breakpoint
CREATE INDEX "open_item_allocations_tenant_org_debit_idx" ON "app"."open_item_allocations" USING btree ("tenant_id", "organization_id", "debit_item_id");
--> statement-breakpoint
CREATE INDEX "open_item_allocations_tenant_org_credit_idx" ON "app"."open_item_allocations" USING btree ("tenant_id", "organization_id", "credit_item_id");
--> statement-breakpoint

-- One business event per source and kind (the PostingEvent union of LedgerService, P4's three included). An
-- allocation or its reversal is keyed by the allocation row (source_type 'allocation'). payload holds the amounts
-- and the FX difference (A13).
CREATE TABLE "app"."posting_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"event" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "posting_events_tenant_id_unique" UNIQUE("tenant_id", "id"),
	CONSTRAINT "posting_events_tenant_org_source_event_unique" UNIQUE("tenant_id", "organization_id", "source_type", "source_id", "event"),
	CONSTRAINT "posting_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "posting_events_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "posting_events_created_by_user_fk" FOREIGN KEY ("tenant_id", "created_by") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "posting_events_source_type_check" CHECK ("source_type" in ('tax_invoice', 'debit_note', 'credit_note', 'payment', 'vendor_bill', 'vendor_payment', 'vendor_debit_note', 'allocation')),
	CONSTRAINT "posting_events_event_check" CHECK ("event" in ('invoice_issued', 'debit_note_issued', 'credit_note_issued', 'payment_verified', 'payment_reversed', 'allocation', 'allocation_reversed', 'vendor_bill_posted', 'vendor_payment_made', 'vendor_debit_note_issued')),
	CONSTRAINT "posting_events_payload_check" CHECK (jsonb_typeof("payload") = 'object')
);
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------
-- Derived balances (A8). security_invoker: the reader's own privileges on the two tables apply.
-- ---------------------------------------------------------------------------------------------------------------
CREATE VIEW "app"."open_item_balances" WITH (security_invoker = true) AS
SELECT
	oi."id" AS "open_item_id",
	oi."tenant_id",
	oi."organization_id",
	oi."side",
	oi."direction",
	oi."customer_party_id",
	oi."vendor_party_id",
	oi."source_type",
	oi."source_id",
	oi."currency",
	oi."amount",
	(COALESCE(d."allocated", 0) + COALESCE(c."allocated", 0))::numeric(18, 2) AS "allocated_amount",
	(oi."amount" - COALESCE(d."allocated", 0) - COALESCE(c."allocated", 0))::numeric(18, 2) AS "open_amount",
	oi."document_date",
	oi."due_date"
FROM "app"."open_items" oi
LEFT JOIN (
	SELECT "tenant_id", "organization_id", "debit_item_id" AS "item_id", sum("amount") AS "allocated"
	FROM "app"."open_item_allocations"
	GROUP BY "tenant_id", "organization_id", "debit_item_id"
) d ON d."tenant_id" = oi."tenant_id" AND d."organization_id" = oi."organization_id" AND d."item_id" = oi."id"
LEFT JOIN (
	SELECT "tenant_id", "organization_id", "credit_item_id" AS "item_id", sum("amount") AS "allocated"
	FROM "app"."open_item_allocations"
	GROUP BY "tenant_id", "organization_id", "credit_item_id"
) c ON c."tenant_id" = oi."tenant_id" AND c."organization_id" = oi."organization_id" AND c."item_id" = oi."id";
--> statement-breakpoint
-- 0008's default privileges granted all four statements on the view too; it is read-only.
REVOKE INSERT, UPDATE, DELETE ON "app"."open_item_balances" FROM "bos_app";
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------
-- Triggers. Not SECURITY DEFINER: they read only rows the writing role may read already. Errors are
-- check_violation (or foreign_key_violation) with the named pseudo-constraint, as 0011 and 0016 do.
-- ---------------------------------------------------------------------------------------------------------------

-- The three ledger tables are records of what happened: never rewritten or removed.
CREATE FUNCTION "app"."ledger_append_only"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
	RAISE EXCEPTION '%: rows are append-only (% refused)', TG_TABLE_NAME, TG_OP
		USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_append_only';
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "app"."ledger_append_only"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "open_items_append_only" BEFORE UPDATE OR DELETE ON "app"."open_items"
FOR EACH ROW EXECUTE FUNCTION "app"."ledger_append_only"();
--> statement-breakpoint
CREATE TRIGGER "open_item_allocations_append_only" BEFORE UPDATE OR DELETE ON "app"."open_item_allocations"
FOR EACH ROW EXECUTE FUNCTION "app"."ledger_append_only"();
--> statement-breakpoint
CREATE TRIGGER "posting_events_append_only" BEFORE UPDATE OR DELETE ON "app"."posting_events"
FOR EACH ROW EXECUTE FUNCTION "app"."ledger_append_only"();
--> statement-breakpoint

-- An allocation pairs a debit item with a credit item of the same side, party and currency (no cross-currency
-- allocation in P3, A6/A13). A reversal undoes exactly one forward allocation: same items, opposite amount.
CREATE FUNCTION "app"."open_item_allocations_match"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
	v_debit "app"."open_items"%ROWTYPE;
	v_credit "app"."open_items"%ROWTYPE;
	v_original "app"."open_item_allocations"%ROWTYPE;
BEGIN
	SELECT * INTO v_debit FROM "app"."open_items"
		WHERE "tenant_id" = NEW."tenant_id" AND "organization_id" = NEW."organization_id" AND "id" = NEW."debit_item_id";
	IF NOT FOUND THEN
		RAISE EXCEPTION 'allocation: open item % not found in this entity', NEW."debit_item_id"
			USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'open_item_allocations_debit_item_fk';
	END IF;
	SELECT * INTO v_credit FROM "app"."open_items"
		WHERE "tenant_id" = NEW."tenant_id" AND "organization_id" = NEW."organization_id" AND "id" = NEW."credit_item_id";
	IF NOT FOUND THEN
		RAISE EXCEPTION 'allocation: open item % not found in this entity', NEW."credit_item_id"
			USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'open_item_allocations_credit_item_fk';
	END IF;
	IF v_debit."direction" <> 'debit' OR v_credit."direction" <> 'credit' THEN
		RAISE EXCEPTION 'allocation: % must be a debit item and % a credit item', v_debit."id", v_credit."id"
			USING ERRCODE = 'check_violation', CONSTRAINT = 'open_item_allocations_direction_check';
	END IF;
	IF v_debit."side" <> v_credit."side"
		OR v_debit."customer_party_id" IS DISTINCT FROM v_credit."customer_party_id"
		OR v_debit."vendor_party_id" IS DISTINCT FROM v_credit."vendor_party_id"
		OR v_debit."currency" <> v_credit."currency" THEN
		RAISE EXCEPTION 'allocation: open items % and % differ in side, party or currency', v_debit."id", v_credit."id"
			USING ERRCODE = 'check_violation', CONSTRAINT = 'open_item_allocations_match_check';
	END IF;
	IF NEW."reverses_allocation_id" IS NOT NULL THEN
		SELECT * INTO v_original FROM "app"."open_item_allocations"
			WHERE "tenant_id" = NEW."tenant_id" AND "organization_id" = NEW."organization_id"
				AND "id" = NEW."reverses_allocation_id";
		IF NOT FOUND THEN
			RAISE EXCEPTION 'allocation: reversed allocation % not found in this entity', NEW."reverses_allocation_id"
				USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'open_item_allocations_reverses_fk';
		END IF;
		IF v_original."reverses_allocation_id" IS NOT NULL
			OR v_original."debit_item_id" <> NEW."debit_item_id"
			OR v_original."credit_item_id" <> NEW."credit_item_id"
			OR NEW."amount" <> -v_original."amount" THEN
			RAISE EXCEPTION 'allocation: a reversal of % must name its items and amount %', v_original."id", -v_original."amount"
				USING ERRCODE = 'check_violation', CONSTRAINT = 'open_item_allocations_reversal_check';
		END IF;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "app"."open_item_allocations_match"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "open_item_allocations_match" BEFORE INSERT ON "app"."open_item_allocations"
FOR EACH ROW EXECUTE FUNCTION "app"."open_item_allocations_match"();
--> statement-breakpoint

-- At commit, each item touched keeps 0 <= net allocated <= amount. The FOR UPDATE takes both item locks in ascending
-- id order (waiting for a concurrent allocator to commit); the sum after it runs with a fresh snapshot (READ
-- COMMITTED), so it counts that allocator's committed rows.
CREATE FUNCTION "app"."open_item_allocations_cap"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
	v_item record;
BEGIN
	PERFORM 1 FROM "app"."open_items"
		WHERE "tenant_id" = NEW."tenant_id" AND "organization_id" = NEW."organization_id"
			AND "id" IN (NEW."debit_item_id", NEW."credit_item_id")
		ORDER BY "id"
		FOR UPDATE;
	FOR v_item IN
		SELECT oi."id", oi."amount",
			COALESCE((
				SELECT sum(a."amount") FROM "app"."open_item_allocations" a
				WHERE a."tenant_id" = oi."tenant_id" AND a."organization_id" = oi."organization_id"
					AND (a."debit_item_id" = oi."id" OR a."credit_item_id" = oi."id")
			), 0) AS "allocated"
		FROM "app"."open_items" oi
		WHERE oi."tenant_id" = NEW."tenant_id" AND oi."organization_id" = NEW."organization_id"
			AND oi."id" IN (NEW."debit_item_id", NEW."credit_item_id")
	LOOP
		IF v_item."allocated" < 0 OR v_item."allocated" > v_item."amount" THEN
			RAISE EXCEPTION 'allocation: open item % would have % allocated of %', v_item."id", v_item."allocated", v_item."amount"
				USING ERRCODE = 'check_violation', CONSTRAINT = 'open_item_allocations_cap_check';
		END IF;
	END LOOP;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "app"."open_item_allocations_cap"() FROM PUBLIC;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "open_item_allocations_cap" AFTER INSERT ON "app"."open_item_allocations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "app"."open_item_allocations_cap"();
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------
-- Privileges: append-only for the app (as approval_actions in 0006). The column grant on open_items."id" exists only
-- so SELECT ... FOR UPDATE can lock an item; open_items_append_only refuses the UPDATE itself.
-- ---------------------------------------------------------------------------------------------------------------
REVOKE UPDATE, DELETE ON "app"."open_items" FROM "bos_app";
--> statement-breakpoint
GRANT UPDATE ("id") ON "app"."open_items" TO "bos_app";
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "app"."open_item_allocations" FROM "bos_app";
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "app"."posting_events" FROM "bos_app";
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------
-- Audit: every write to these tables lands in the hash chain. withholding_codes takes the acting entity.
-- ---------------------------------------------------------------------------------------------------------------
SELECT audit.attach('app.withholding_codes');
--> statement-breakpoint
SELECT audit.attach('app.open_items');
--> statement-breakpoint
SELECT audit.attach('app.open_item_allocations');
--> statement-breakpoint
SELECT audit.attach('app.posting_events');
