# Phase 4 Issues and Consolidated Limitations

## P1→P2→P3 cascade integration (2026-11-12)

The lower-phase READY heads were carried into `p4-main` by a normal merge, then
verified on Linux (Ubuntu WSL, Node 24, pnpm) and on a fresh isolated stack.
Runtime details: [Linux runtime handoff](p4-linux-runtime.md). The older sections
below stay as history; where this section contradicts them, this section wins.

### Source chain

| Phase | READY head | What it brought                                                                                                                                       |
| ----- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1    | `731907f4` | Memo refinement                                                                                                                                       |
| P2    | `13fb0c1a` | Removes the P1-only amount/currency/upload/scan test controls from internal memos; keeps correspondence list, signers, PDF and print (via `b2d5ff02`) |
| P3    | `11166e20` | Includes P2 through `ee6b988a`; final P3 application source is `a7f9901f`                                                                             |

`p4-main` was `cb7e5990` before the merge. Merge commit `c7d0b533` is a normal,
ancestry-preserving merge of exactly `11166e20`. P3 added no migrations, so there
is no migration collision with P4's `0030`–`0038`. Sales/billing (P3) and
procurement (P4) source are both preserved.

### Conflict resolutions

- `apps/api/src/modules/approvals/requests.service.ts`: kept P4's `department_head`
  routing and `retarget()`, and kept P3/P2's explicit-route request handling
  (`routingSpecOf()` and `extraUserIds`). `activeUserIds` is undefined when nobody
  is named, which means no restriction; `departmentHeads` is still returned.
- `pnpm-workspace.yaml` catalog: kept `jsdom`/`@types/jsdom` (P4) together with
  `pdfkit`/`@types/pdfkit` (P3 memo PDF).

### Follow-up commits on `p4-main`

| Commit     | Change                                                                                                                                        | Why                                                                                                                                                                                                                                                                                       |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `220a6d19` | e2e imports `minimalPdf` from `e2e/helpers/pdf-fixture.ts`                                                                                    | P3 moved the helper                                                                                                                                                                                                                                                                       |
| `c844b71e` | Workspace new-invoice page test mocks `@/lib/api-tax-codes`                                                                                   | P4 moved `listTaxCodes`                                                                                                                                                                                                                                                                   |
| `fa2b3b64` | Memo routing tests assert P4's service-level approval authorization; signer role labels corrected (management/founder, not `operations_head`) | P4 `0ce3ad41` made approvals inbox/act `@AnyAuthenticated` so an assigned purchase-request department head can act. The service refuses instead: no act permission is NotFound; permitted but not the named step person is Forbidden; no assignment inbox is Forbidden                    |
| `997ec00e` | `next build` for the portal uses `apps/portal/tsconfig.build.json`, which excludes e2e                                                        | The portal Docker image failed to build (pre-existing in P4): portal e2e imports workspace e2e helpers whose dependencies are not in the filtered image install. Host typecheck still covers e2e. This is the only product-affecting change; it alters build configuration, not behaviour |
| `ed97c4b5` | e2e matches the memo signer option by its whole name                                                                                          | The P4 seed adds "Dev Management Two", which made the partial-name match ambiguous                                                                                                                                                                                                        |
| `a3aace62` | e2e `PERSONA_KEYS` is the eleven seeded personas (adds `depthead`, `management2`, `procurement`, `warehouse`)                                 | The persona list had drifted from what the P4 seed writes                                                                                                                                                                                                                                 |
| `764f2abf` | The CRM board e2e creates an opportunity before checking the board                                                                            | An empty stack shows "No opportunities yet", which is intended                                                                                                                                                                                                                            |

No product behaviour changed apart from the portal build configuration.

### Linux verification

| Check                                                                | Result                                                                                                                                                                    |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First gate batch at `c844b71e`                                       | Install, typecheck, lint, format, image pins, all builds, workspace and portal production dev-route exclusion, API HTTP e2e: pass. Package tests 2,936 pass / 2 fail      |
| The 2 failures                                                       | The memo routing tests, fixed by `fa2b3b64`                                                                                                                               |
| `fa2b3b64`: API `src/modules/test-memo` + `src/modules/approvals`    | 7 files, 241 tests pass                                                                                                                                                   |
| `997ec00e`: portal typecheck, build, no-dev-routes, prettier, eslint | Pass; portal Docker image builds and runs (health 200)                                                                                                                    |
| Fresh stack `bos-p4v`                                                | Production images `bos-p4v/api`, `workspace`, `portal` (`:dev`); migrations applied, `check-tenancy` ok, seed 73 changes. Seed warning: ZITADEL Actions webhook DeniedURL |

Final gate batch at 764f2abf: <PENDING>

The seed warning is the known one: ZITADEL refuses the Actions webhook URL, so
the ten-minute reconcile fallback stays in effect.

### Fresh-stack browser results (real ZITADEL password plus TOTP, trusted local CA)

| Run                                                                       | Result                                                                                                                                                      |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Staff, `dev` project, at `764f2abf`: personas, exit (memo), inbox, p2 crm | **18 passed, 5 skipped**                                                                                                                                    |
| Earlier staff run (p0-shell, p2 and p3 specs included)                    | 19 passed, 25 skipped, 5 failed. The five: memo signer ambiguity (2), persona list drift (1), CRM empty board (1), plus the p0-shell run needing `next dev` |
| Production project: `lcp` and `prod-no-switcher`                          | **3/3 passed**; the account switcher and other `/dev` paths return 404                                                                                      |
| Repo consumer suites on the fixtures below: staff `e2e/p4`                | 20 passed, 3 skipped                                                                                                                                        |
| Portal `e2e/p4`                                                           | 18 passed, 8 skipped                                                                                                                                        |
| Staff `p4-exit`                                                           | 1 passed, 2 skipped                                                                                                                                         |
| Portal `p4-exit`                                                          | 2 passed, 2 skipped                                                                                                                                         |

The four failures other than p0-shell were test-side and were fixed and rerun
to pass (`ed97c4b5`, `a3aace62`, `764f2abf`). The p0-shell spec needs `next dev`
with `BOS_E2E_NEXT_DEV=1` by design and was not run. Consumer suites had zero
failures.

**Fixture driver** (outside Git, in
`C:\Users\kuu\.codex\handoffs\business-os-p4-consolidation\r2\fx\`): 15 of 15
stages passed through the real UI with real ZITADEL password and TOTP personas,
real ClamAV and real Gotenberg:

1. Purchase request PR-2083/84-00001, department-head approval.
2. RFQ to VEND-DEV; the vendor submits a quote through the portal (NPR 1,20,000,
   VAT exempt); convert, fewer-quotes exception, recommend.
3. Commitment approvals by Accountant, Finance and Management (the route adds
   Management above NPR 100,000).
4. PO-2083/84-00001 issued; its PDF is clean.
5. Warehouse receipt confirms two serials; the PO becomes `fully_received`.
6. The vendor submits an order-linked invoice through the portal; the founder
   keys the bill from the submission; three-way matched.
7. Accountant, then Finance, approve the bill; Finance drafts a payment request
   and leaves it as a draft (no payout).
8. Chain B: PO-2083/84-00002 (NPR 50,000; Accountant and Finance) issued and
   unreceived; PR-2083/84-00003 department-approved with no RFQ;
   PR-2083/84-00004 with an open RFQ.

### Skipped or not run, and why

- Staff `p4-exit`: "three vendors are invited" and "completed Journey 11 remains
  connected". They need three approved vendors on the RFQ; only VEND-DEV was
  offered because `extra-vendors.sql` was not effective.
- Portal: "another approved vendor cannot open…", "vendor awaiting KYC…" and the
  four "vendor still in onboarding" blocks. They need a second or pending vendor
  portal user, and ZITADEL invite acceptance with TOTP enrolment is not
  automated.
- Portal foreign-id tests use a random UUID. They prove an unknown id is refused,
  not that another vendor's real id is refused.
- p0-shell: needs `next dev`; not run.
- The staff `e2e/p4` (3) and portal `e2e/p4` (8) skips are fixture-gated as above.
  A skip is not a pass.
- Native print dialog and screen-reader behaviour are untested.
- Hosted CI is blocked (below).

### Inherited runtime gaps found on the fresh stack

1. **Portal OIDC client missing from the seed.** The compose file says the seed
   creates it; it does not. On a fresh stack portal sign-in fails with
   "redirect_uri is missing in the client configuration". Worked around with the
   task-local `r2/portal-client.mjs` (run via `portal-client.sh`), which creates
   the separate public OIDC app `portal`, writes `.dev/zitadel-portal.env`,
   appends the client id to `OIDC_ALLOWED_AZP` and recreates api, worker and
   portal. **The root fix belongs in `tools/seed-zitadel` at the lowest affected
   phase (P2 introduced the portal service) and must cascade upward.** This task
   did not make it.
2. **Scratch cleaner loss.** The hourly WSL scratch cleaner deleted
   `/var/tmp/agents-bosqa-p4` on 2026-11-12 at 12:09Z, including
   `p4-before-upgrade.dump`, the run scripts, `progress-fixtures.json` and the P3
   loader. The old `bos-qa-p2-4` stack cannot start (its config was deleted on
   2026-11-11); its volumes remain, untouched. All runtimes now live under
   `~/bos-runtimes`, which the cleaner does not touch.
3. **`entity.address` demo setting.** P3 invoice issuing needs it; a fresh stack
   has none. `p4v-fx-sql.sh` adds a demo address as a system actor. The P4 seed
   already provides the Operations department (head `depthead`), cost centres
   GENERAL/OPERATIONS/ADMIN, VEND-DEV and the tax codes.

### Known design note

A `department_head` step stores the resolved head user. SLA reminders and the
inbox add `step.userId` to `extraUserIds` only for steps of kind `user`. If the
department head changes before a reroute, the former head drops out of the
active-approver check. This is pre-existing P4 behaviour, not introduced by the
cascade and not changed here.

### Hosted CI

GitHub's billing/spending limit blocks hosted runs (as recorded in
[p3-issues.md](p3-issues.md)): no job starts. Hosted CI is not certified by any
local result here.

## Linux follow-up — 2026-11-11 (historical evidence)

> **Superseded in part (2026-11-12).** The paths below under
> `/var/tmp/agents-bosqa-p4` (the pre-upgrade dump, configuration backup, loader
> and fixture progress) were deleted by the scratch cleaner, and the
> `bos-qa-p2-4` runtime cannot start. Treat those as lost, not as available
> backups. The statement that Docker image builds were not rerun is superseded
> by the portal/API/workspace image builds above. The counts below describe
> `2bca61d2`, not the `764f2abf` head.

P3 explicitly released the shared Ubuntu checkout and runtime to P4. The real
GitHub `p3-main` head `66c9efef04de9b975855bae4f410122180d2a809` was merged
with `7334b0b6`; P2 `c703bcb5` is included through P3. P3 invoice picker limits,
server/client credit boundary, portal not-found handling, allocation refusal
status codes and browser safeguards are preserved. Saved P4 picker fixes were
committed as `f5b5fe34`. `2bca61d2` reconciles the overlapping over-allocation
message; `b81553c3` and `c1acf04a` scope browser assertions to the application
alert rather than Next's route announcer. No scanner protection or assertion
was weakened.

All project execution in this follow-up used Ubuntu/WSL, Linux Node 24.22.2
and pnpm 11.28.11. The complete automated candidate `2bca61d2` passed:

| Check                                           | Result                                                                                              |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Frozen install, all eight typechecks, root lint | Passed, zero lint warnings                                                                          |
| Full formatting and image pins                  | Passed; 28 image references across nine files                                                       |
| Package tests                                   | **6,868 passed**, zero failed; 10 conditional locale skips                                          |
| Package breakdown                               | contracts 428; database 578; locale 18; seed 176; portal 525; workspace 2,024; money 208; API 2,911 |
| API HTTP tests                                  | **117/117 passed**, including P3 and P4 exit journeys                                               |
| All package builds                              | Passed                                                                                              |
| Real workspace and portal production exclusions | Both passed                                                                                         |
| Migration/tenancy                               | Existing database upgraded normally from ledger 26 to 35; tenancy check passed                      |

These Linux results supersede the historical Windows test failures below.
The infected-file, quarantine, oversized request and scanner socket cases all
pass in the supported Linux environment. A Windows-specific socket root cause
was not separately proven. Windows Node/tests/builds/services were stopped;
no host security setting was changed.

Real production-mode browser acceptance uses actual ZITADEL logins, trusted
local CA (`ignoreHTTPSErrors: false`), the existing PostgreSQL/Valkey runtime,
Gotenberg and ClamAV. The embedded preview returned a Chrome error page;
authorized Linux Playwright provided the acceptance evidence instead.

- 19 unique repository staff checks passed across staged runs: procurement,
  order detail and PDF, receiving validation, bills/payment-request entry,
  role refusals, RFQ sourcing, VAT validation/export and vendor management.
- 16 repository vendor checks passed: RFQ/quote entry, real PDF upload,
  validation, bill submission, bank-change masking, foreign-Origin refusals
  and onboarding visibility.
- Additional resumable private fixtures created a real purchase request,
  obtained independent department-head approval, submitted a vendor quote,
  converted it, used the supported fewer-quote exception, obtained separate
  Accountant/Finance/Management/Founder commitment approvals, issued the PO
  and downloaded its rendered/scanned PDF. Warehouse confirmed two serialized
  units and the vendor submitted a PO-linked invoice through the portal. The
  bill was entered from that submission, three-way matched, and independently
  approved by Accountant then Finance; the payable remains open for the demo.
  Final staff bill detail and vendor order/bill detail checks also passed.

This live scenario uses the one approved seeded vendor and a high-value
NPR 2,018,180 quotation. It does not claim the exact three-vendor NPR 120,000
browser Journey 11 fixture passed. Fixture-gated tests for a pending vendor,
a second vendor and the exact golden journey remain unrun/skipped. The HTTP
Journey 11 passes with its documented test doubles. P3 browser evidence is
inherited from the owning P3 handoff, not counted as a fresh P4 browser run.

Unanswered decisions retain the repository's recommended defaults, including
manual bill Account ID entry until a chart of accounts exists, and payment
requests authorizing a request only (no bank payout). No real payout occurred.
The issued-order table can squeeze long descriptions between numeric columns;
readability remains a UI follow-up. There is no complete accessibility or
all-role/all-route browser audit. Docker image build and secret-history scan
were not rerun for this P4 follow-up; package builds and live services were.

The existing runtime/data were deliberately reused after release, with a
protected pre-upgrade dump and configuration backup. Normal seed added missing
P4 personas and intentionally retired six obsolete receiver grants under D03;
all other prior grants were retained. ZITADEL refused automatic Actions webhook
registration with its URL denylist, so the existing ten-minute reconciliation
fallback remains. Newly seeded identities were mirrored by the normal seed.
See [Linux runtime handoff](p4-linux-runtime.md) for safe startup, backups,
fixture boundaries and exact protected configuration pointers.

## Status and features

Consolidated on `p4-main` on 2026-11-10 from `origin/p4/on-p3`
(`986d9210`), preserving Phase 3 sales and Phase 4 procurement. Inherited
phase records: [P0](p0-issues.md), [P1](p1-issues.md), [P2](p2-issues.md),
[P3](p3-issues.md). These are phase-specific evidence, not fresh P4 results.

- **Purchase requests:** draft/edit/submit, department-head and emergency
  approvals, named department and entity cost-centre selectors, optimistic
  version checks, cancellation and retained editable project references.
- **Sourcing:** RFQs (requests for quotations), vendor invitations, vendor
  quotations, comparison/selection and purchase-order creation.
- **Purchase orders and receipts:** versioned orders, approval/issue, PDF
  rendering, receipt entry/posting and controlled draft discard/cancellation.
- **Three-way matching and bills:** purchase order, received quantities and
  vendor bill are matched before posting; non-PO bills, tax and withholding,
  duplicate protection, draft discard, and re-opening a discarded portal
  conversion for editing/re-conversion are retained.
- **Payables:** vendor balances, payment requests and approvals, allocations,
  VAT (value-added tax) register/export and withholding-code selectors. This
  remains a receivables/payables subledger, not a general ledger.
- **Vendors and portal:** scoped vendor profiles, bank account/evidence flows,
  vendor access and bill submission, clean document links and permission/tenant
  boundaries. Cost-centre administration supports audited, idempotent creation,
  rename and deactivation under `admin.settings.write`.

## Integration record

| Source                                   | Source head | Result                                                         |
| ---------------------------------------- | ----------- | -------------------------------------------------------------- |
| `origin/p3-main`                         | `2ef5f086`  | Forward merge `867372c5`                                       |
| `origin/kuu/p4-approval-picker-followup` | `86e46a86`  | Already included in initial head                               |
| `cascade/c-p4fix`                        | `ffeb2e0d`  | Merge `0f6012cb`                                               |
| `cascade/c-p4`                           | `ac482267`  | Subsumed by `cascade/c-p4fix`                                  |
| `cascade/c-p4p3`                         | `98c55e6d`  | Merge `b3e3b0c8`; retained useful validation copy and ancestry |

Conflicts retain current instant development account switching and production
credential-marker checks, P0 shell plus P2/P3/P4 browser spec groups, named
departments, cost-centre catalogue/administration, and P3 invoice workflows.
The combined journal has 35 sequential indices and retains all historical SQL
unchanged. Memo and cost-centre migrations both use the historical `0037`
number/timestamp but distinct file names and SQL hashes. The transactional,
advisory-locked hash-aware runner applies both; timestamp-only Drizzle
migration logic must not replace it. Existing applied hashes remain intact;
unknown applied hashes are rejected. Fresh-database and real P3-upgrade tests
remain alongside older-phase backfill, rollback and idempotence coverage.

Integration follow-ups align form interaction fixtures with the new catalogue,
type audit query rows, and use the current database-backed audit dependency and
strict optional-field types. No unrelated UI redesign was applied. The later authorized Linux follow-up
performed the normal persistent migration described above. Only `p4-main` is this task's push destination;
`main`, legacy phase branches and full-phase PRs are unchanged by this task.

## Full-cascade limitations and open issues

### Original runtime and demo acceptance prerequisites (now provisioned above)

This checkout initially had no dependencies, `.env`, `.dev`, seeded identity
configuration or listening app runtime. Dependencies are installed here for
verification. A compiled build and passing tests do not prove an authenticated
demo: a dedicated P4 API, database, Valkey, identity service, proxy/trusted local
CA and seeded personas must be configured before staff/vendor portal browser
acceptance. Existing other-phase runtimes, credentials and data are preserved.
The P0 shell browser regression needs `next dev` and `BOS_E2E_NEXT_DEV=1`.

API HTTP exit tests use real app/database/queue paths but test identity tokens,
fake PDF rendering and fake antivirus scanning. They do not establish live
identity provisioning, production scanner/renderer behavior or interactive
customer/vendor login. The seeded money-model journey is bounded coverage,
not a proof of every financial command sequence. P3's HTTP journey has no
dedicated sales-order evidence-upload step.

### Product and accessibility follow-ups

The older cascade inventory identified raw IDs, lookup fallbacks and manual
reference entry across customers, quotation history, memos, verification,
inbox, quotations, opportunities, procurement and workflow administration.
Many paths now show names or explicit unavailable states. The inventory is
retained below as historical evidence, not an assertion that every old issue
still exists at its former line number. No complete browser audit establishing
"no raw IDs anywhere" has been performed.

Current confirmed gaps include purchase-request list/detail labels that say
Department/Cost centre/Project name unavailable, manual bill Account ID entry,
and optional manual project-reference entry. Named department/cost-centre
creation controls are present, replacing the old raw-ID controls. An empty
cost-centre catalogue disables saving with an explanation; an administrator
must configure a centre. Department lookup failure preserves editing existing
requests through a named unavailable option. Broad lookup-failure/browser
acceptance remains outstanding.

Carry the historical inventory for follow-up: customer fallback formatter;
quotation actor/status history; memo actors; verification document/reviewer;
inbox groups/people; quotation owner/revision; purchase-order vendors;
purchase-request department/cost centre/project; RFQ vendor/request/quotation/
tax-code fallbacks; bill vendor headers; workflow user options; RFQ document
entry, receipt filters and memo lookups. Use scoped names and existing API
payloads rather than removing actions to conceal references.

P1 memo screen-reader acceptance remains outstanding. Existing memos can have
null template snapshots, absent job titles are omitted, official logos are
not fabricated and signatures remain disabled. Incomplete staff identity sync
makes those people unavailable in memo pickers; service accounts are excluded.
The standalone icon-motion prototype remains outside the application and
still needs integration, dark theme, touch, drawer focus, notification-state
and collapse-control accessible-label checks. Recurring invoices and payment
method administration remain unbuilt navigation items. Disabled sidebar rows
use permitted "not available yet" copy. The opportunity-to-customer link is
an intentional navigation change inherited from the earlier copy cleanup.

### Verification boundaries and operational debt

- Production dev-exclusion tests use workspace-shaped fixtures, without a
  dedicated portal fixture or local Docker-image inspection. The actual app
  production outputs are checked separately. Sales-order evidence-label copy
  has no dedicated regression assertion in the historical cascade record.
- Windows P2/P3 tests recorded Defender removing harmless EICAR antivirus-test
  files and socket-limit failures (`ECONNRESET` rather than expected replies).
  Host protections must remain enabled. Fresh P4 results are recorded below;
  prior failures are not silently treated as passes or as a definitive root
  cause for a new failure.
- Repository formatting debt includes `apps/workspace/src/dev/accounts.server.ts`,
  `design/memos/deliverable.html`, `previews/p1-icon-motion/deliverable.html`,
  its `README.md`, and the historical `CASCADE-LIMITATIONS-AND-ISSUES.md`.
  Keep unrelated formatting out of consolidation commits.
- CI (continuous integration) push filters include `main` and `p*/**`, which
  does not include `p4-main`. A branch push does not establish hosted CI success.
- Vitest/Vite configuration compatibility, pg query-concurrency deprecation
  and EventEmitter listener-count warnings remain visible.
- No independent re-review of the final cascade fixes is claimed; review in
  this task is self-review. Docker production image builds, full-history
  secret scans and authenticated browser acceptance are not claimed here.
- Historical Linux worktrees may hold unique dirty/unpushed work. Do not prune
  them based on this consolidation. The earlier daily retirement script was
  written but not installed; deletion remains a separate approved workflow.
  The old handoff also exists in life-kb at
  `Techrida/projects/business-os/docs/platform/cascade/PHASE-CHAIN-HANDOFF-2026-11-10.md`;
  its current contents and installation state were not reverified here.

### Corrections to historical notes

The historical report's statement that instant passwordless switching is not
built is superseded: it is present in this branch for seeded and manually
created development users, with disabled-user rejection, origin protections
and production exclusion. The historical stale-chain warning is superseded
for the specifically integrated `p1-main` through `p4-main` source heads; it
does not certify every legacy phase branch or another machine's runtime.
Docker access is available on this Windows machine; the old build machine's
socket-permission failure is historical. No Tailscale, cleanup or deployment
work is performed here.

## Historical Windows consolidation verification — superseded by Linux follow-up

Environment: Windows, Node 24.18.0, pnpm 11.28.11, Docker Engine 29.8.2.
Application source candidate: `bf47262f`. Later documentation changes do not
change runtime behavior. Verification uses the shared heavy-job queue for
install, broad suites, typechecks, lint and builds; named diagnostic tests
exercise affected files directly.

| Check                                                            | Result                                                                                                              |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Frozen-lockfile install                                          | Passed; no lockfile change; optional protobufjs install script remains blocked                                      |
| Recursive typecheck                                              | Passed for all eight packages; final named test edits also typechecked                                              |
| Root ESLint, zero warnings                                       | Passed; later modified files pass focused lint                                                                      |
| Contracts / database / locale tests                              | 428 / 578 / 18 passed; locale has 10 conditional skips                                                              |
| Seed / portal / workspace / money-rule tests                     | 176 / 525 / 2,022 / 208 passed                                                                                      |
| Broad API package tests                                          | 2,896 passed, six failed; cost-centre suite initially failed setup with seven tests skipped, subsequently corrected |
| Final affected API reruns                                        | Cost-centre integration seven passed; cost-centre caller and bill submission tests 18 passed                        |
| API HTTP end-to-end suite after loader fix                       | 116 passed, one failed (EICAR fixture); all 21 BFF contract cases pass                                              |
| Workspace and portal production builds                           | Both passed, including dependency builds                                                                            |
| Production dev route/credential exclusion                        | Both real app outputs passed                                                                                        |
| Image reference pins                                             | Passed: 28 references across nine files                                                                             |
| Historical SQL / journal review                                  | All source SQL and timestamps unchanged; 35 unique tags, contiguous indices                                         |
| Scoped formatting / diff whitespace                              | Passed for consolidation edits                                                                                      |
| Repository-wide formatting                                       | Fails on five inherited files listed above; unrelated formatting preserved                                          |
| Authenticated browser / Docker image build / secret-history scan | Not run locally                                                                                                     |

The broad package run recorded **6,851 passed, six failed and 17 skipped**;
seven skips belong to the cost-centre setup failure, which is resolved by the
final seven-test rerun. Do not describe this as a single clean full-suite run.
The other ten skips are conditional locale cases. No passing totals include
repeated diagnostic tests twice.

The final API HTTP suite passes the P3 quote-to-cash and P4 procurement exit
journeys, vendor/receiving/payables routes, the money-model journey and all
BFF client contracts. It uses test doubles described above, not live browser
acceptance. The initial run's two ApiError-identity failures were a Windows
module-loading race in the test harness. Loading the shared API module before
the clients resolves them without changing production code or weakening the
instance checks. The complete HTTP suite was rerun after that fix.

Remaining failed cases:

- `documents.integration.test.ts`: two infected-upload EICAR cases return
  HTTP 500 instead of successful upload; oversized Content-Length receives
  `ECONNRESET` instead of observable HTTP 413.
- `documents.generated.integration.test.ts`: infected generated file cannot be
  read from quarantine during type detection.
- `clamd.client.test.ts`: two size-limit reply assertions see `read ECONNRESET`
  and a transient flag instead of the scanner's definite size-limit response.
- `approvals.e2e.test.ts`: EICAR upload returns HTTP 500 before the fake scanner
  handles it; the other 116 HTTP tests pass.

Fresh Defender detections (threat ID 2147519003, successful remediation) name
this run's `bos-docs-it-*`, `bos-docs-generated-*`, `bos-scan-test-*` and
`bos-e2e-files-*` quarantine fixtures. The document/scanner source and tests
are unchanged from initial P4 head `986d9210`. Socket behavior matches the
inherited P2/P3 report, but Linux parity and a definitive socket root cause
remain unverified. No antivirus protection or test assertion was weakened.

Commands: `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`,
`pnpm --workspace-concurrency=1 -r --no-bail --if-present run test --maxWorkers=2`,
`pnpm --filter @bos/api test:e2e --maxWorkers=2`,
`pnpm --filter @bos/workspace... build`, `pnpm --filter @bos/portal... build`,
`node apps/workspace/scripts/check-no-dev-routes.mjs` and the same checker
with `apps/portal/.next`. No dev server uses this checkout's build directories.

The checkout, installed dependencies and production build outputs remain
available for follow-up. No application server, configured demo environment,
deployment or runtime migration is claimed. Provision a dedicated P4 runtime
before starting authenticated staff/vendor demos; do not reuse another phase's
database or credentials.

## Original consolidated limitations (historical snapshot)

The following source is incorporated verbatim from
[CASCADE-LIMITATIONS-AND-ISSUES.md](../CASCADE-LIMITATIONS-AND-ISSUES.md).
Its branch names, pending features and test statements describe the earlier
snapshot; the corrections and fresh results above take precedence.

# Phase chain: limitations and open issues (2026-11-10)

Consolidated for whoever continues (possibly on another machine). Detail for P4 screens: `CASCADE-P4-OPEN-ISSUES.md`. Guide: `CASCADE-P0-UI-CHANGES.md`. Written at `p4/on-p3` 86e46a86.

## Branch state

- Origin has `main` and one branch per phase: p0/ground-floor, p1/platform-kernel, p2/crm-quotations, p3/sales-invoicing, p4/on-p3. `p4/procurement` was merged into `p4/on-p3` and deleted.
- Merges were real merges, ordinary fast-forward pushes, no force, no PRs, nothing merged to main.
- **The chain is not current.** Other sessions kept pushing: P0 gained 939a6d2a (Tailscale removal, not part of the UI cascade), P1 gained about 7 newer commits. P0 is not in P1 and P1 is not in P2 until the forward merge P0â†’P1â†’P2â†’P3â†’P4 is repeated (one fresh worktree per phase, merge previous phase, check, refetch, fast-forward push). Do this when other sessions have stopped pushing.

## Not verified (never run)

- Browser, render and hydration checks: nobody has seen the UI.
- Docker-backed API and database integration suites (4 API suites on P4 failed to start: Docker socket permission denied on the build machine).
- Docker image builds and the Docker-image exclusion gate.
- End-to-end and live-stack login tests.
- Full test suites on every phase (only typecheck, lint, Prettier, focused and package tests, production builds and the dev-exclusion checker were run).
- The last cascade fix commits on P4 had no separate re-review.

## Known limitations of the checks

- The production dev-exclusion checker uses workspace-shaped fixtures; the portal has no dedicated fixture and no Docker-image inspection. It was run against real workspace and portal production builds.
- Sales-order evidence-label change (`sales-orders/[id]/page.tsx`) has no regression assertion.
- Vitest prints a configuration compatibility warning.

## Product gaps

- Raw IDs and lookup fallbacks remain as visible text in older P1/P2/P4 screens (customers, workflows, inbox, memos, quotations, verification, opportunities, procurement). The "no raw IDs anywhere in product UI" criterion is not met. Fix by carrying names in loaded data or adding a lookup; never disable an action only to hide an ID. Full list in `CASCADE-P4-OPEN-ISSUES.md`.
- The instant passwordless account switcher (Q29) is not built and needs Kuu's decision first. Do not add it as part of the cascade.

## Machine / process notes

- Other sessions' uncommitted or unpushed work exists in local worktrees (`kuu-cascade-ui-p2`, `-p3`, `-p4-on-p3`, `kuu-p1-icon-motion`). Do not delete them blindly; push or discard first.
- Daily session-retire prune (Linux) is written but not installed; its dry run found 0 eligible worktrees (blocked by dirty trees and processes it could not inspect). Chat deletion stays manual and approved.
- Handoff notes with the same content live in life-kb: Techrida/projects/business-os/docs/platform/cascade/PHASE-CHAIN-HANDOFF-2026-11-10.md.
