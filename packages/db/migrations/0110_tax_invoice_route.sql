-- 0110_tax_invoice_route: a tax invoice from an approved billing schedule needs Finance only (F1-Q30, D56).
--
-- Kuu's answer: an invoice drafted from an approved billing schedule line was approved with its schedule, so it needs
-- Finance only; a manual tax invoice keeps Accountant then Finance, and credit and debit notes keep their own
-- Accountant then Finance routes (not touched here). The submit now sends the fact `fromSchedule`
-- (invoice.schedule_line_id IS NOT NULL), and the new tax_invoice spec routes on it.
--
-- For every entity whose CURRENT tax_invoice version is still the seeded original route (its spec equal to `v_old`,
-- word for word as tools/seed-zitadel wrote it), this publishes the new spec as the next version, retires the old one
-- and points the definition at the new one, as ApprovalsAdminService.publish does. An entity whose admin already
-- changed the route keeps it (counted in the NOTICE, never overwritten). An entity with no tax_invoice workflow gets
-- none: the seed creates new entities with the new spec as v1 (TAX_INVOICE_WORKFLOW_SPEC, kept word for word with
-- `v_new` by a test in tools/seed-zitadel).
--
-- In-flight requests are unaffected: every approval request keeps its own workflow_version_id, and reroute and decide
-- read that frozen version, never the definition's current one. Running it again finds nothing to do: the current
-- version no longer equals `v_old`.
--
-- Runs as bos_owner in the migrator's transaction. The version and definition audit rows are recorded as
-- system:migration-0110.

SELECT
	set_config('bos.actor_kind', 'system', true),
	set_config('bos.actor_id', 'system:migration-0110', true),
	set_config('bos.correlation_id', 'migration-0110:' || gen_random_uuid()::text, true),
	set_config('bos.ip', '', true),
	set_config('bos.user_agent', '', true);
--> statement-breakpoint

DO $$
DECLARE
	v_old jsonb := '{"documentType": "tax_invoice", "steps": [{"id": "accountant", "kind": "role", "role": "accountant", "reason": "Base route: accountant checks the tax invoice"}, {"id": "finance", "kind": "role", "role": "finance", "reason": "Base route: finance approves"}], "rules": [], "distinctApprovers": true, "sla": {"remindAfterHours": 24, "escalateAfterHours": 72, "escalateTo": {"role": "founder"}}}'::jsonb;
	v_new jsonb := '{"documentType": "tax_invoice", "steps": [], "rules": [{"id": "manual-invoice", "when": {"field": "fromSchedule", "op": "eq", "value": false}, "add": {"id": "accountant", "kind": "role", "role": "accountant", "reason": "Accountant checks a manual tax invoice"}, "position": "end", "reason": "Accountant check: a manual invoice, not from an approved billing schedule"}, {"id": "finance-approves", "when": {"field": "kind", "op": "eq", "value": "tax_invoice"}, "add": {"id": "finance", "kind": "role", "role": "finance", "reason": "Finance approves every tax invoice"}, "position": "end", "reason": "Finance approves every tax invoice"}], "distinctApprovers": true, "sla": {"remindAfterHours": 24, "escalateAfterHours": 72, "escalateTo": {"role": "founder"}}}'::jsonb;
	r record;
	v_version_id uuid;
	v_moved bigint := 0;
	v_kept bigint := 0;
BEGIN
	FOR r IN
		SELECT d."id" AS definition_id, d."tenant_id", d."organization_id", v."id" AS current_id, v."spec"
		FROM "app"."workflow_definitions" d
		JOIN "app"."workflow_versions" v ON v."id" = d."current_version_id"
		WHERE d."key" = 'tax_invoice' AND v."status" = 'published'
		ORDER BY d."tenant_id", d."organization_id"
		FOR UPDATE OF d
	LOOP
		IF r."spec" <> v_old THEN
			v_kept := v_kept + 1;
			CONTINUE;
		END IF;
		UPDATE "app"."workflow_versions" SET "status" = 'retired' WHERE "id" = r.current_id;
		INSERT INTO "app"."workflow_versions"
			("tenant_id", "organization_id", "definition_id", "version", "status", "spec", "published_at", "published_by")
		SELECT r."tenant_id", r."organization_id", r.definition_id, max(w."version") + 1, 'published', v_new, now(), NULL
		FROM "app"."workflow_versions" w
		WHERE w."definition_id" = r.definition_id
		RETURNING "id" INTO v_version_id;
		UPDATE "app"."workflow_definitions" SET "current_version_id" = v_version_id WHERE "id" = r.definition_id;
		v_moved := v_moved + 1;
	END LOOP;
	RAISE NOTICE '0110: % tax_invoice workflow(s) moved to the schedule-aware route; % with an edited route kept', v_moved, v_kept;
END
$$;
