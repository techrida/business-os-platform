-- 0002_identity_authz: who the people are (users, departments), what they may do (user_roles,
-- role_permissions), the cache key for that (authz_versions), and two ops tables for the ZITADEL sync.
-- Serves the authorization NFR (every decision is a deny-by-default lookup) and the audit NFR (changes to
-- identity and permissions are audited). Plan: the P1 plan, section 4, "0002_identity_authz".
--
-- Runs as bos_owner, in one transaction, split at the breakpoint comments (same rule as 0000).
--
-- Every app table carries id, tenant_id and organization_id, and every index starts with tenant_id, so a
-- tenant's rows sit together and check-tenancy passes. user_roles is the one table whose primary key is not
-- id (it is the natural key user_id + role_key); it keeps a unique id anyway, because the audit trigger
-- identifies a changed row by its id.

CREATE TABLE "app"."departments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"head_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "departments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "departments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id")
);
--> statement-breakpoint

CREATE INDEX "departments_tenant_org_idx" ON "app"."departments" USING btree ("tenant_id", "organization_id");
--> statement-breakpoint

-- zitadel_user_id is the ZITADEL "sub": it is how a token finds its row, so it is unique across tenants too.
-- email and display_name are nullable because the first-request upsert (JIT) only knows what the token carries;
-- the sync job fills them in later.
CREATE TABLE "app"."users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"zitadel_user_id" text NOT NULL,
	"email" text,
	"display_name" text,
	"status" text NOT NULL,
	"department_id" uuid,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_zitadel_user_id_unique" UNIQUE("zitadel_user_id"),
	CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id"),
	CONSTRAINT "users_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "app"."departments"("id"),
	CONSTRAINT "users_status_check" CHECK ("status" in ('invited', 'active', 'inactive'))
);
--> statement-breakpoint

CREATE INDEX "users_tenant_org_status_idx" ON "app"."users" USING btree ("tenant_id", "organization_id", "status");
--> statement-breakpoint
CREATE INDEX "users_tenant_org_department_idx" ON "app"."users" USING btree ("tenant_id", "organization_id", "department_id");
--> statement-breakpoint

-- departments and users point at each other (head_user_id, department_id), so this FK is added last.
ALTER TABLE "app"."departments" ADD CONSTRAINT "departments_head_user_id_users_id_fk" FOREIGN KEY ("head_user_id") REFERENCES "app"."users"("id");
--> statement-breakpoint

-- A mirror of the ZITADEL grants (ZITADEL stays the truth), kept so approvals can ask "who has role X".
CREATE TABLE "app"."user_roles" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role_key" text NOT NULL,
	"source" text DEFAULT 'zitadel' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_roles_user_id_role_key_pk" PRIMARY KEY ("user_id", "role_key"),
	CONSTRAINT "user_roles_id_unique" UNIQUE("id"),
	CONSTRAINT "user_roles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "user_roles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id"),
	CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id")
);
--> statement-breakpoint

-- Serves userIdsWithRole(scope, role).
CREATE INDEX "user_roles_tenant_org_role_idx" ON "app"."user_roles" USING btree ("tenant_id", "organization_id", "role_key");
--> statement-breakpoint

-- Which permission a role has, and how far it reaches (own record, department, customer org, everything).
-- The unique constraint also serves as the tenant-leading index for the per-tenant role cache load.
CREATE TABLE "app"."role_permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"role_key" text NOT NULL,
	"permission" text NOT NULL,
	"scope" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_permissions_tenant_org_role_permission_unique" UNIQUE("tenant_id", "organization_id", "role_key", "permission"),
	CONSTRAINT "role_permissions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "role_permissions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id"),
	CONSTRAINT "role_permissions_scope_check" CHECK ("scope" in ('own', 'department', 'customer_org', 'all'))
);
--> statement-breakpoint

-- One row per organization. version is bumped by every role_permissions change and every grant sync, and
-- is the cache key for the in-memory role cache. Not audited: it changes as a side effect of audited changes.
CREATE TABLE "app"."authz_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "authz_versions_tenant_org_unique" UNIQUE("tenant_id", "organization_id"),
	CONSTRAINT "authz_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "authz_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id")
);
--> statement-breakpoint

-- ZITADEL events already seen. The primary key makes a replayed event a no-op. No tenancy columns: ops.
CREATE TABLE "ops"."zitadel_events" (
	"instance_id" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"sequence" bigint NOT NULL,
	"event_type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "zitadel_events_instance_id_aggregate_id_sequence_pk" PRIMARY KEY ("instance_id", "aggregate_id", "sequence")
);
--> statement-breakpoint

-- The worker looks for events that arrived but are not processed yet.
CREATE INDEX "zitadel_events_unprocessed_idx" ON "ops"."zitadel_events" USING btree ("received_at") WHERE "processed_at" IS NULL;
--> statement-breakpoint

-- Progress of the reconcile job, one row per named cursor.
CREATE TABLE "ops"."sync_cursors" (
	"name" text PRIMARY KEY NOT NULL,
	"cursor" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- bos_app may read, add and update these bookkeeping rows but never delete them (same pattern as
-- ops.restore_canary in 0000). The REVOKE is needed because the default privileges granted all four
-- statements when bos_owner created the tables, and a GRANT never removes anything.
GRANT SELECT, INSERT, UPDATE ON "ops"."zitadel_events" TO "bos_app";
--> statement-breakpoint
REVOKE DELETE ON "ops"."zitadel_events" FROM "bos_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "ops"."sync_cursors" TO "bos_app";
--> statement-breakpoint
REVOKE DELETE ON "ops"."sync_cursors" FROM "bos_app";
--> statement-breakpoint

-- Audit triggers (audit.attach comes from 0001_audit). authz_versions is on the check-audit allowlist, so it has none.
-- users ignores last_synced_at: the reconcile job touches it on every pass, and that must not write audit rows.
SELECT audit.attach('app.departments');
--> statement-breakpoint
SELECT audit.attach('app.users', '{}', '{last_synced_at}');
--> statement-breakpoint
SELECT audit.attach('app.user_roles');
--> statement-breakpoint
SELECT audit.attach('app.role_permissions');
