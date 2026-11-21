-- 0155_sales_order_delivery_releases: a manual release of a sales order's delivery hold (F1-Q32, decision D56;
-- R4c1 Q4: the Founder may release too), and the `sales_order.delivery_release` grant.
--   * One row per released order (sales_order_delivery_releases_order_unique). A release is final: the guard
--     trigger refuses UPDATE and DELETE, so the row stays as the record of who let the delivery go and why.
--   * released_by_user_id: the staff user who released it (tenant-level FK into users, like payment_promises').
--   * reason: required, trimmed non-empty, at most 1000 characters.
--   * order_amount_npr and threshold_npr: snapshots, at release time, of sales_orders.amount_npr and the
--     `sales.delivery_hold.management_npr` setting the rule was decided with, so a later threshold edit does not
--     change what the record says.
-- Entity-owned (tenant_id + organization_id), composite FKs, audited. No GRANT: 0008's default privileges cover new
-- tables. The table starts empty.
--
-- The grant: `sales_order.delivery_release` at `all` (an on/off permission) for the Founder, Management and Finance
-- roles, as DEFAULT_ROLE_PERMISSIONS in packages/contracts now holds it. Same rule as 0104: only tenants that already
-- hold role_permissions rows get them (a tenant with none runs on the code defaults, and a row written there would
-- strip every other role); rows are `seeded`; a role that already holds the permission keeps its row; the authz
-- version moves only for a tenant that gained a row, so the API's grant cache reloads.
--
-- Runs as bos_owner, in the migrator's one transaction, split at the breakpoint comments (same rule as 0000).

-- set_config(..., true) lasts to the end of the migrator's transaction, so every write below is recorded as
-- system:migration-0155. bos.organization_id is set per tenant in the loop (the grant table is tenant-scoped).
SELECT
	set_config('bos.actor_kind', 'system', true),
	set_config('bos.actor_id', 'system:migration-0155', true),
	set_config('bos.correlation_id', 'migration-0155:' || gen_random_uuid()::text, true),
	set_config('bos.ip', '', true),
	set_config('bos.user_agent', '', true);
--> statement-breakpoint
CREATE TABLE "app"."sales_order_delivery_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"sales_order_id" uuid NOT NULL,
	"released_by_user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"order_amount_npr" numeric(18, 2) NOT NULL,
	"threshold_npr" numeric(18, 2) NOT NULL,
	"released_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_order_delivery_releases_tenant_org_id_unique" UNIQUE("tenant_id", "organization_id", "id"),
	CONSTRAINT "sales_order_delivery_releases_order_unique" UNIQUE("tenant_id", "organization_id", "sales_order_id"),
	CONSTRAINT "sales_order_delivery_releases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "sales_order_delivery_releases_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "sales_order_delivery_releases_sales_order_fk" FOREIGN KEY ("tenant_id", "organization_id", "sales_order_id") REFERENCES "app"."sales_orders"("tenant_id", "organization_id", "id"),
	CONSTRAINT "sales_order_delivery_releases_released_by_fk" FOREIGN KEY ("tenant_id", "released_by_user_id") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "sales_order_delivery_releases_reason_check" CHECK (btrim("reason") <> '' AND length("reason") <= 1000),
	CONSTRAINT "sales_order_delivery_releases_amount_check" CHECK ("order_amount_npr" > 0 AND "threshold_npr" >= 0)
);
--> statement-breakpoint
SELECT audit.attach('app.sales_order_delivery_releases');
--> statement-breakpoint
-- A release is final in this version: there is no undo, so the row is never changed or removed.
CREATE FUNCTION "app"."sales_order_delivery_releases_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
	RAISE EXCEPTION 'sales_order_delivery_releases: a delivery release is final'
		USING ERRCODE = 'check_violation', CONSTRAINT = 'sales_order_delivery_releases_final';
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "app"."sales_order_delivery_releases_guard"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "sales_order_delivery_releases_guard" BEFORE UPDATE OR DELETE ON "app"."sales_order_delivery_releases"
FOR EACH ROW EXECUTE FUNCTION "app"."sales_order_delivery_releases_guard"();
--> statement-breakpoint
LOCK TABLE app.role_permissions IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
DECLARE
  target record;
  inserted_rows integer;
BEGIN
  FOR target IN
    SELECT org.tenant_id, org.id AS organization_id
    FROM app.organizations org
    WHERE org.is_default
      AND EXISTS (SELECT 1 FROM app.role_permissions rp WHERE rp.tenant_id = org.tenant_id)
    ORDER BY org.tenant_id
  LOOP
    PERFORM set_config('bos.organization_id', target.organization_id::text, true);

    INSERT INTO app.role_permissions (tenant_id, role_key, permission, scope, seeded)
    SELECT target.tenant_id, roles.role_key, 'sales_order.delivery_release', 'all', true
    FROM (VALUES ('founder'), ('management'), ('finance')) AS roles(role_key)
    ON CONFLICT (tenant_id, role_key, permission) DO NOTHING;
    GET DIAGNOSTICS inserted_rows = ROW_COUNT;

    IF inserted_rows > 0 THEN
      INSERT INTO app.authz_versions (tenant_id, version)
      VALUES (target.tenant_id, 1)
      ON CONFLICT (tenant_id) DO UPDATE
        SET version = app.authz_versions.version + 1, updated_at = now();
    END IF;
  END LOOP;
END;
$$;
