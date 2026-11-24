#!/usr/bin/env bash
# Writes the ids of the demo fixtures (.github/qa/demo-data.sql, issued by e2e/p4/qa-fixtures.spec.ts) to $GITHUB_ENV
# as the BOS_E2E_* variables the env-gated Playwright specs read, so they run instead of skipping. Ids only, no secrets.
set -euo pipefail
dc() { docker compose --env-file .env -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml -f .github/qa/compose.qa.yaml "$@"; }
q() { dc exec -T postgres psql -U postgres -d bos -At -v ON_ERROR_STOP=1 -c "$1"; }
out="${GITHUB_ENV:-/dev/stdout}"
put() { if [ -n "$2" ]; then echo "$1=$2" >> "$out"; else echo "::warning::fixture id $1 not found; the specs that need it will skip"; fi; }
# Ids the fixtures always seed: missing or ambiguous means the fixture step is broken, so fail instead of letting specs skip.
need() {
  case "$2" in
    '') echo "::error::fixture id $1 not found"; exit 1 ;;
    *$'\n'*) echo "::error::fixture id $1 matched more than one row"; exit 1 ;;
  esac
  echo "$1=$2" >> "$out"
}
echo "BOS_E2E_P4=1" >> "$out"
need BOS_E2E_PO_ID "$(q "select id from app.purchase_orders where number = 'PO-QA-1'")"
need BOS_E2E_RFQ_PR_ID "$(q "select id from app.purchase_requests where number = 'PR-QA-3'")"
need BOS_E2E_BILL_ID "$(q "select id from app.vendor_bills where vendor_invoice_no = 'QA-INV-1'")"
put BOS_E2E_DEPARTMENT_ID "$(q "select id from app.departments where status = 'active' and lower(btrim(name)) = 'operations' limit 1")"
put BOS_E2E_COST_CENTER_ID "$(q "select id from app.cost_centers where code = 'OPERATIONS' limit 1")"

# Portal specs: the stored logins written by e2e/p4/qa-fixtures.spec.ts, and the records of the dev vendor.
put PORTAL_E2E_STORAGE_STATE "$PWD/.dev/portal-customer.json"
put PORTAL_E2E_VENDOR_STATE "$PWD/.dev/portal-vendor.json"
need PORTAL_E2E_VENDOR_PO_ID "$(q "select id from app.purchase_orders where number = 'PO-QA-1'")"
need PORTAL_E2E_VENDOR_FOREIGN_ID "$(q "select id from app.purchase_orders where number = 'PO-QA-2'")"
need PORTAL_E2E_VENDOR_RFQ_ID "$(q "select id from app.rfqs where number = 'RFQ-QA-1'")"
need PORTAL_E2E_VENDOR_BILL_ID "$(q "select id from app.vendor_bills where vendor_invoice_no = 'QA-INV-1'")"

# Billing fixtures (e2e/p4/qa-fixtures-billing.spec.ts): found by the marker the fixture put in each document.
echo "BOS_E2E_INVOICES_READY=1" >> "$out"
need BOS_E2E_INVOICE_ISSUED "$(q "select id from app.invoices where manual_reason = 'QA fixture: issued invoice' and status = 'issued'")"
need PORTAL_E2E_INVOICE_ID "$(q "select id from app.invoices where manual_reason = 'QA fixture: issued invoice' and status = 'issued'")"
need PORTAL_E2E_FOREIGN_INVOICE_ID "$(q "select id from app.invoices where manual_reason = 'QA fixture: invoice of another customer' and status = 'issued'")"
need PORTAL_E2E_DRAFT_ID "$(q "select id from app.invoices where manual_reason = 'QA fixture: draft invoice' and status = 'draft'")"
need BOS_E2E_PAYMENT_VERIFIED "$(q "select id from app.payments where bank_reference = 'QA-FIXTURE-PAYMENT' and status = 'verified'")"
# The seeded customer the invoice and payment forms pick by name, and a small proof file written by the fixtures.
echo "BOS_E2E_PAYMENT_CUSTOMER=Dev Customer Co" >> "$out"
echo "BOS_E2E_INVOICE_DRAFT_CUSTOMER=Dev Customer Co" >> "$out"
put PORTAL_E2E_PROOF_FILE "$PWD/.dev/portal-proof.pdf"

# Quotation fixtures (e2e/p4/qa-fixtures-quotations.spec.ts): the fixture records quotation ids in .dev/qa-fixture-ids.json.
fid() { node -p "const v = require('./.dev/qa-fixture-ids.json')['$1']; Array.isArray(v) ? v.join(',') : (v || '')"; }
# The portal links a quotation by its current version, not by the quotation.
versions_of() { q "select string_agg(current_version_id::text, ',' order by array_position(string_to_array('$1', ','), id::text)) from app.quotations where id::text = any(string_to_array('$1', ','))"; }
need E2E_OPPORTUNITY_ID "$(fid opportunity)"
need BOS_E2E_QUOTATION_SENT "$(fid quotationStaffSent)"
need BOS_E2E_QUOTATION_DOWNLOAD "$(fid quotationStaffSent)"
need BOS_E2E_QUOTATION_REVISABLE "$(fid quotationRevisable)"
# Approved and not yet sent, one per repeat, for the Send spec (p2/quotations.spec.ts); the contact is the one the fixtures send to.
need BOS_E2E_QUOTATION_APPROVED "$(fid quotationApproved)"
echo "BOS_E2E_QUOTATION_CONTACT=customer@dev.bos.test" >> "$out"
need PORTAL_E2E_SENT_ID "$(versions_of "$(fid quotationPortalSent)")"
need PORTAL_E2E_FOREIGN_ID "$(versions_of "$(fid quotationDraft)")"
