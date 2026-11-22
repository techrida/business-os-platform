-- 0181_po_vendor_change_workflow: publishes v1 of the po_vendor_change approval workflow (K3 Q1 b).
--
-- A change of vendor on a draft purchase order whose new quotation total differs from the approved total goes back
-- through the commitment route before the order can be issued. The route is a word-for-word copy of
-- PO_VENDOR_CHANGE_WORKFLOW_SPEC in apps/api/src/modules/procurement/orders/po-vendor-change.rules.ts (a parity
-- test pins it to the seed). Per entity, like every workflow (ADR 0027), and only for an entity that already has a
-- pr_commitment workflow. An entity that already has the workflow is left alone, so running it again changes nothing.
--
-- Runs as bos_owner, in the migrator's one transaction, split at the breakpoint comments (same rule as 0000).

SELECT
	set_config('bos.actor_kind', 'system', true),
	set_config('bos.actor_id', 'system:migration-0181', true),
	set_config('bos.correlation_id', 'migration-0181:' || gen_random_uuid()::text, true),
	set_config('bos.ip', '', true),
	set_config('bos.user_agent', '', true),
	set_config('lock_timeout', '5s', true);
--> statement-breakpoint

DO $$
DECLARE
  target record;
  definition_id uuid;
  version_id uuid;
  spec constant jsonb := '{
  "documentType": "po_vendor_change",
  "steps": [
    {
      "id": "accountant",
      "kind": "role",
      "role": "accountant",
      "reason": "Base route: an Accountant checks the new vendor''s quotation"
    },
    {
      "id": "finance",
      "kind": "role",
      "role": "finance",
      "reason": "Base route: Finance commits the budget for the changed vendor''s order"
    }
  ],
  "rules": [
    {
      "id": "management",
      "when": {
        "field": "amountNpr",
        "op": "gt",
        "value": "100000.00"
      },
      "add": {
        "id": "management",
        "kind": "role",
        "role": "management",
        "reason": "Management approval because the changed vendor''s order exceeds NPR 100,000.00"
      },
      "position": "end",
      "reason": "Changed vendor''s order of NPR {amountNpr} is above NPR 100,000.00"
    },
    {
      "id": "founder",
      "when": {
        "all": [
          {
            "field": "amountNpr",
            "op": "gt",
            "value": "1000000.00"
          },
          {
            "field": "requesterIsFounder",
            "op": "eq",
            "value": false
          }
        ]
      },
      "add": {
        "id": "founder",
        "kind": "role",
        "role": "founder",
        "reason": "Founder approval because the changed vendor''s order exceeds NPR 1,000,000.00"
      },
      "position": "end",
      "reason": "Changed vendor''s order of NPR {amountNpr} is above NPR 1,000,000.00"
    },
    {
      "id": "management_second",
      "when": {
        "all": [
          {
            "field": "amountNpr",
            "op": "gt",
            "value": "1000000.00"
          },
          {
            "field": "requesterIsFounder",
            "op": "eq",
            "value": true
          }
        ]
      },
      "add": {
        "id": "management_second",
        "kind": "role",
        "role": "management",
        "reason": "A second Management approval replaces the Founder, who swapped the vendor (AD8)"
      },
      "position": "end",
      "reason": "The Founder swapped this order''s vendor to NPR {amountNpr}, above NPR 1,000,000.00"
    }
  ],
  "distinctApprovers": true,
  "sla": {
    "remindAfterHours": 24,
    "escalateAfterHours": 72,
    "escalateTo": {
      "role": "management"
    }
  }
}'::jsonb;
BEGIN
  FOR target IN
    SELECT wd.tenant_id, wd.organization_id
    FROM app.workflow_definitions wd
    WHERE wd.document_type = 'pr_commitment'
      AND NOT EXISTS (
        SELECT 1 FROM app.workflow_definitions vc
        WHERE vc.tenant_id = wd.tenant_id
          AND vc.organization_id = wd.organization_id
          AND (vc.document_type = 'po_vendor_change' OR vc.key = 'po_vendor_change')
      )
    ORDER BY wd.tenant_id, wd.organization_id
  LOOP
    PERFORM set_config('bos.tenant_id', target.tenant_id::text, true);
    PERFORM set_config('bos.organization_id', target.organization_id::text, true);

    INSERT INTO app.workflow_definitions (tenant_id, organization_id, key, name, document_type)
    VALUES (target.tenant_id, target.organization_id, 'po_vendor_change', 'Purchase order vendor change',
            'po_vendor_change')
    RETURNING id INTO definition_id;

    INSERT INTO app.workflow_versions
      (tenant_id, organization_id, definition_id, version, status, spec, published_at, published_by)
    VALUES (target.tenant_id, target.organization_id, definition_id, 1, 'published', spec, now(), NULL)
    RETURNING id INTO version_id;

    UPDATE app.workflow_definitions SET current_version_id = version_id WHERE id = definition_id;
  END LOOP;
END $$;
