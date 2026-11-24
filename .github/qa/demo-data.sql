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
-- Sales people (Kuu 2026-11-24): the dev seed files them already; this repeats it for a stack whose memberships were
-- created by a first sign-in before the seed ran. Idempotent. "Lead owner" then fills in: the head of Sales is the default.
SELECT set_config('bos.actor_id', 'p4-qa-fixture-sales-department', true);
INSERT INTO app.departments (tenant_id, organization_id, name)
  SELECT o.tenant_id, o.id, 'Sales' FROM app.organizations o
   WHERE o.legal_name = 'Techrida Pvt. Ltd.'
     AND NOT EXISTS (SELECT 1 FROM app.departments d WHERE d.organization_id = o.id AND d.status = 'active' AND lower(btrim(d.name)) = 'sales');
UPDATE app.user_entities ue SET department_id = d.id, level = v.level
  FROM (VALUES ('sales@dev.bos.test','staff'), ('sales2@dev.bos.test','staff'), ('salesmgr@dev.bos.test','manager'), ('saleshead@dev.bos.test','head')) AS v(email, level),
       app.users u, app.departments d
 WHERE lower(u.email) = v.email AND u.id = ue.user_id AND u.tenant_id = ue.tenant_id
   AND d.organization_id = ue.organization_id AND d.tenant_id = ue.tenant_id AND d.status = 'active' AND lower(btrim(d.name)) = 'sales'
   AND (ue.department_id IS DISTINCT FROM d.id OR ue.level IS DISTINCT FROM v.level);
UPDATE app.departments d SET head_user_id = u.id
  FROM app.users u
 WHERE lower(u.email) = 'saleshead@dev.bos.test' AND u.tenant_id = d.tenant_id AND d.status = 'active'
   AND lower(btrim(d.name)) = 'sales' AND d.head_user_id IS DISTINCT FROM u.id;

-- Procurement fixture: one approved purchase request with an open RFQ that invites the dev vendor, and one more
-- approved request with a draft purchase order of one line (the "qa fixtures" Playwright warm-up issues it through
-- the real screen, so its versions and the request's status come from the product, not from SQL). Fictional data.
SELECT set_config('bos.actor_id', 'p4-qa-fixture-procurement', true);
DO $fixture$
DECLARE
  v_tenant uuid; v_org uuid; v_dept uuid; v_cc uuid; v_proc uuid; v_vendor uuid; v_vat uuid;
  v_pr1 uuid := gen_random_uuid(); v_pr2 uuid := gen_random_uuid(); v_pr3 uuid := gen_random_uuid(); v_pr4 uuid := gen_random_uuid(); v_po2 uuid := gen_random_uuid();
  v_exp uuid; v_doc uuid := gen_random_uuid(); v_bill uuid := gen_random_uuid(); v_fin uuid; v_rfq uuid := gen_random_uuid(); v_po uuid := gen_random_uuid();
BEGIN
  SELECT o.tenant_id, o.id INTO v_tenant, v_org FROM app.organizations o WHERE o.legal_name = 'Techrida Pvt. Ltd.';
  SELECT id INTO v_dept FROM app.departments WHERE organization_id = v_org AND status = 'active' AND lower(btrim(name)) = 'operations';
  SELECT id INTO v_cc FROM app.cost_centers WHERE organization_id = v_org AND code = 'OPERATIONS';
  SELECT id INTO v_proc FROM app.users WHERE tenant_id = v_tenant AND lower(email) = 'procurement@dev.bos.test';
  SELECT v.id INTO v_vendor FROM app.vendors v WHERE v.tenant_id = v_tenant AND v.status = 'approved'
     AND EXISTS (SELECT 1 FROM app.parties p WHERE p.id = v.id AND p.code = 'VEND-DEV');
  SELECT id INTO v_vat FROM app.tax_codes WHERE tenant_id = v_tenant AND code = 'VAT13';
  SELECT id INTO v_exp FROM app.expense_accounts WHERE tenant_id = v_tenant AND organization_id = v_org AND status = 'active' ORDER BY code LIMIT 1;
  SELECT id INTO v_fin FROM app.users WHERE tenant_id = v_tenant AND lower(email) = 'finance@dev.bos.test';
  IF v_org IS NULL OR v_dept IS NULL OR v_cc IS NULL OR v_proc IS NULL OR v_vendor IS NULL OR v_vat IS NULL THEN
    RAISE NOTICE 'procurement fixture skipped: seed rows missing (org %, dept %, cost centre %, procurement user %, vendor %, VAT %)', v_org, v_dept, v_cc, v_proc, v_vendor, v_vat;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM app.purchase_requests WHERE organization_id = v_org AND number = 'PR-QA-1') THEN RETURN; END IF;

  INSERT INTO app.purchase_requests (id, tenant_id, organization_id, request_type, department_id, requester_user_id, cost_center_id, justification, required_by, budget_code, currency)
  VALUES (v_pr1, v_tenant, v_org, 'goods', v_dept, v_proc, v_cc, 'QA fixture: office chairs', '2030-12-01', 'QA-1', 'NPR'),
         (v_pr2, v_tenant, v_org, 'goods', v_dept, v_proc, v_cc, 'QA fixture: laptops', '2030-12-01', 'QA-2', 'NPR'),
         (v_pr3, v_tenant, v_org, 'goods', v_dept, v_proc, v_cc, 'QA fixture: monitors', '2030-12-01', 'QA-3', 'NPR'),
         (v_pr4, v_tenant, v_org, 'goods', v_dept, v_proc, v_cc, 'QA fixture: keyboards', '2030-12-01', 'QA-4', 'NPR');
  INSERT INTO app.purchase_request_lines (tenant_id, organization_id, purchase_request_id, line_no, description, uom, quantity, estimated_unit_price, estimated_amount)
  VALUES (v_tenant, v_org, v_pr1, 1, 'Office chair', 'pcs', 10, 4500, 45000),
         (v_tenant, v_org, v_pr1, 2, 'Desk', 'pcs', 2, 2500, 5000),
         (v_tenant, v_org, v_pr2, 1, 'Laptop', 'pcs', 1, 79646.02, 79646.02),
         (v_tenant, v_org, v_pr3, 1, 'Monitor', 'pcs', 4, 12000, 48000),
         (v_tenant, v_org, v_pr4, 1, 'Keyboard', 'pcs', 1, 5000, 5000);

  -- Lines first: an approved request's lines are frozen.
  UPDATE app.purchase_requests SET status = CASE WHEN id = v_pr3 THEN 'dept_approved' ELSE 'approved' END, fx_rate = 1, estimated_total = CASE id WHEN v_pr1 THEN 50000.00 WHEN v_pr3 THEN 48000.00 WHEN v_pr4 THEN 5000.00 ELSE 79646.02 END, estimated_total_npr = CASE id WHEN v_pr1 THEN 50000.00 WHEN v_pr3 THEN 48000.00 WHEN v_pr4 THEN 5000.00 ELSE 79646.02 END,
         number = CASE id WHEN v_pr1 THEN 'PR-QA-1' WHEN v_pr3 THEN 'PR-QA-3' WHEN v_pr4 THEN 'PR-QA-4' ELSE 'PR-QA-2' END WHERE id IN (v_pr1, v_pr2, v_pr3, v_pr4);

  INSERT INTO app.rfqs (id, tenant_id, organization_id, purchase_request_id, number, deadline, created_by)
  VALUES (v_rfq, v_tenant, v_org, v_pr1, 'RFQ-QA-1', '2030-12-15T00:00:00Z', v_proc);
  INSERT INTO app.rfq_vendors (tenant_id, organization_id, rfq_id, vendor_id, invited_by)
  VALUES (v_tenant, v_org, v_rfq, v_vendor, v_proc);

  INSERT INTO app.purchase_orders (id, tenant_id, organization_id, number, number_seq, fiscal_year, purchase_request_id, vendor_id, currency, payment_terms_days, approved_total, fx_rate, approved_total_npr, approved_band, created_by)
  VALUES (v_po, v_tenant, v_org, 'PO-QA-1', 900001, '2082/83', v_pr2, v_vendor, 'NPR', 30, '90000.00', 1, '90000.00', 'base', v_proc);
  INSERT INTO app.purchase_order_lines (tenant_id, organization_id, purchase_order_id, purchase_request_id, line_no, kind, description, uom, ordered_quantity, unit_price, tax_code_id, gross, tax_amount, line_total)
  VALUES (v_tenant, v_org, v_po, v_pr2, 1, 'goods', 'Laptop', 'pcs', '1', '79646.02', v_vat, '79646.02', '10353.98', '90000.00');
  -- A second, draft order of the same vendor: the vendor portal must not show a draft ("foreign" id for its specs).
  INSERT INTO app.purchase_orders (id, tenant_id, organization_id, number, number_seq, fiscal_year, purchase_request_id, vendor_id, currency, payment_terms_days, approved_total, fx_rate, approved_total_npr, approved_band, created_by)
  VALUES (v_po2, v_tenant, v_org, 'PO-QA-2', 900002, '2082/83', v_pr4, v_vendor, 'NPR', 30, '5650.00', 1, '5650.00', 'base', v_proc);
  INSERT INTO app.purchase_order_lines (tenant_id, organization_id, purchase_order_id, purchase_request_id, line_no, kind, description, uom, ordered_quantity, unit_price, tax_code_id, gross, tax_amount, line_total)
  VALUES (v_tenant, v_org, v_po2, v_pr4, 1, 'goods', 'Keyboard', 'pcs', '1', '5000.00', v_vat, '5000.00', '650.00', '5650.00');

END
$fixture$;

-- The bill needs the finance user, who exists only after the first sign-in: its own block, so the second run (after
-- the warm-up) adds it although the first block returned early on PR-QA-1.
SELECT set_config('bos.actor_id', 'p4-qa-fixture-bill', true);
DO $bill$
DECLARE
  v_tenant uuid; v_org uuid; v_vendor uuid; v_vat uuid; v_exp uuid; v_fin uuid;
  v_doc uuid := gen_random_uuid(); v_bill uuid := gen_random_uuid();
BEGIN
  SELECT o.tenant_id, o.id INTO v_tenant, v_org FROM app.organizations o WHERE o.legal_name = 'Techrida Pvt. Ltd.';
  SELECT v.id INTO v_vendor FROM app.vendors v WHERE v.tenant_id = v_tenant AND v.status = 'approved'
     AND EXISTS (SELECT 1 FROM app.parties p WHERE p.id = v.id AND p.code = 'VEND-DEV');
  SELECT id INTO v_vat FROM app.tax_codes WHERE tenant_id = v_tenant AND code = 'VAT13';
  SELECT id INTO v_exp FROM app.expense_accounts WHERE tenant_id = v_tenant AND organization_id = v_org AND status = 'active' ORDER BY code LIMIT 1;
  SELECT id INTO v_fin FROM app.users WHERE tenant_id = v_tenant AND lower(email) = 'finance@dev.bos.test';
  IF v_exp IS NOT NULL AND v_fin IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.vendor_bills WHERE organization_id = v_org AND vendor_invoice_no = 'QA-INV-1') THEN
    INSERT INTO app.documents (id, tenant_id, organization_id, owner_type, owner_id) VALUES (v_doc, v_tenant, v_org, 'vendor_bill_intake', v_vendor);
    INSERT INTO app.document_versions (tenant_id, organization_id, document_id, version, filename, declared_mime, size_bytes, storage_key, status)
    VALUES (v_tenant, v_org, v_doc, 1, 'invoice.pdf', 'application/pdf', 1024, v_tenant::text || '/' || gen_random_uuid()::text, 'clean');
    INSERT INTO app.vendor_bills (id, tenant_id, organization_id, kind, vendor_id, vendor_invoice_no, invoice_date, fiscal_year, currency, document_id,
                                  status, match_status, net_total, vat_total, payable_total, fx_rate, payable_total_npr, entered_by)
    VALUES (v_bill, v_tenant, v_org, 'bill', v_vendor, 'QA-INV-1', '2026-11-09', '2083/84', 'NPR', v_doc,
            'draft', 'not_required', 10000.00, 1300.00, 11300.00, 1, 11300.00, v_fin);
    INSERT INTO app.vendor_bill_lines (tenant_id, organization_id, vendor_bill_id, line_no, description, account_id, quantity, unit_price, net_amount, tax_code_id, vat_amount)
    VALUES (v_tenant, v_org, v_bill, 1, 'Consulting', v_exp, 1, 10000.00, 10000.00, v_vat, 1300.00);
  END IF;
END
$bill$;

COMMIT;
