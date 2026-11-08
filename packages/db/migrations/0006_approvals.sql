-- 0006_approvals: workflow specs, approval groups, delegations, and the approval requests with their steps
-- and actions. Owner: U7. See the P1 plan, section 4.
--
-- Serves the NFR "approvals are auditable": a published spec can never change (trigger below), every
-- request keeps a frozen snapshot plus its SHA-256, and approval_actions is append-only for bos_app.
-- No foreign keys to app.users or app.documents: those tables belong to other units (0002, 0004), and
-- user ids are checked by the service through the user directory instead.

CREATE TABLE "app"."workflow_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"document_type" text NOT NULL,
	"current_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_definitions_key_unique" UNIQUE("tenant_id", "organization_id", "key"),
	-- One workflow per document type, so submit() and preview() can find "the" spec for a document.
	CONSTRAINT "workflow_definitions_document_type_unique" UNIQUE("tenant_id", "organization_id", "document_type")
);
--> statement-breakpoint

CREATE TABLE "app"."workflow_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"definition_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"spec" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"published_by" uuid,
	CONSTRAINT "workflow_versions_definition_version_unique" UNIQUE("definition_id", "version"),
	CONSTRAINT "workflow_versions_definition_id_fk" FOREIGN KEY ("definition_id") REFERENCES "app"."workflow_definitions"("id"),
	CONSTRAINT "workflow_versions_status_check" CHECK ("status" in ('draft', 'published', 'retired')),
	CONSTRAINT "workflow_versions_version_check" CHECK ("version" >= 1),
	CONSTRAINT "workflow_versions_published_check" CHECK ("status" = 'draft' OR "published_at" IS NOT NULL)
);
--> statement-breakpoint

ALTER TABLE "app"."workflow_definitions" ADD CONSTRAINT "workflow_definitions_current_version_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "app"."workflow_versions"("id");
--> statement-breakpoint

CREATE INDEX "workflow_versions_scope_idx" ON "app"."workflow_versions" USING btree ("tenant_id", "organization_id", "definition_id");
--> statement-breakpoint

-- A published (or retired) version is frozen: requests point at it and their routing must be reproducible.
-- Publishing itself is an UPDATE of status with the spec unchanged, so only a changed spec (or identity, or
-- a step back to draft) is refused. Deleting a non-draft version is refused for the same reason.
CREATE FUNCTION "app"."workflow_versions_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		IF OLD."status" <> 'draft' THEN
			RAISE EXCEPTION 'workflow version % is %, it cannot be deleted', OLD."id", OLD."status" USING ERRCODE = 'check_violation';
		END IF;
		RETURN OLD;
	END IF;
	IF OLD."status" <> 'draft' AND (
		NEW."spec" IS DISTINCT FROM OLD."spec"
		OR NEW."definition_id" IS DISTINCT FROM OLD."definition_id"
		OR NEW."version" IS DISTINCT FROM OLD."version"
		OR NEW."status" = 'draft'
		OR (OLD."status" = 'retired' AND NEW."status" <> 'retired')
	) THEN
		RAISE EXCEPTION 'workflow version % is %, its spec is immutable', OLD."id", OLD."status" USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "workflow_versions_guard" BEFORE UPDATE OR DELETE ON "app"."workflow_versions"
FOR EACH ROW EXECUTE FUNCTION "app"."workflow_versions_guard"();
--> statement-breakpoint

CREATE TABLE "app"."approval_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_groups_key_unique" UNIQUE("tenant_id", "organization_id", "key")
);
--> statement-breakpoint

-- The plan's key is (group_id, user_id). The extra "id" keeps the table shaped like every other app.* table,
-- which the audit trigger and check-tenancy expect.
CREATE TABLE "app"."approval_group_members" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_group_members_pk" PRIMARY KEY("group_id", "user_id"),
	CONSTRAINT "approval_group_members_id_unique" UNIQUE("id"),
	CONSTRAINT "approval_group_members_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "app"."approval_groups"("id") ON DELETE CASCADE
);
--> statement-breakpoint

CREATE INDEX "approval_group_members_scope_idx" ON "app"."approval_group_members" USING btree ("tenant_id", "organization_id", "user_id");
--> statement-breakpoint

CREATE TABLE "app"."delegations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"from_user_id" uuid NOT NULL,
	"to_user_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"document_type" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "delegations_not_self_check" CHECK ("to_user_id" <> "from_user_id"),
	CONSTRAINT "delegations_window_check" CHECK ("ends_at" > "starts_at")
);
--> statement-breakpoint

CREATE INDEX "delegations_scope_idx" ON "app"."delegations" USING btree ("tenant_id", "organization_id", "from_user_id");
--> statement-breakpoint

CREATE TABLE "app"."approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"definition_id" uuid NOT NULL,
	"workflow_version_id" uuid NOT NULL,
	"document_type" text NOT NULL,
	"document_id" uuid NOT NULL,
	"document_number" text NOT NULL,
	-- Not in the plan's column list: InboxItemDto needs a title and submit() receives one.
	"title" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"snapshot_sha256" bytea NOT NULL,
	"facts" jsonb NOT NULL,
	"requester_user_id" uuid NOT NULL,
	"sod_user_ids" uuid[] NOT NULL,
	"status" text NOT NULL,
	"block_reason" text,
	"current_seq" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "approval_requests_definition_id_fk" FOREIGN KEY ("definition_id") REFERENCES "app"."workflow_definitions"("id"),
	CONSTRAINT "approval_requests_workflow_version_id_fk" FOREIGN KEY ("workflow_version_id") REFERENCES "app"."workflow_versions"("id"),
	CONSTRAINT "approval_requests_status_check" CHECK ("status" in ('pending', 'approved', 'returned', 'rejected', 'blocked', 'cancelled')),
	CONSTRAINT "approval_requests_sha256_check" CHECK (octet_length("snapshot_sha256") = 32),
	CONSTRAINT "approval_requests_version_check" CHECK ("version" >= 1),
	CONSTRAINT "approval_requests_blocked_check" CHECK ("status" <> 'blocked' OR "block_reason" IS NOT NULL),
	CONSTRAINT "approval_requests_decided_check" CHECK (("decided_at" IS NULL) = ("status" in ('pending', 'blocked')))
);
--> statement-breakpoint

-- At most one open request per document: a second submit while one is pending or blocked fails here,
-- even if two submits race past the service's own check.
CREATE UNIQUE INDEX "approval_requests_open_unique" ON "app"."approval_requests" USING btree ("tenant_id", "document_type", "document_id") WHERE "status" IN ('pending', 'blocked');
--> statement-breakpoint

CREATE INDEX "approval_requests_scope_idx" ON "app"."approval_requests" USING btree ("tenant_id", "organization_id", "status");
--> statement-breakpoint

CREATE TABLE "app"."approval_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"role_key" text,
	"group_id" uuid,
	"user_id" uuid,
	"reason" text NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"activated_at" timestamp with time zone,
	"remind_at" timestamp with time zone,
	"escalate_at" timestamp with time zone,
	"reminded_at" timestamp with time zone,
	"escalated_at" timestamp with time zone,
	"decided_by" uuid,
	"decided_on_behalf_of" uuid,
	"decided_at" timestamp with time zone,
	CONSTRAINT "approval_steps_request_seq_unique" UNIQUE("request_id", "seq"),
	CONSTRAINT "approval_steps_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "app"."approval_requests"("id"),
	CONSTRAINT "approval_steps_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "app"."approval_groups"("id"),
	CONSTRAINT "approval_steps_seq_check" CHECK ("seq" >= 1),
	CONSTRAINT "approval_steps_kind_check" CHECK ("kind" in ('role', 'group', 'user')),
	CONSTRAINT "approval_steps_target_check" CHECK (
		("kind" = 'role') = ("role_key" IS NOT NULL)
		AND ("kind" = 'group') = ("group_id" IS NOT NULL)
		AND ("kind" = 'user') = ("user_id" IS NOT NULL)
	),
	CONSTRAINT "approval_steps_status_check" CHECK ("status" in ('waiting', 'active', 'approved', 'returned', 'rejected', 'skipped'))
);
--> statement-breakpoint

CREATE INDEX "approval_steps_scope_idx" ON "app"."approval_steps" USING btree ("tenant_id", "organization_id", "request_id");
--> statement-breakpoint

-- The SLA tick scans across tenants for active steps whose reminder or escalation time has passed.
CREATE INDEX "approval_steps_status_remind_at_idx" ON "app"."approval_steps" USING btree ("status", "remind_at");
--> statement-breakpoint

CREATE INDEX "approval_steps_status_escalate_at_idx" ON "app"."approval_steps" USING btree ("status", "escalate_at");
--> statement-breakpoint

CREATE TABLE "app"."approval_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"step_id" uuid,
	-- NULL only for the SLA tick's remind/escalate rows: the worker acts as a system actor, not a user.
	"actor_user_id" uuid,
	"on_behalf_of_user_id" uuid,
	"action" text NOT NULL,
	"comment" text,
	"idempotency_key" text,
	"request_hash" bytea,
	"request_version" integer NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_actions_idempotency_unique" UNIQUE("tenant_id", "actor_user_id", "idempotency_key"),
	CONSTRAINT "approval_actions_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "app"."approval_requests"("id"),
	CONSTRAINT "approval_actions_step_id_fk" FOREIGN KEY ("step_id") REFERENCES "app"."approval_steps"("id"),
	CONSTRAINT "approval_actions_action_check" CHECK ("action" in ('submit', 'approve', 'return', 'reject', 'escalate', 'remind', 'block', 'reroute')),
	CONSTRAINT "approval_actions_actor_check" CHECK ("actor_user_id" IS NOT NULL OR "action" in ('remind', 'escalate')),
	CONSTRAINT "approval_actions_decision_check" CHECK ("action" NOT IN ('approve', 'return', 'reject') OR ("idempotency_key" IS NOT NULL AND "request_hash" IS NOT NULL AND "result" IS NOT NULL))
);
--> statement-breakpoint

CREATE INDEX "approval_actions_scope_idx" ON "app"."approval_actions" USING btree ("tenant_id", "organization_id", "request_id");
--> statement-breakpoint

-- The action log is append-only for the app: an approval, once written, is never edited or removed.
REVOKE UPDATE, DELETE ON "app"."approval_actions" FROM "bos_app";
--> statement-breakpoint

SELECT audit.attach('app.workflow_definitions');
--> statement-breakpoint
SELECT audit.attach('app.workflow_versions');
--> statement-breakpoint
SELECT audit.attach('app.approval_groups');
--> statement-breakpoint
SELECT audit.attach('app.approval_group_members');
--> statement-breakpoint
SELECT audit.attach('app.delegations');
--> statement-breakpoint
SELECT audit.attach('app.approval_requests');
--> statement-breakpoint
SELECT audit.attach('app.approval_steps');
--> statement-breakpoint
SELECT audit.attach('app.approval_actions');
