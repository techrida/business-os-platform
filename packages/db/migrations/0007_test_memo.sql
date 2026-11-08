-- 0007_test_memo: the throwaway document type that exercises the whole kernel (numbering, NPR money,
-- attachments, approvals, audit). P2 replaces it with quotations; the table and module are deleted then
-- and the audit rows stay. Plan: the P1 plan, section 4, "0007_test_memo", and section 5 (ADR 0017).
-- Serves the NFRs "every change is audited" (audit.attach below) and "amounts are exact and traceable"
-- (the NPR snapshot is frozen on the row next to the rate that produced it).
--
-- Runs as bos_owner, in one transaction, split at the breakpoint comments (same rule as 0000).

-- ADR 0017 trigger: a counterparty column (customer_organization_id, vendor_organization_id) must point at an
-- organization of the right kind. A foreign key alone would let a memo name a staff org or a vendor as its
-- "customer", and the portal filter would then show it to the wrong audience.
-- A trigger function cannot take parameters in its signature, so the table's CREATE TRIGGER passes them:
--   TG_ARGV[0] = the column to check, TG_ARGV[1] = the kind the referenced organization must have.
-- Reading the column through to_jsonb(NEW) keeps one function for every table and both columns.
-- NULL passes: a draft may have no counterparty yet and staff-only rows never do.
-- The lookup also requires the same tenant, so a memo cannot point at another tenant's customer.
CREATE FUNCTION "app"."assert_org_kind"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $$
DECLARE
	v_column text := TG_ARGV[0];
	v_expected text := TG_ARGV[1];
	v_org uuid := nullif(to_jsonb(NEW) ->> v_column, '')::uuid;
	v_kind text;
BEGIN
	IF v_org IS NULL THEN
		RETURN NEW;
	END IF;
	SELECT o.kind INTO v_kind
	  FROM app.organizations o
	 WHERE o.id = v_org AND o.tenant_id = NEW.tenant_id;
	IF v_kind IS DISTINCT FROM v_expected THEN
		RAISE EXCEPTION '%.%: organization % must have kind %, found %',
			TG_TABLE_NAME, v_column, v_org, v_expected, coalesce(v_kind, 'none (unknown organization in this tenant)')
			USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint

-- organization_id is the owning (staff) org; customer_organization_id is who a portal would show the memo to.
-- number is unique per organization (app.number_series counts per tenant AND org): "MEMO-2082/83-00001" is how people refer to the memo, and the counter in
-- app.number_series is gap-free, so a duplicate means a bug, never a normal case.
-- amount is what the person typed in `currency`; amount_npr, fx_rate, fx_source and fx_date are the frozen
-- NPR snapshot (MoneyService.toNprSnapshot), the value approval routing compares against the thresholds.
-- owner_user_id and department_id are the record-scope columns for scope 'own' and 'department'.
-- editor_user_ids lists everyone who changed the memo after creation: they join the owner in
-- approval_requests.sod_user_ids, so nobody who edited the memo can approve it.
CREATE TABLE "app"."test_memos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"currency" char(3) NOT NULL,
	"amount_npr" numeric(18, 2) NOT NULL,
	"fx_rate" numeric(18, 6) NOT NULL,
	"fx_source" text NOT NULL,
	"fx_date" date NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"department_id" uuid,
	"customer_organization_id" uuid,
	"editor_user_ids" uuid[] DEFAULT '{}' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "test_memos_org_number_unique" UNIQUE("tenant_id", "organization_id", "number"),
	CONSTRAINT "test_memos_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "test_memos_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id"),
	CONSTRAINT "test_memos_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "app"."users"("id"),
	CONSTRAINT "test_memos_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "app"."departments"("id"),
	CONSTRAINT "test_memos_customer_organization_id_organizations_id_fk" FOREIGN KEY ("customer_organization_id") REFERENCES "app"."organizations"("id"),
	CONSTRAINT "test_memos_status_check" CHECK ("status" in ('draft', 'submitted', 'approved', 'returned', 'rejected')),
	CONSTRAINT "test_memos_amount_check" CHECK ("amount" >= 0),
	CONSTRAINT "test_memos_amount_npr_check" CHECK ("amount_npr" >= 0),
	CONSTRAINT "test_memos_currency_check" CHECK ("currency" in ('NPR', 'INR', 'USD')),
	CONSTRAINT "test_memos_fx_rate_check" CHECK ("fx_rate" > 0),
	CONSTRAINT "test_memos_version_check" CHECK ("version" >= 1)
);
--> statement-breakpoint

-- The portal filter is `tenant_id = $1 AND customer_organization_id = $2` (ADR 0017), and check-tenancy
-- requires a plain (non-partial) tenant-leading index on the counterparty column.
CREATE INDEX "test_memos_tenant_customer_org_idx" ON "app"."test_memos" USING btree ("tenant_id", "customer_organization_id");
--> statement-breakpoint
-- Serves the list for scope 'own' (the owner's memos).
CREATE INDEX "test_memos_tenant_org_owner_idx" ON "app"."test_memos" USING btree ("tenant_id", "organization_id", "owner_user_id");
--> statement-breakpoint

-- UPDATE OF: the check only runs when a statement sets the column, so ordinary edits stay cheap.
CREATE TRIGGER "test_memos_assert_customer_kind" BEFORE INSERT OR UPDATE OF "customer_organization_id" ON "app"."test_memos"
FOR EACH ROW EXECUTE FUNCTION "app"."assert_org_kind"('customer_organization_id', 'customer');
--> statement-breakpoint

SELECT audit.attach('app.test_memos');
