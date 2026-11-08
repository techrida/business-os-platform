-- 0000_platform: schemas, tenancy tables, the restore canary, and what each role may do.
--
-- Runs as bos_owner (DATABASE_MIGRATE_URL). The roles bos_owner and bos_app must already exist: they are
-- created by infra/postgres/init-dbs.sh on the first start of the database volume. If bos_app is missing, the
-- GRANT statements below fail loudly on purpose, instead of silently leaving the API without access.
--
-- Drizzle runs the whole file in one transaction and splits it at the breakpoint comments, so every
-- statement is followed by one (a function body with semicolons stays one statement).

CREATE SCHEMA "app";
--> statement-breakpoint
CREATE SCHEMA "ops";
--> statement-breakpoint

CREATE TABLE "app"."tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE "app"."organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"zitadel_org_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_zitadel_org_id_unique" UNIQUE("zitadel_org_id"),
	CONSTRAINT "organizations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "organizations_kind_check" CHECK ("kind" in ('staff', 'customer', 'vendor')),
	CONSTRAINT "organizations_self_check" CHECK ("organization_id" = "id")
);
--> statement-breakpoint

CREATE INDEX "organizations_tenant_id_idx" ON "app"."organizations" USING btree ("tenant_id");
--> statement-breakpoint

-- An organization is its own organization: organization_id = id. This trigger lets an INSERT leave
-- organization_id out (it is copied from id). NOT NULL is checked after BEFORE triggers, so that works,
-- and the CHECK above rejects any explicit value that differs from id.
CREATE FUNCTION "app"."organizations_set_self_id"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	NEW."organization_id" := COALESCE(NEW."organization_id", NEW."id");
	RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "organizations_set_self_id" BEFORE INSERT ON "app"."organizations"
FOR EACH ROW EXECUTE FUNCTION "app"."organizations_set_self_id"();
--> statement-breakpoint

-- The restore drill writes a row here before each backup and looks for it after the restore.
CREATE TABLE "ops"."restore_canary" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"written_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- bos_app is the runtime role: data changes only, never schema changes.
-- init-dbs.sh already grants these through default privileges; they are repeated here so this file states
-- the whole rule by itself (and still holds if the default privileges are ever changed).
GRANT USAGE ON SCHEMA "app" TO "bos_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "app" TO "bos_app";
--> statement-breakpoint
GRANT USAGE ON SCHEMA "ops" TO "bos_app";
--> statement-breakpoint
-- ops is append-only for the app. The REVOKE is needed because the default privileges grant all four
-- statements when bos_owner creates a table, and a GRANT never removes anything.
GRANT SELECT, INSERT ON "ops"."restore_canary" TO "bos_app";
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "ops"."restore_canary" FROM "bos_app";
