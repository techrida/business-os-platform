\set ON_ERROR_STOP on
BEGIN;
SELECT set_config('bos.tenant_id', :'tenant_id', true),
 set_config('bos.organization_id', :'organization_id', true),
 set_config('bos.actor_kind', 'system', true),
 set_config('bos.actor_id', 'system:customer-document-review-activation', true),
 set_config('bos.correlation_id', 'customer-document-review-activation', true);
CREATE TEMP TABLE activation_cases ON COMMIT DROP AS
 SELECT c.* FROM app.verification_cases c JOIN app.customers p ON p.tenant_id=c.tenant_id AND p.id=c.party_id
 WHERE c.tenant_id=:'tenant_id'::uuid AND c.review_policy='case_review_v0' AND c.status IN ('draft','submitted','rejected','expired');
SELECT c.id FROM app.verification_cases c JOIN activation_cases a ON a.id=c.id FOR UPDATE OF c;
INSERT INTO app.verification_review_events(tenant_id,case_id,case_version,round,kind,decision,comment,actor_user_id,occurred_at)
 SELECT tenant_id,id,version,review_round,'legacy_case_decided',CASE WHEN status='rejected' THEN 'reject' ELSE 'approve' END,reason,reviewer_user_id,decided_at
 FROM activation_cases WHERE reviewer_user_id IS NOT NULL AND decided_at IS NOT NULL
 ON CONFLICT(tenant_id,case_id,case_version) DO NOTHING;
UPDATE app.verification_cases c SET review_policy='document_review_v1',review_round=CASE WHEN c.status='submitted' THEN 1 ELSE 0 END,version=c.version+1,updated_at=now(),
 checklist=(SELECT jsonb_agg((i - 'review' - 'evidence') || jsonb_build_object('review',null,'status',CASE WHEN i->>'documentId' IS NULL THEN 'missing' ELSE 'provided' END,'evidence',
 CASE WHEN c.status='submitted' AND v.id IS NOT NULL THEN jsonb_build_object('documentId',d.id,'documentVersionId',v.id,'versionNumber',v.version,'expiresOn',i->'expiresOn') ELSE NULL END) ORDER BY n)
 FROM jsonb_array_elements(c.checklist) WITH ORDINALITY a(i,n)
 LEFT JOIN app.documents d ON d.tenant_id=c.tenant_id AND d.owner_type='verification_case' AND d.owner_id=c.id AND d.id=(i->>'documentId')::uuid AND d.removed_at IS NULL
 LEFT JOIN LATERAL (SELECT * FROM app.document_versions v WHERE v.tenant_id=d.tenant_id AND v.organization_id=d.organization_id AND v.document_id=d.id AND v.status<>'rejected' ORDER BY version DESC LIMIT 1) v ON true)
 WHERE c.id IN (SELECT id FROM activation_cases);
SELECT id,status,version,review_policy FROM app.verification_cases WHERE id IN (SELECT id FROM activation_cases) ORDER BY id;
\if :apply
COMMIT;
\else
ROLLBACK;
\endif
