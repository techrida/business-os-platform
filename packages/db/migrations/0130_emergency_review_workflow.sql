-- 0130_emergency_review_workflow: Management reviews an emergency purchase after it was received (F1-Q41).
--
-- Kuu's answer (2026-11-20): an emergency purchase is approved by Management first so buying can start, then runs
-- the normal route, then is reviewed after receipt. The receipt confirmation that brings an emergency request's
-- order to fully_received asks for an `emergency_review` approval; this migration publishes v1 of that workflow.
--
-- Per entity, like every workflow (ADR 0027), and only for an entity that already has a `purchase_request`
-- workflow (an entity without procurement routes gets none, and a receipt there records that no review was asked
-- for instead of failing). The spec is a word-for-word copy of EMERGENCY_REVIEW_WORKFLOW_SPEC in
-- apps/api/src/modules/procurement/receipts/emergency-review.ts (a test pins the two together). An entity that
-- already has the workflow is left alone, so running it again changes nothing.
--
-- Runs as bos_owner, in the migrator's one transaction, split at the breakpoint comments (same rule as 0000).

-- set_config(..., true) lasts to the end of the migrator's transaction, so every write below is recorded as
-- system:migration-0130. bos.tenant_id and bos.organization_id are set per entity in the loop.
SELECT
	set_config('bos.actor_kind', 'system', true),
	set_config('bos.actor_id', 'system:migration-0130', true),
	set_config('bos.correlation_id', 'migration-0130:' || gen_random_uuid()::text, true),
	set_config('bos.ip', '', true),
	set_config('bos.user_agent', '', true);
--> statement-breakpoint

DO $$
DECLARE
  target record;
  definition_id uuid;
  version_id uuid;
  spec constant jsonb := '{
    "documentType": "emergency_review",
    "steps": [
      {
        "id": "management",
        "kind": "role",
        "role": "management",
        "reason": "Management reviews an emergency purchase after it was received"
      }
    ],
    "rules": [],
    "distinctApprovers": true,
    "sla": { "remindAfterHours": 72, "escalateAfterHours": 168, "escalateTo": { "role": "founder" } }
  }'::jsonb;
BEGIN
  FOR target IN
    SELECT wd.tenant_id, wd.organization_id
    FROM app.workflow_definitions wd
    WHERE wd.document_type = 'purchase_request'
      AND NOT EXISTS (
        SELECT 1 FROM app.workflow_definitions er
        WHERE er.tenant_id = wd.tenant_id
          AND er.organization_id = wd.organization_id
          AND (er.document_type = 'emergency_review' OR er.key = 'emergency_review')
      )
    ORDER BY wd.tenant_id, wd.organization_id
  LOOP
    PERFORM set_config('bos.tenant_id', target.tenant_id::text, true);
    PERFORM set_config('bos.organization_id', target.organization_id::text, true);

    INSERT INTO app.workflow_definitions (tenant_id, organization_id, key, name, document_type)
    VALUES (target.tenant_id, target.organization_id, 'emergency_review', 'Emergency purchase review',
            'emergency_review')
    RETURNING id INTO definition_id;

    INSERT INTO app.workflow_versions
      (tenant_id, organization_id, definition_id, version, status, spec, published_at, published_by)
    VALUES (target.tenant_id, target.organization_id, definition_id, 1, 'published', spec, now(), NULL)
    RETURNING id INTO version_id;

    UPDATE app.workflow_definitions SET current_version_id = version_id WHERE id = definition_id;
  END LOOP;
END $$;
