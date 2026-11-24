#!/usr/bin/env bash
# Writes the ids of the demo fixtures (.github/qa/demo-data.sql, issued by e2e/p4/qa-fixtures.spec.ts) to $GITHUB_ENV
# as the BOS_E2E_* variables the env-gated Playwright specs read, so they run instead of skipping. Ids only, no secrets.
set -euo pipefail
dc() { docker compose --env-file .env -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml -f .github/qa/compose.qa.yaml "$@"; }
q() { dc exec -T postgres psql -U postgres -d bos -At -v ON_ERROR_STOP=1 -c "$1"; }
out="${GITHUB_ENV:-/dev/stdout}"
put() { if [ -n "$2" ]; then echo "$1=$2" >> "$out"; else echo "::warning::fixture id $1 not found; the specs that need it will skip"; fi; }
echo "BOS_E2E_P4=1" >> "$out"
put BOS_E2E_PO_ID "$(q "select id from app.purchase_orders where number = 'PO-QA-1'")"
put BOS_E2E_RFQ_PR_ID "$(q "select id from app.purchase_requests where number = 'PR-QA-3'")"
put BOS_E2E_BILL_ID "$(q "select id from app.vendor_bills where vendor_invoice_no = 'QA-INV-1'")"
put BOS_E2E_DEPARTMENT_ID "$(q "select id from app.departments where status = 'active' and lower(btrim(name)) = 'operations' limit 1")"
put BOS_E2E_COST_CENTER_ID "$(q "select id from app.cost_centers where code = 'OPERATIONS' limit 1")"

# Portal specs: the stored logins written by e2e/p4/qa-fixtures.spec.ts, and the records of the dev vendor.
put PORTAL_E2E_STORAGE_STATE "$PWD/.dev/portal-customer.json"
put PORTAL_E2E_VENDOR_STATE "$PWD/.dev/portal-vendor.json"
put PORTAL_E2E_VENDOR_PO_ID "$(q "select id from app.purchase_orders where number = 'PO-QA-1'")"
put PORTAL_E2E_VENDOR_FOREIGN_ID "$(q "select id from app.purchase_orders where number = 'PO-QA-2'")"
put PORTAL_E2E_VENDOR_RFQ_ID "$(q "select id from app.rfqs where number = 'RFQ-QA-1'")"
put PORTAL_E2E_VENDOR_BILL_ID "$(q "select id from app.vendor_bills where vendor_invoice_no = 'QA-INV-1'")"
