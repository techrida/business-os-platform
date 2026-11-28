# Performance data

## Isolated perf company (Wave 2)

Use a **disposable local development/test database named `bos_perf` or `bos_perf_<suffix>`**, with the current application migrations applied. The tool refuses the regular `bos` database, remote hosts and production mode. It owns a separate tenant and its default legal entity (`PERF`), so even tenant-wide tables and the tamper-evident audit chain are separate from demo company data. Run it offline, with no API/worker traffic against that database. Do not point it at a shared test stack.

From the repository root, after installing workspace dependencies:

```bash
# Set BOS_PERF_DB_URL in your shell from the local secret store; use the disposable
# database's admin connection (creation/cleanup need the table owner and admin privileges).
export NODE_ENV=development
export BOS_PERF_STORAGE_ROOT="$PWD/.dev/perf-files"
export BOS_PERF_CLAMD_HOST=127.0.0.1
export BOS_PERF_CLAMD_PORT=3310
export NODE_OPTIONS=--conditions=bos-source

# Create company, staff memberships, three approver groups, 50 customers and reference data.
pnpm --filter @bos/api exec tsx test/perf-data/cli.ts create

# Load or resume the full data set. Start the local ClamAV scanner first.
pnpm --filter @bos/api exec tsx test/perf-data/cli.ts load

# Remove the perf tenant, its rows, audit chain and tenant-owned files. Safe to repeat.
pnpm --filter @bos/api exec tsx test/perf-data/cli.ts cleanup
```

`BOS_PERF_STORAGE_ROOT` must be the same file root the disposable API uses for `FILES_ROOT`, never a shared root: the first invocation binds it to the database and refuses to reuse it for another database. `BOS_PERF_DB_URL` is not stored or printed. The manifest defaults to `perf-manifest.json` in that storage root; optionally set `BOS_PERF_MANIFEST` to an absolute output path. It contains tenant/entity, staff/group, customer/portal and generated row IDs, not credentials. Keep it outside source control. A successful create or load replaces the manifest atomically; after cleanup it is a historical identifier list, not live data.

The offline generator works with database-only staff. For authenticated workloads, use the dedicated machine accounts described below.

| Data                   | Default volume / state                                                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Pending memo approvals | 2,500 active steps each for accountant, finance and founder (7,500 memos); later steps have real preceding recommendations                    |
| Leads                  | 5,000 new leads, owned by perf sales staff                                                                                                    |
| Activities             | 20,000 notes attached to those leads                                                                                                          |
| Tax invoices           | 10,000 issued invoices spread across 365 days; 200 per each of 50 customers                                                                   |
| Payments               | 5,000 submitted payments with individually uploaded and scanned synthetic proof PDFs                                                          |
| Vendor bills           | 5,000 draft non-purchase-order bills, with real scanned synthetic PDFs and line totals                                                        |
| Audit trail            | At least 100,000 hash-chained events; normal writes may exceed this target, any shortfall is filled by explicitly labelled seed sample events |

The tool uses audited SQL for bulk CRM and reference rows, and the actual application services for memo routing, recommendations, invoice approval and issue (including numbering, snapshots and ledger posting), payment submission and bill creation. It does not mark proof files clean directly: the document upload and ClamAV scan paths do that. The offline runner does not dispatch email or enqueue background delivery work. Invoice PDFs are not rendered by this data loader.

Run the same `load` command after interruption. Existing documents are resumed from their committed state or skipped, keyed by stable synthetic identifiers. The sizes and customer distribution are fixed for a full run; use cleanup before changing the distribution. A database advisory lock prevents two seed/cleanup commands running simultaneously. Cleanup validates the fixed company identity, checks for inbound references from outside the perf tenant, and deletes only tenant-scoped rows and its private audit chain in one database transaction. As the ordinary app intentionally forbids deleting issued documents and audit history, cleanup is an administrator-only teardown of a disposable database. It does not truncate tables, disable guards for other connections, or touch other companies.

Integration checks (small counts, a failed scan followed by resume, repeated generation, hash-chain verification, and scoped cleanup):

```bash
pnpm --filter @bos/api exec vitest run src/perf-data.test.ts
```

## Run the staff workloads

Select a dedicated disposable Compose project using `COMPOSE_PROJECT_NAME`, `COMPOSE_FILE` (base plus your local override) and `COMPOSE_PROFILES=core,app,files,tools`. Its API and worker must connect as the application role to the same migrated `bos_perf` database that the host loader administers. Bind `BOS_PERF_STORAGE_ROOT` to both services at `/var/lib/bos/files`. The ordinary Compose defaults point the application at the demo database. Start the project's core services, scanner and Gotenberg, and export its Caddy certificate as for the ordinary dev seed. Use separate loopback ports when another local stack is running.

With the database, storage and Node environment from the preceding section set, run from the repository root:

```bash
pnpm -r --workspace-concurrency=1 --filter @bos/seed-zitadel... build
docker compose run --rm -e NODE_ENV=test -e BOS_PERF_STAFF=1 seed-zitadel
export BOS_PERF_SUBJECTS="$PWD/.dev/perf-subjects.json"
export BOS_PERF_SCALE=small  # omit for the full fixture
pnpm --filter @bos/api exec tsx test/perf-data/cli.ts load
docker compose up -d --wait api worker

# Each scenario starts one iteration per second for 30 seconds.
export K6_PERF_DURATION=30s K6_PERF_RATE=1
bash perf/k6/run-company.sh sales approvals
```

The seed creates a dedicated staff organization in local ZITADEL. It puts client credentials in the existing private k6 environment file and writes the separate subject-ID mapping that the loader applies to perf memberships. Rebuild/recreate the API after changing its client allowlist. Each setup resolves the real account through `/v1/me` and checks its tenant, entity, role and application user ID against the manifest before using it.

The shared module is `perf/k6/lib/staff.js`. Import `staffToken(role)` during setup and `request(token, flow, method, path, body, expectedStatus, idempotencyKey?)` for tagged requests. `manifest` exposes P-3's record IDs. `lib/workload.js` supplies arrival rates, JSON commands, approval decisions and percentile settings.

Sales uses two concurrent scenarios. One creates a lead, contacts and qualifies it, logs an activity, drafts a quotation, approves it, waits for its PDF, records acceptance and confirms the order. The other drafts and approves an invoice, issues it and drafts both types of adjustment note. Approvals retains independently paced preview and write traffic alongside a two-person approval. Without overrides the runs last 60 seconds, with one arrival per second for each sales scenario and 10/5/2 for approval/preview/write.

The runner reports successful API requests from the server log (`responseTime`) with count, median, p95 and p99 in milliseconds. The action gate is p95 below 80 ms. k6 also reports client request time. For PDF generation, the final approval enqueues the render. The database report measures elapsed time from approval to clean scan, and k6 separately records when polling first sees the clean file. The polling interval is 250 ms. Browser page timings require a browser run.

After all selected scripts, including a failed gate, the runner stops the disposable API and worker and runs the scoped P-3 cleanup. Reload the fixture and start the services for the next run. Remove your isolated Compose project and its volumes after verification.

## Legacy database-read seed

`perf/seed/db-reads.sql` and `pnpm perf:seed-db-reads` are the original quotation/approval read benchmark fixture. They write to an existing demo entity and intentionally create artificial historical states. They are **not** part of the isolated Wave 2 data generator above; do not use them to populate the perf company without reviewing the seed's assumptions.

### Payment and report measurements

Set `BOS_PERF_WORKLOAD=money` when running the fixture loader to seed the money workload.
Full scale creates 10,000 issued invoices across a year and 5,000 payments. For the small
fixture set `BOS_PERF_SCALE=small` and run
`K6_PERF_DURATION=3s K6_PERF_RATE=1 bash perf/k6/run-company.sh money`.
Each payment iteration consumes a different seeded invoice. At full scale, the default
60-second run fits within the fixture.

An accountant uploads a proof, waits for its clean scan and records a payment. Finance
verifies the payment, allocates it in full and checks the invoice's paid status. The
concurrent report scenario reads the current month's sales VAT register and today's
receivables aging. The aging endpoint only supports an as-of-today report. The runner
reports server request times separately for each operation and uses the scan queue's
added and completed event timestamps to measure the background job. Report p95 under
800 ms is good and 1,800 ms is the failing threshold.

### Platform workload

Add `-e BOS_PERF_PLATFORM=1` to the disposable staff identity seed command above for
the platform workload. This provisions one customer and one vendor machine user in separate
organizations. The loader maps them to the first perf customer and the invited perf vendor.
Load the fixture offline, start the API and worker, then run `bash perf/k6/run-company.sh platform`.
Use the API with the paged inbox and summary routes (P-8).

The workload covers inbox list/count/summary, verification file reservation and byte upload,
scan status reads, access policy and workflow draft saves, filtered audit events, customer
invoices, a vendor quotation submission, and sidebar reads. Navigation search filters the
sidebar links in the browser and makes zero API requests. Measure its visible result in a browser.
The scan report joins each verification upload to its BullMQ added and completed events by
version ID. Times exclude polling delay. A missing completion fails the run.
