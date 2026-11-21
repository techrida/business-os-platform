-- The accounts an entity books bill lines to, picked on bill entry instead of a typed GUID (see 0143 for why
-- vendor_bill_lines.account_id keeps no foreign key).
CREATE TABLE "app"."expense_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "expense_accounts_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "expense_accounts_tenant_org_id_unique" UNIQUE("tenant_id", "organization_id", "id"),
	CONSTRAINT "expense_accounts_code_check" CHECK (btrim("code") <> ''),
	CONSTRAINT "expense_accounts_name_check" CHECK (btrim("name") <> ''),
	CONSTRAINT "expense_accounts_status_check" CHECK ("status" in ('active', 'retired')),
	CONSTRAINT "expense_accounts_retired_at_check" CHECK (("status" = 'retired') = ("retired_at" IS NOT NULL))
);
--> statement-breakpoint
-- Codes are typed by people, so "Rent" and "RENT" must not both exist in one entity.
CREATE UNIQUE INDEX "expense_accounts_tenant_org_code_unique" ON "app"."expense_accounts" USING btree ("tenant_id","organization_id",lower("code"));
--> statement-breakpoint
SELECT audit.attach('app.expense_accounts');
--> statement-breakpoint
-- Bill lines name the account by id and show its code, so the code is fixed once written; retire, never delete.
CREATE FUNCTION "app"."expense_accounts_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'expense_accounts: retire the account, never delete it'
			USING ERRCODE = 'check_violation', CONSTRAINT = 'expense_accounts_no_delete';
	END IF;
	IF NEW.code IS DISTINCT FROM OLD.code THEN
		RAISE EXCEPTION 'expense_accounts: code is fixed once created'
			USING ERRCODE = 'check_violation', CONSTRAINT = 'expense_accounts_frozen';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "app"."expense_accounts_guard"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "expense_accounts_guard" BEFORE UPDATE OR DELETE ON "app"."expense_accounts"
FOR EACH ROW EXECUTE FUNCTION "app"."expense_accounts_guard"();
