-- 0014_composite_keys: every key and foreign key of ADR 0027 section 8, so a child row can never point at another
-- tenant's parent, nor (between entity-owned tables) at another legal entity's parent.
--
--   1. Parent keys: (tenant_id, id) on every FK parent and (tenant_id, organization_id, id) on the entity-owned
--      parents that entity-owned children reference. 0013 already made those of organizations, users, idp_orgs
--      and departments.
--   2. The single-column foreign keys go (names read from pg_constraint on a database migrated to 0013).
--   3. (tenant_id, organization_id) -> organizations (tenant_id, id) on every entity-owned table
--      (<table>_tenant_org_fk; user_entities has it since 0013).
--   4. The composite child keys: (tenant_id, x) into a tenant-scoped parent (users, idp_orgs), and
--      (tenant_id, organization_id, x) into an entity-owned parent. ON DELETE CASCADE stays on the group members;
--      no other replaced key had an ON DELETE or ON UPDATE action, and none was deferrable.
--   5. The unique keys that did not lead with tenant_id are re-led.
-- Names follow the K1-U2 naming convention, mirrored in the Drizzle schema. Nothing here is shortened.
--
-- DDL only: no row is written, so the audit trigger never runs (0013's actor context is still set anyway, in
-- the migrator's one transaction). ADD CONSTRAINT validates the existing rows: a dev database holding a row
-- whose parent is in another tenant or entity fails here with 23503; reset it.
--
-- Not added: foreign keys for columns that never had one (delegations' user columns, approval user columns,
-- documents.created_by). Section 8 replaces keys; it does not add references the code has never relied on.
-- Runs as bos_owner, split at the breakpoint comments (same rule as 0000).

-- 1. Parent keys. All of them before any foreign key: documents and document_versions (and the two workflow
-- tables) reference each other.
ALTER TABLE "app"."documents" ADD CONSTRAINT "documents_tenant_id_unique" UNIQUE("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."documents" ADD CONSTRAINT "documents_tenant_org_id_unique" UNIQUE("tenant_id", "organization_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."document_versions" ADD CONSTRAINT "document_versions_tenant_id_unique" UNIQUE("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."document_versions" ADD CONSTRAINT "document_versions_tenant_org_id_unique" UNIQUE("tenant_id", "organization_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."workflow_definitions" ADD CONSTRAINT "workflow_definitions_tenant_id_unique" UNIQUE("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."workflow_definitions" ADD CONSTRAINT "workflow_definitions_tenant_org_id_unique" UNIQUE("tenant_id", "organization_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."workflow_versions" ADD CONSTRAINT "workflow_versions_tenant_id_unique" UNIQUE("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."workflow_versions" ADD CONSTRAINT "workflow_versions_tenant_org_id_unique" UNIQUE("tenant_id", "organization_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."approval_groups" ADD CONSTRAINT "approval_groups_tenant_id_unique" UNIQUE("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."approval_groups" ADD CONSTRAINT "approval_groups_tenant_org_id_unique" UNIQUE("tenant_id", "organization_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."approval_requests" ADD CONSTRAINT "approval_requests_tenant_id_unique" UNIQUE("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."approval_requests" ADD CONSTRAINT "approval_requests_tenant_org_id_unique" UNIQUE("tenant_id", "organization_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."approval_steps" ADD CONSTRAINT "approval_steps_tenant_id_unique" UNIQUE("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."approval_steps" ADD CONSTRAINT "approval_steps_tenant_org_id_unique" UNIQUE("tenant_id", "organization_id", "id");
--> statement-breakpoint

-- 2. The single-column foreign keys. Organization keys first, then the child keys.
ALTER TABLE "app"."departments" DROP CONSTRAINT "departments_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "app"."documents" DROP CONSTRAINT "documents_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "app"."idempotency_keys" DROP CONSTRAINT "idempotency_keys_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "app"."notifications" DROP CONSTRAINT "notifications_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "app"."number_series" DROP CONSTRAINT "number_series_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "app"."outbox" DROP CONSTRAINT "outbox_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "app"."settings" DROP CONSTRAINT "settings_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "app"."test_memos" DROP CONSTRAINT "test_memos_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "app"."approval_actions" DROP CONSTRAINT "approval_actions_request_id_fk";
--> statement-breakpoint
ALTER TABLE "app"."approval_actions" DROP CONSTRAINT "approval_actions_step_id_fk";
--> statement-breakpoint
ALTER TABLE "app"."approval_group_members" DROP CONSTRAINT "approval_group_members_group_id_fk";
--> statement-breakpoint
ALTER TABLE "app"."approval_requests" DROP CONSTRAINT "approval_requests_definition_id_fk";
--> statement-breakpoint
ALTER TABLE "app"."approval_requests" DROP CONSTRAINT "approval_requests_workflow_version_id_fk";
--> statement-breakpoint
ALTER TABLE "app"."approval_steps" DROP CONSTRAINT "approval_steps_request_id_fk";
--> statement-breakpoint
ALTER TABLE "app"."approval_steps" DROP CONSTRAINT "approval_steps_group_id_fk";
--> statement-breakpoint
ALTER TABLE "app"."departments" DROP CONSTRAINT "departments_head_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "app"."document_versions" DROP CONSTRAINT "document_versions_document_id_fk";
--> statement-breakpoint
-- Same name as its replacement below.
ALTER TABLE "app"."documents" DROP CONSTRAINT "documents_current_version_fk";
--> statement-breakpoint
ALTER TABLE "app"."notifications" DROP CONSTRAINT "notifications_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "app"."outbox" DROP CONSTRAINT "outbox_to_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "app"."test_memos" DROP CONSTRAINT "test_memos_department_id_departments_id_fk";
--> statement-breakpoint
ALTER TABLE "app"."test_memos" DROP CONSTRAINT "test_memos_owner_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "app"."user_roles" DROP CONSTRAINT "user_roles_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "app"."users" DROP CONSTRAINT "users_idp_org_id_idp_orgs_id_fk";
--> statement-breakpoint
ALTER TABLE "app"."workflow_definitions" DROP CONSTRAINT "workflow_definitions_current_version_id_fk";
--> statement-breakpoint
ALTER TABLE "app"."workflow_versions" DROP CONSTRAINT "workflow_versions_definition_id_fk";
--> statement-breakpoint

-- 3. The entity of every entity-owned row belongs to the row's tenant.
ALTER TABLE "app"."approval_actions" ADD CONSTRAINT "approval_actions_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."approval_group_members" ADD CONSTRAINT "approval_group_members_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."approval_groups" ADD CONSTRAINT "approval_groups_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."approval_requests" ADD CONSTRAINT "approval_requests_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."approval_steps" ADD CONSTRAINT "approval_steps_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."delegations" ADD CONSTRAINT "delegations_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."departments" ADD CONSTRAINT "departments_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."document_versions" ADD CONSTRAINT "document_versions_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."documents" ADD CONSTRAINT "documents_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."idempotency_keys" ADD CONSTRAINT "idempotency_keys_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."notifications" ADD CONSTRAINT "notifications_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."number_series" ADD CONSTRAINT "number_series_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."outbox" ADD CONSTRAINT "outbox_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."settings" ADD CONSTRAINT "settings_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."test_memos" ADD CONSTRAINT "test_memos_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."workflow_definitions" ADD CONSTRAINT "workflow_definitions_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."workflow_versions" ADD CONSTRAINT "workflow_versions_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id");
--> statement-breakpoint

-- 4a. Into a tenant-scoped parent: (tenant_id, x).
ALTER TABLE "app"."departments" ADD CONSTRAINT "departments_head_user_fk" FOREIGN KEY ("tenant_id", "head_user_id") REFERENCES "app"."users"("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."notifications" ADD CONSTRAINT "notifications_user_fk" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "app"."users"("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."outbox" ADD CONSTRAINT "outbox_to_user_fk" FOREIGN KEY ("tenant_id", "to_user_id") REFERENCES "app"."users"("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."test_memos" ADD CONSTRAINT "test_memos_owner_user_fk" FOREIGN KEY ("tenant_id", "owner_user_id") REFERENCES "app"."users"("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."user_roles" ADD CONSTRAINT "user_roles_user_fk" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "app"."users"("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."users" ADD CONSTRAINT "users_idp_org_fk" FOREIGN KEY ("tenant_id", "idp_org_id") REFERENCES "app"."idp_orgs"("tenant_id", "id");
--> statement-breakpoint

-- 4b. Into an entity-owned parent: (tenant_id, organization_id, x). MATCH SIMPLE: a nullable reference
-- (current_version_id, step_id, group_id, department_id) is not checked while it is NULL.
ALTER TABLE "app"."approval_actions" ADD CONSTRAINT "approval_actions_request_fk" FOREIGN KEY ("tenant_id", "organization_id", "request_id") REFERENCES "app"."approval_requests"("tenant_id", "organization_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."approval_actions" ADD CONSTRAINT "approval_actions_step_fk" FOREIGN KEY ("tenant_id", "organization_id", "step_id") REFERENCES "app"."approval_steps"("tenant_id", "organization_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."approval_group_members" ADD CONSTRAINT "approval_group_members_group_fk" FOREIGN KEY ("tenant_id", "organization_id", "group_id") REFERENCES "app"."approval_groups"("tenant_id", "organization_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "app"."approval_requests" ADD CONSTRAINT "approval_requests_definition_fk" FOREIGN KEY ("tenant_id", "organization_id", "definition_id") REFERENCES "app"."workflow_definitions"("tenant_id", "organization_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."approval_requests" ADD CONSTRAINT "approval_requests_workflow_version_fk" FOREIGN KEY ("tenant_id", "organization_id", "workflow_version_id") REFERENCES "app"."workflow_versions"("tenant_id", "organization_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."approval_steps" ADD CONSTRAINT "approval_steps_request_fk" FOREIGN KEY ("tenant_id", "organization_id", "request_id") REFERENCES "app"."approval_requests"("tenant_id", "organization_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."approval_steps" ADD CONSTRAINT "approval_steps_group_fk" FOREIGN KEY ("tenant_id", "organization_id", "group_id") REFERENCES "app"."approval_groups"("tenant_id", "organization_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."document_versions" ADD CONSTRAINT "document_versions_document_fk" FOREIGN KEY ("tenant_id", "organization_id", "document_id") REFERENCES "app"."documents"("tenant_id", "organization_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."documents" ADD CONSTRAINT "documents_current_version_fk" FOREIGN KEY ("tenant_id", "organization_id", "current_version_id") REFERENCES "app"."document_versions"("tenant_id", "organization_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."test_memos" ADD CONSTRAINT "test_memos_department_fk" FOREIGN KEY ("tenant_id", "organization_id", "department_id") REFERENCES "app"."departments"("tenant_id", "organization_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."workflow_definitions" ADD CONSTRAINT "workflow_definitions_current_version_fk" FOREIGN KEY ("tenant_id", "organization_id", "current_version_id") REFERENCES "app"."workflow_versions"("tenant_id", "organization_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."workflow_versions" ADD CONSTRAINT "workflow_versions_definition_fk" FOREIGN KEY ("tenant_id", "organization_id", "definition_id") REFERENCES "app"."workflow_definitions"("tenant_id", "organization_id", "id");
--> statement-breakpoint

-- 5. Unique keys re-led with tenant_id. Nothing references them. The seed's workflow-version upsert must target
-- (tenant_id, definition_id, version) from now on (ADR 0027 section 9).
ALTER TABLE "app"."workflow_versions" DROP CONSTRAINT "workflow_versions_definition_version_unique";
--> statement-breakpoint
ALTER TABLE "app"."workflow_versions" ADD CONSTRAINT "workflow_versions_tenant_definition_version_unique" UNIQUE("tenant_id", "definition_id", "version");
--> statement-breakpoint
ALTER TABLE "app"."approval_steps" DROP CONSTRAINT "approval_steps_request_seq_unique";
--> statement-breakpoint
ALTER TABLE "app"."approval_steps" ADD CONSTRAINT "approval_steps_tenant_request_seq_unique" UNIQUE("tenant_id", "request_id", "seq");
--> statement-breakpoint
ALTER TABLE "app"."document_versions" DROP CONSTRAINT "document_versions_document_version_unique";
--> statement-breakpoint
ALTER TABLE "app"."document_versions" ADD CONSTRAINT "document_versions_tenant_document_version_unique" UNIQUE("tenant_id", "document_id", "version");
--> statement-breakpoint
ALTER TABLE "app"."approval_group_members" DROP CONSTRAINT "approval_group_members_pk";
--> statement-breakpoint
ALTER TABLE "app"."approval_group_members" ADD CONSTRAINT "approval_group_members_tenant_group_user_pk" PRIMARY KEY("tenant_id", "group_id", "user_id");
