-- The paying entity's own bank accounts, picked on payment requests instead of a typed GUID. Only the last four
-- characters of the account number are kept: the full number never reaches Business OS.
-- vendor_bill_lines.account_id and payment_requests.from_bank_account_id deliberately get NO foreign key to
-- this table or to app.expense_accounts: rows saved before these lists existed hold arbitrary GUIDs, and the
-- API shows them as "Unknown account" instead of rejecting them.
CREATE TABLE "app"."company_bank_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"bank_name" text NOT NULL,
	"last4" text NOT NULL,
	"currency" char(3) NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_bank_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "company_bank_accounts_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "company_bank_accounts_tenant_org_id_unique" UNIQUE("tenant_id", "organization_id", "id"),
	CONSTRAINT "company_bank_accounts_name_check" CHECK (btrim("name") <> ''),
	CONSTRAINT "company_bank_accounts_bank_name_check" CHECK (btrim("bank_name") <> ''),
	CONSTRAINT "company_bank_accounts_last4_check" CHECK ("last4" ~ '^[A-Za-z0-9]{4}$'),
	CONSTRAINT "company_bank_accounts_currency_check" CHECK ("currency" in ('NPR', 'INR', 'USD')),
	CONSTRAINT "company_bank_accounts_status_check" CHECK ("status" in ('active', 'retired')),
	CONSTRAINT "company_bank_accounts_retired_at_check" CHECK (("status" = 'retired') = ("retired_at" IS NOT NULL))
);
--> statement-breakpoint
SELECT audit.attach('app.company_bank_accounts');
--> statement-breakpoint
-- A payment request names the account by id and its label must stay true, so the bank, the last four and the
-- currency are fixed once written (only the name may change), and a row is retired, never deleted.
CREATE FUNCTION "app"."company_bank_accounts_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'company_bank_accounts: retire the account, never delete it'
			USING ERRCODE = 'check_violation', CONSTRAINT = 'company_bank_accounts_no_delete';
	END IF;
	IF NEW.bank_name IS DISTINCT FROM OLD.bank_name
		OR NEW.last4 IS DISTINCT FROM OLD.last4
		OR NEW.currency IS DISTINCT FROM OLD.currency THEN
		RAISE EXCEPTION 'company_bank_accounts: bank_name, last4 and currency are fixed once created'
			USING ERRCODE = 'check_violation', CONSTRAINT = 'company_bank_accounts_frozen';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "app"."company_bank_accounts_guard"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "company_bank_accounts_guard" BEFORE UPDATE OR DELETE ON "app"."company_bank_accounts"
FOR EACH ROW EXECUTE FUNCTION "app"."company_bank_accounts_guard"();
