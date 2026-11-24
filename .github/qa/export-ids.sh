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
need BOS_E2E_DEPARTMENT_ID "$(q "select id from app.departments where status = 'active' and lower(btrim(name)) = 'operations' limit 1")"
need BOS_E2E_COST_CENTER_ID "$(q "select id from app.cost_centers where code = 'OPERATIONS' limit 1")"

# Portal specs: the stored logins written by e2e/p4/qa-fixtures.spec.ts, and the records of the dev vendor.
put PORTAL_E2E_STORAGE_STATE "$PWD/.dev/portal-customer.json"
put PORTAL_E2E_VENDOR_STATE "$PWD/.dev/portal-vendor.json"
# vendor2 (a second approved vendor) and vendorpending (pending_kyc, with a draft KYB case): the seeder makes both, each in its own org.
put PORTAL_E2E_VENDOR_B_STATE "$PWD/.dev/portal-vendor-b.json"
put PORTAL_E2E_PENDING_STATE "$PWD/.dev/portal-pending.json"
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

# The draft payment request of e2e/p4/qa-fixtures-payables.spec.ts (verified vendor account, approved and posted bill).
need BOS_E2E_DRAFT_PAYMENT_REQUEST_ID "$(fid paymentRequestDraft)"

# Journey 11 (e2e/p4/qa-fixtures-p4-exit.spec.ts): one connected purchase chain and an open RFQ, for the p4-exit specs of
# the workspace and the portal. The three approved seeded vendors (Dev Vendor Co, Dev Vendor Two Co, the Mumbai supplier).
echo "BOS_E2E_P4_EXIT=1" >> "$out"
echo "BOS_E2E_P4_EXIT_WORKSPACE_URL=https://app.localhost" >> "$out"
need BOS_E2E_P4_EXIT_VENDOR_IDS "$(q "select string_agg(v.id::text, ',' order by p.code) from app.vendors v join app.parties p on p.id = v.id where v.status = 'approved' and p.code in ('VEND-DEV', 'VEND-DEV2', 'VEND-IN-DEV') having count(*) = 3")"
need BOS_E2E_P4_EXIT_PR_ID "$(fid p4ExitPr)"
need BOS_E2E_P4_EXIT_RFQ_ID "$(fid p4ExitRfq)"
need BOS_E2E_P4_EXIT_PO_ID "$(fid p4ExitPo)"
need BOS_E2E_P4_EXIT_RECEIPT_ID "$(fid p4ExitReceipt)"
need BOS_E2E_P4_EXIT_BILL_ID "$(fid p4ExitBill)"
need BOS_E2E_P4_EXIT_OPEN_RFQ_ID "$(fid p4ExitOpenRfq)"
need BOS_E2E_P4_EXIT_SERIALS "$(fid p4ExitSerials)"
need BOS_E2E_P4_EXIT_VENDOR_ID "$(q "select vendor_id from app.purchase_orders where id::text = '$(fid p4ExitPo)'")"
