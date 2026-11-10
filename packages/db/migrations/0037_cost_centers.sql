-- D-P4-1: cost centres belong to the acting legal entity. Projects remain a later phase.
CREATE TABLE "app"."cost_centers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "cost_centers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
  CONSTRAINT "cost_centers_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
  CONSTRAINT "cost_centers_tenant_org_id_unique" UNIQUE("tenant_id", "organization_id", "id"),
  CONSTRAINT "cost_centers_tenant_org_code_unique" UNIQUE("tenant_id", "organization_id", "code"),
  CONSTRAINT "cost_centers_code_check" CHECK (btrim("code") <> ''),
  CONSTRAINT "cost_centers_name_check" CHECK (btrim("name") <> '')
);
--> statement-breakpoint
SELECT audit.attach('app.cost_centers');
--> statement-breakpoint
-- Audit each migrated entity and request under a named system actor, including submitted requests.
DO $$
DECLARE
  entity record;
  center_id uuid;
BEGIN
  PERFORM set_config('bos.actor_kind', 'system', true);
  PERFORM set_config('bos.actor_id', 'migration:0037_cost_centers', true);
  PERFORM set_config('bos.correlation_id', 'migration:0037_cost_centers', true);
  FOR entity IN SELECT tenant_id, id FROM app.organizations LOOP
    PERFORM set_config('bos.tenant_id', entity.tenant_id::text, true);
    PERFORM set_config('bos.organization_id', entity.id::text, true);
    INSERT INTO app.cost_centers (tenant_id, organization_id, code, name)
      VALUES (entity.tenant_id, entity.id, 'GENERAL', 'General') RETURNING id INTO center_id;
    UPDATE app.purchase_requests SET cost_center_id = center_id
      WHERE tenant_id = entity.tenant_id AND organization_id = entity.id;
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE "app"."purchase_requests" ADD CONSTRAINT "purchase_requests_cost_center_fk" FOREIGN KEY ("tenant_id", "organization_id", "cost_center_id") REFERENCES "app"."cost_centers"("tenant_id", "organization_id", "id");
