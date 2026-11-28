-- Perf data for the k6 database-read scenarios (perf/k6/db-reads.js, `pnpm perf:db-reads`). Dev stacks only.
--
-- Adds, to the default legal entity of the first tenant (override with -v tenant_id=... -v org_id=...):
--   * 5,000 draft quotations (3 lines and a tax summary each); the version of every 10th carries a document
--     style with a 50 KB logo, the weight a rendered quotation carries into every list row (U1-08);
--   * 17,400 approval requests, 50,200 approval steps in all: 2,000 pending (step 1 active for the accountant role,
--     step 2 waiting for finance) and 15,400 decided, each with an 8 KB snapshot (U1-07).
-- It needs what the demo seed already holds: a customer with an opportunity, a published approval workflow, an
-- active staff user, and a VAT tax code (added when missing). Run it once per stack; a second run stops at the
-- first line below. Rows are numbered PERF-QT-n and PERF-APR-n, so they are easy to find and to delete by hand.
--
-- Run it as the table owner or a superuser, for example through perf/seed/seed-db-reads.sh. The audit triggers need
-- bos.actor_id (set below, as `system`). The document style guard refuses a style on a draft, so the style is
-- written with the user triggers of quotation_versions switched off for that one UPDATE, inside this transaction.
-- That state (a styled draft) cannot arise in the app; it only gives the list row its real weight.
\set ON_ERROR_STOP on
BEGIN;

SELECT set_config('perf.tenant_id', coalesce(:'tenant_id', ''), true),
       set_config('perf.org_id', coalesce(:'org_id', ''), true);

DO $perf$
DECLARE
  v_org uuid;
  v_tenant uuid;
  v_customer uuid;
  v_opportunity uuid;
  v_owner uuid;
  v_vat uuid;
  v_quotations constant int := 5000;
  v_pending constant int := 2000;
  v_decided constant int := 15400;
BEGIN
  v_org := nullif(current_setting('perf.org_id', true), '')::uuid;
  v_tenant := nullif(current_setting('perf.tenant_id', true), '')::uuid;
  IF v_org IS NULL THEN
    SELECT o.id, o.tenant_id INTO v_org, v_tenant
      FROM app.organizations o
     WHERE o.is_default AND (v_tenant IS NULL OR o.tenant_id = v_tenant)
     ORDER BY o.created_at LIMIT 1;
  ELSE
    SELECT tenant_id INTO v_tenant FROM app.organizations WHERE id = v_org;
  END IF;
  IF v_org IS NULL THEN RAISE EXCEPTION 'no legal entity found: run the demo seed first'; END IF;
  IF EXISTS (SELECT 1 FROM app.quotations WHERE tenant_id = v_tenant AND organization_id = v_org AND number LIKE 'PERF-QT-%') THEN
    RAISE NOTICE 'perf rows already exist for this entity: nothing to do';
    RETURN;
  END IF;

  PERFORM set_config('bos.tenant_id', v_tenant::text, true);
  PERFORM set_config('bos.organization_id', v_org::text, true);
  PERFORM set_config('bos.actor_kind', 'system', true);
  PERFORM set_config('bos.actor_id', 'perf-seed', true);

  SELECT o.id, o.customer_id INTO v_opportunity, v_customer
    FROM app.opportunities o
   WHERE o.tenant_id = v_tenant AND o.organization_id = v_org
   ORDER BY o.created_at LIMIT 1;
  IF v_opportunity IS NULL THEN RAISE EXCEPTION 'no opportunity in this entity: run the demo seed first'; END IF;
  SELECT u.id INTO v_owner
    FROM app.users u
    JOIN app.user_entities ue ON ue.tenant_id = u.tenant_id AND ue.user_id = u.id AND ue.organization_id = v_org
   WHERE u.tenant_id = v_tenant AND u.status = 'active'
   ORDER BY u.created_at LIMIT 1;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'no active staff user in this entity'; END IF;
  SELECT id INTO v_vat FROM app.tax_codes
   WHERE tenant_id = v_tenant AND kind = 'vat' AND rate_bp = 1300 AND effective_to IS NULL
   ORDER BY effective_from LIMIT 1;
  IF v_vat IS NULL THEN
    INSERT INTO app.tax_codes (tenant_id, code, name, kind, rate_bp, creditable, effective_from)
    VALUES (v_tenant, 'PERF-VAT13', 'VAT 13% (perf)', 'vat', 1300, true, '2020-01-01')
    RETURNING id INTO v_vat;
  END IF;

  -- Quotations: parent first (no current version yet), then the version, then the pointer.
  INSERT INTO app.quotations (id, tenant_id, organization_id, number, customer_party_id, opportunity_id, owner_user_id,
                              created_at, updated_at)
  SELECT gen_random_uuid(), v_tenant, v_org, 'PERF-QT-' || lpad(n::text, 5, '0'), v_customer, v_opportunity, v_owner,
         now() - (n || ' minutes')::interval, now() - (n || ' minutes')::interval
    FROM generate_series(1, v_quotations) AS n;

  INSERT INTO app.quotation_versions (tenant_id, organization_id, quotation_id, revision_no, status, currency,
                                      issue_date, valid_until, subtotal, taxable_amount, tax_amount, total, created_at, updated_at)
  SELECT q.tenant_id, q.organization_id, q.id, 1, 'draft', 'NPR', current_date, current_date + 30,
         100000 + n.n, 100000 + n.n, round((100000 + n.n) * 0.13, 2), 100000 + n.n + round((100000 + n.n) * 0.13, 2),
         q.created_at, q.updated_at
    FROM app.quotations q
    JOIN LATERAL (SELECT substr(q.number, 9)::int AS n) n ON true
   WHERE q.tenant_id = v_tenant AND q.organization_id = v_org AND q.number LIKE 'PERF-QT-%';

  UPDATE app.quotations q SET current_version_id = v.id
    FROM app.quotation_versions v
   WHERE q.tenant_id = v_tenant AND q.organization_id = v_org AND q.number LIKE 'PERF-QT-%'
     AND v.tenant_id = q.tenant_id AND v.quotation_id = q.id;

  INSERT INTO app.quotation_lines (tenant_id, organization_id, version_id, line_no, description, uom, quantity, unit_price,
                                   tax_code_id, gross, taxable)
  SELECT v.tenant_id, v.organization_id, v.id, l.line_no, 'Perf line ' || l.line_no, 'lot', 1, v.subtotal / 3,
         v_vat, round(v.subtotal / 3, 2), round(v.subtotal / 3, 2)
    FROM app.quotation_versions v
    JOIN app.quotations q ON q.tenant_id = v.tenant_id AND q.id = v.quotation_id AND q.number LIKE 'PERF-QT-%'
   CROSS JOIN generate_series(1, 3) AS l(line_no)
   WHERE v.tenant_id = v_tenant AND v.organization_id = v_org;
  -- The lines round per line, so the header keeps its own figures; the list and detail reads never re-add them.

  INSERT INTO app.quotation_tax_summary (tenant_id, organization_id, version_id, tax_code_id, label, rate, base, tax)
  SELECT v.tenant_id, v.organization_id, v.id, v_vat, 'VAT 13%', 13, v.taxable_amount, v.tax_amount
    FROM app.quotation_versions v
    JOIN app.quotations q ON q.tenant_id = v.tenant_id AND q.id = v.quotation_id AND q.number LIKE 'PERF-QT-%'
   WHERE v.tenant_id = v_tenant AND v.organization_id = v_org;

  ALTER TABLE app.quotation_versions DISABLE TRIGGER USER;
  UPDATE app.quotation_versions v
     SET document_style = jsonb_build_object('layout', 'classic', 'accent', '#1f4e79',
                                             'logo', 'data:image/png;base64,' || repeat(md5(v.id::text), 1600))
    FROM app.quotations q
   WHERE q.tenant_id = v.tenant_id AND q.id = v.quotation_id AND q.number LIKE 'PERF-QT-%'
     AND v.tenant_id = v_tenant AND mod(substr(q.number, 9)::int, 10) = 0;
  ALTER TABLE app.quotation_versions ENABLE TRIGGER USER;

  -- Approvals: requests spread over the entity's published workflow versions.
  CREATE TEMP TABLE perf_versions ON COMMIT DROP AS
    SELECT row_number() OVER (ORDER BY v.id) - 1 AS idx, v.id AS version_id, d.id AS definition_id, d.document_type
      FROM app.workflow_versions v
      JOIN app.workflow_definitions d ON d.tenant_id = v.tenant_id AND d.organization_id = v.organization_id AND d.id = v.definition_id
     WHERE v.tenant_id = v_tenant AND v.organization_id = v_org AND v.status = 'published';
  IF NOT EXISTS (SELECT 1 FROM perf_versions) THEN
    RAISE EXCEPTION 'no published approval workflow in this entity: run the demo seed first';
  END IF;

  INSERT INTO app.approval_requests (id, tenant_id, organization_id, definition_id, workflow_version_id, document_type,
                                     document_id, document_number, title, snapshot, snapshot_sha256, facts,
                                     requester_user_id, sod_user_ids, status, current_seq, version, submitted_at, decided_at)
  SELECT gen_random_uuid(), v_tenant, v_org, pv.definition_id, pv.version_id, pv.document_type,
         gen_random_uuid(), 'PERF-APR-' || lpad(n::text, 6, '0'), 'Perf request ' || n,
         jsonb_build_object('title', 'Perf request ' || n, 'note', repeat(md5(n::text), 250)),
         sha256(convert_to(n::text, 'UTF8')), jsonb_build_object('amountNpr', (1000 + (n % 98) * 1000) || '.00'),
         v_owner, ARRAY[v_owner], CASE WHEN n <= v_pending THEN 'pending' ELSE 'approved' END,
         CASE WHEN n <= v_pending THEN 1 ELSE 3 END, CASE WHEN n <= v_pending THEN 1 ELSE 4 END,
         now() - (n || ' minutes')::interval, CASE WHEN n <= v_pending THEN NULL ELSE now() - (n || ' minutes')::interval + interval '30 seconds' END
    FROM generate_series(1, v_pending + v_decided) AS n
    JOIN perf_versions pv ON pv.idx = n % (SELECT count(*) FROM perf_versions);

  INSERT INTO app.approval_steps (tenant_id, organization_id, request_id, seq, kind, role_key, reason, status, activated_at,
                                  decided_by, decided_at)
  SELECT r.tenant_id, r.organization_id, r.id, s.seq, 'role',
         (ARRAY['accountant', 'finance', 'management'])[s.seq],
         'Perf step ' || s.seq,
         CASE WHEN r.status = 'approved' THEN 'approved' WHEN s.seq = 1 THEN 'active' ELSE 'waiting' END,
         CASE WHEN r.status = 'approved' OR s.seq = 1 THEN r.submitted_at END,
         CASE WHEN r.status = 'approved' THEN v_owner END,
         CASE WHEN r.status = 'approved' THEN r.decided_at END
    FROM app.approval_requests r
    CROSS JOIN generate_series(1, 3) AS s(seq)
   WHERE r.tenant_id = v_tenant AND r.organization_id = v_org AND r.document_number LIKE 'PERF-APR-%'
     AND (r.status = 'approved' OR s.seq <= 2);
END
$perf$;

COMMIT;
ANALYZE app.quotations;
ANALYZE app.quotation_versions;
ANALYZE app.approval_requests;
ANALYZE app.approval_steps;
