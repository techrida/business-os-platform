ALTER TABLE app.verification_cases ADD COLUMN review_policy text NOT NULL DEFAULT 'case_review_v0' CHECK (review_policy IN ('case_review_v0', 'document_review_v1'));
ALTER TABLE app.verification_cases ADD COLUMN review_round integer NOT NULL DEFAULT 0 CHECK (review_round >= 0);
--> statement-breakpoint
ALTER TABLE app.document_versions ADD CONSTRAINT document_versions_review_identity_unique UNIQUE(tenant_id,organization_id,document_id,id);
CREATE TABLE app.verification_review_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
 case_id uuid NOT NULL, evidence_organization_id uuid, document_id uuid, document_version_id uuid, case_version integer NOT NULL, round integer NOT NULL CHECK (round >= 0),
 kind text NOT NULL CHECK (kind IN ('item_decided','case_decided','legacy_case_decided')),
 item_key text, decision text NOT NULL CHECK (decision IN ('approve','reject')),
 comment text, actor_user_id uuid NOT NULL, occurred_at timestamptz NOT NULL, evidence jsonb,
 CONSTRAINT verification_review_events_case_version_unique UNIQUE(tenant_id,case_id,case_version),
 FOREIGN KEY(tenant_id) REFERENCES app.tenants(id),
 FOREIGN KEY(tenant_id,evidence_organization_id,document_id,document_version_id) REFERENCES app.document_versions(tenant_id,organization_id,document_id,id),
 CHECK ((kind='item_decided' AND evidence_organization_id IS NOT NULL AND document_id IS NOT NULL AND document_version_id IS NOT NULL AND evidence->>'documentId'=document_id::text AND evidence->>'documentVersionId'=document_version_id::text) OR (kind<>'item_decided' AND evidence_organization_id IS NULL AND document_id IS NULL AND document_version_id IS NULL)),
 FOREIGN KEY(tenant_id,case_id) REFERENCES app.verification_cases(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_user_id) REFERENCES app.users(tenant_id,id),
 CHECK ((kind='item_decided' AND item_key IS NOT NULL AND evidence IS NOT NULL) OR (kind<>'item_decided' AND item_key IS NULL AND evidence IS NULL)),
 CHECK (kind='legacy_case_decided' OR decision<>'reject' OR (length(btrim(comment)) BETWEEN 1 AND 2000))
);
CREATE INDEX verification_review_events_history_idx ON app.verification_review_events(tenant_id,case_id,occurred_at,id);
SELECT audit.attach('app.verification_review_events'::regclass);
REVOKE UPDATE, DELETE ON app.verification_review_events FROM bos_app;
--> statement-breakpoint
CREATE FUNCTION app.verification_review_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Verification review journal is immutable'; END $$;
CREATE TRIGGER verification_review_immutable BEFORE UPDATE OR DELETE ON app.verification_review_events FOR EACH ROW EXECUTE FUNCTION app.verification_review_immutable();
