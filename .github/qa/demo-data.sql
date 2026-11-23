-- Demo fixtures the dev QA specs expect (same as the manual-run stack): a General department for staff memberships and the entity address
-- that invoice issuing needs. Applied by up.sh; audited as system actors.
BEGIN;
SELECT set_config('bos.tenant_id', o.tenant_id::text, true), set_config('bos.organization_id', o.id::text, true),
       set_config('bos.actor_kind', 'system', true), set_config('bos.actor_id', 'p4-qa-fixture-general-department', true),
       set_config('bos.correlation_id', 'testrun-demo-data', true), set_config('bos.ip', '', true), set_config('bos.user_agent', '', true)
  FROM app.organizations o WHERE o.legal_name = 'Techrida Pvt. Ltd.';
INSERT INTO app.departments (tenant_id, organization_id, name)
  SELECT o.tenant_id, o.id, 'General' FROM app.organizations o
   WHERE o.legal_name = 'Techrida Pvt. Ltd.'
     AND NOT EXISTS (SELECT 1 FROM app.departments d WHERE d.organization_id = o.id AND d.name = 'General');
UPDATE app.user_entities ue SET department_id = d.id
  FROM app.departments d
 WHERE d.name = 'General' AND d.organization_id = ue.organization_id AND d.tenant_id = ue.tenant_id AND ue.department_id IS NULL;
SELECT set_config('bos.actor_id', 'p4-qa-fixture-demo-issuer', true);
INSERT INTO app.settings (tenant_id, organization_id, key, version, value)
  SELECT o.tenant_id, o.id, 'entity.address', 1, '{"line":"12 Durbar Marg","city":"Kathmandu","country":"NP"}'::jsonb
    FROM app.organizations o
   WHERE o.legal_name = 'Techrida Pvt. Ltd.'
     AND NOT EXISTS (SELECT 1 FROM app.settings s WHERE s.organization_id = o.id AND s.key = 'entity.address');
COMMIT;
