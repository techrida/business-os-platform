-- 0009_tenancy_fks: tenant foreign keys for the tables that were created without one, and two immutability
-- fixes. Review findings R17 (tenant integrity) and R28 (published workflow versions, org kind). Owner: FIX-D.
--
-- Runs as bos_owner, in one transaction, split at the breakpoint comments (same rule as 0000).
--
-- R17: 0004 (document_versions) and 0006 (all eight approval tables) have tenant_id but no foreign key to
-- app.tenants, so a row could name a tenant that does not exist (and survive that tenant's removal). Every
-- other app table already has one. The names follow the existing pattern <table>_tenant_id_tenants_id_fk.
-- A plain ADD CONSTRAINT validates the existing rows straight away. NOT VALID + VALIDATE would only help
-- outside a transaction (a weaker lock while validating); this file runs in one transaction, so the lock is
-- held to COMMIT either way. If a dev row names an unknown tenant, the migration fails loudly and rolls back.
--
-- Deliberately not here (on hold until organization_id's meaning is decided): organization_id foreign keys,
-- composite (tenant_id, parent_id) foreign keys, the UNIQUE (tenant_id, id) keys they need, and rewriting
-- unique keys to lead with tenant_id.

ALTER TABLE "app"."document_versions" ADD CONSTRAINT "document_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id");
--> statement-breakpoint
ALTER TABLE "app"."workflow_definitions" ADD CONSTRAINT "workflow_definitions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id");
--> statement-breakpoint
ALTER TABLE "app"."workflow_versions" ADD CONSTRAINT "workflow_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id");
--> statement-breakpoint
ALTER TABLE "app"."approval_groups" ADD CONSTRAINT "approval_groups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id");
--> statement-breakpoint
ALTER TABLE "app"."approval_group_members" ADD CONSTRAINT "approval_group_members_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id");
--> statement-breakpoint
ALTER TABLE "app"."delegations" ADD CONSTRAINT "delegations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id");
--> statement-breakpoint
ALTER TABLE "app"."approval_requests" ADD CONSTRAINT "approval_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id");
--> statement-breakpoint
ALTER TABLE "app"."approval_steps" ADD CONSTRAINT "approval_steps_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id");
--> statement-breakpoint
ALTER TABLE "app"."approval_actions" ADD CONSTRAINT "approval_actions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id");
--> statement-breakpoint

-- R28: a published (or retired) version must also keep its tenant and organization. Requests in that scope
-- point at it, and moving it would hand another tenant's or org's routing to them. The 0006 guard already
-- froze spec, definition_id and version; this replaces the function body (the trigger stays as it is) and
-- adds tenant_id and organization_id. Drafts stay editable, and publish/retire are still plain UPDATEs.
CREATE OR REPLACE FUNCTION "app"."workflow_versions_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		IF OLD."status" <> 'draft' THEN
			RAISE EXCEPTION 'workflow version % is %, it cannot be deleted', OLD."id", OLD."status" USING ERRCODE = 'check_violation';
		END IF;
		RETURN OLD;
	END IF;
	IF OLD."status" <> 'draft' AND (
		NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
		OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
	) THEN
		RAISE EXCEPTION 'workflow version % is %, its tenant and organization are immutable', OLD."id", OLD."status" USING ERRCODE = 'check_violation';
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

-- R28: assert_org_kind looks the counterparty up in the row's own tenant, so a change of tenant_id can make a
-- valid counterparty invalid. The 0007 trigger only ran when customer_organization_id was in the SET list;
-- it now also runs when tenant_id is. The function itself needs no change.
DROP TRIGGER "test_memos_assert_customer_kind" ON "app"."test_memos";
--> statement-breakpoint
CREATE TRIGGER "test_memos_assert_customer_kind" BEFORE INSERT OR UPDATE OF "customer_organization_id", "tenant_id" ON "app"."test_memos"
FOR EACH ROW EXECUTE FUNCTION "app"."assert_org_kind"('customer_organization_id', 'customer');
