#!/usr/bin/env bash
# FQA2 Job 0: the portal fixture, through the real UI only (no SQL).
# Customer: Dev Customer Co (CUST-DEV), the organization the Dev Customer portal persona belongs to.
# 1. sales.mjs, linked to the existing customer (SALES_EXISTING_CUSTOMER): lead -> convert -> verification (3 documents,
#    independent approval) -> quotation -> approvals -> send -> acceptance recorded. Use a new label each time.
# 2. fqa2-confirm-order.mjs: the Founder confirms the draft order (pass the sales-order id from the run's state).
# 3. The portal check: the customer signs in on the portal for real and sees the quotation and the order.
# usage: fqa2-fixture.sh <label> ; then fqa2-confirm-order.mjs <sales-order-id>
set -euo pipefail
cd "$(dirname "$0")/../../.."
source /home/crestia/bos-runtimes/round5/qa-env.sh
export VIDEO_DIR=${VIDEO_DIR:-/home/crestia/bos-runtimes/round5/evidence/FQA2/run}
export SALES_EXISTING_CUSTOMER="Dev Customer Co" SALES_EXISTING_CONTACT_EMAIL=customer@dev.bos.test
exec node tools/manual-run/run.mjs --workflow sales --viewport 1440x900 --label "$1" --no-captions \
  --only sales-1,sales-2,sales-3,sales-4,sales-5,sales-6,sales-7,sales-8,sales-9
