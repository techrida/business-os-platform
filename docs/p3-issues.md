# Phase 3 Issues and Notes

## Status and features

Consolidated on `p3-main` on 2026-11-10, starting from
`origin/p3/sales-invoicing` at `ea7aa5c6`. Inherited records are
[p0-issues.md](p0-issues.md), [p1-issues.md](p1-issues.md) and
[p2-issues.md](p2-issues.md).

- **Sales orders:** confirmation from accepted quotations, copied lines and
  payment schedules, entity-scoped reads, evidence-policy checks and controlled
  transitions of schedule lines to billable. Staff workspace screens are included.
- **Invoicing:** manual and schedule-based drafts, server pricing, tax and
  currency snapshots, approval, issue, proformas, generated PDF documents and
  staff list/detail/action screens. Finance can submit and discard drafts using
  its existing grants; the cascade adds explicit regression coverage.
- **Payments:** staff and customer submissions with clean payment proofs,
  independent verification, rejection/withdrawal, reversal, frozen exchange-rate
  snapshots and receipt numbering. Verification opens a credit; allocation is
  what settles an invoice. A submitter cannot verify their own payment.
- **Receivables:** allocation and deallocation, statements, aging and customer
  advances. Open balances and paid status are derived from ledger allocations.
- **Ledger invariants:** append-only open items, allocations and posting events;
  one item/event per source; scoped party/currency matching; allocation caps and
  lock ordering; reversals recorded as new entries. This is a receivables/payables
  subledger, not a general ledger or chart of accounts. Proformas and drafts do
  not create receivable balances.
- **Credit/debit notes:** corrections of issued invoices through controlled
  drafting, approval and issue, including credit caps and original-line links.
  Issued invoices have no void route; corrections use notes.
- **Customer portal:** scoped invoice lists, invoice views, settlement and clean
  PDF links; payment submission, payment lists and proof upload/scanning. Portal
  identity and entity boundaries remain enforced by the API.

## Integration record

| Source           | Source head | Integration commit |
| ---------------- | ----------- | ------------------ |
| `origin/p2-main` | `6f79a26a`  | `f15672bc`         |
| `cascade/c-p3`   | `79a4be01`  | `76ec9eb2`         |

The P2 merge combines frozen memo paper and selected signer names with P3's
existing people/group name resolution in the approval inbox. The development
browser project includes the P0 shell regression and both P2/P3 spec groups,
without a duplicate shell entry. The migration journal retains P3 migrations
`0019` through `0024` and appends `0037_internal_memos`; existing SQL is unchanged.
The hash-aware runner preserves applied migration history and rejects unknown
applied hashes.

The P3 cascade's obsolete login-link and incomplete developer-menu variants were
resolved in favor of the newer instant account switcher. Production checks still
cover developer-menu and credential markers, including P3 billing output. P3
navigation and read permissions remain intact. The exit test now drives bounded
render-sweeper passes while awaiting its invoice PDF, so earlier shared-database
backlog does not leave it waiting for an unrelated timer.

Fetched origin and inspected local/remote refs and active sessions before
editing. The only other P3 tip in the preceding 12 hours was
`origin/p3/sales-invoicing`, already the starting head. Older P3 feature branches
were not blindly remerged. This assignment owns `p3-main`; higher-phase
consolidation remains with its owner. No full-phase PR was merged or created.

## Known limitations and deferred verification

- No `.env`, `.dev`, seeded identity configuration or application server was
  present in this Windows checkout. Installed dependencies are retained, but
  authenticated workspace/portal demo flows require an isolated P3 runtime.
  Existing runtime configuration, containers and seeded data were not changed.
- Browser acceptance needs the real identity provider, trusted local CA, API,
  database and seeded personas. P0 shell browser tests additionally require
  `next dev` and `BOS_E2E_NEXT_DEV=1`. No authenticated browser acceptance is
  claimed for this consolidation.
- The P3 HTTP exit journey uses the real app, worker, database and queue but a
  test identity issuer, fake PDF renderer and fake virus scanner. Portal login
  and milestone evidence are seeded directly; render sweepers are driven
  explicitly. It does not prove live identity provisioning, real scanner/renderer
  integration or interactive customer login. There is no dedicated sales-order
  evidence-upload route in that journey.
- The 200-step seeded money-model test exercises valid and refused commands
  and checks balances after every step. Its payment proofs are seeded clean;
  upload/scanning is exercised separately by the exit journey. A passing model
  is bounded test evidence, not an exhaustive proof of every financial workflow.
- Carry memo migration `0037` with the complete P3 source and hash-aware runner;
  do not alter existing SQL or run lower-phase source against a higher-phase
  database. This task does not apply migrations to a persistent runtime.
- Recurring invoices and payment-method administration remain unbuilt navigation
  items. See inherited notes for memo screen-reader acceptance and the standalone
  icon-motion prototype.
- CI push filters cover `main` and `p*/**`; `p3-main` does not match that phase
  filter. A successful push alone does not establish hosted CI success.
- Windows Defender removed harmless EICAR antivirus fixtures from this run's
  `bos-docs-it-*`, `bos-docs-generated-*` and `bos-e2e-files-*` temporary quarantine directories;
  fresh threat detections show successful remediation (threat ID `2147519003`).
  The HTTP suite's sole failure is `approvals.e2e.test.ts`: its EICAR upload
  receives HTTP 500 instead of 200 before the fake scanner can process it.
  Host protections were not disabled or excluded to make tests pass.
- The inherited document implementation, scanner client and relevant tests are
  unchanged from initial P3 head `ea7aa5c6`. Six package-test failures reproduce:
  three EICAR cases (two in `documents.integration.test.ts`, one in
  `documents.generated.integration.test.ts`) and three socket-limit cases.
  `clamd.client.test.ts` receives `read ECONNRESET` instead of a definite
  size-limit reply (two assertions fail), while the oversized Content-Length
  upload test receives `ECONNRESET` instead of observable HTTP 413. The same
  failures are recorded in P2. Linux parity and a definitive socket root cause
  remain unverified; these results do not establish a clean overall test gate.
- Repository-wide Prettier fails on four inherited files:
  `apps/workspace/src/dev/accounts.server.ts`, `design/memos/deliverable.html`,
  `previews/p1-icon-motion/deliverable.html` and its `README.md`. Scoped
  merge-resolution formatting passes. No unrelated formatting was applied.
- Tests emit pg concurrent-query deprecation, Vite config-loader and
  EventEmitter-listener warnings; these were not suppressed.

## Consolidation verification

Environment: Windows, Node `24.18.0`, pnpm `11.28.11`, Docker Engine `29.8.2`.
Application source candidate: `76ec9eb2`; the issues-document commit changes no
application code. Inherited results are not counted as fresh verification.

| Check                                                       | Result                                  |
| ----------------------------------------------------------- | --------------------------------------- |
| Frozen-lockfile dependency installation                     | Passed                                  |
| Recursive typecheck                                         | Passed, all eight packages              |
| Root ESLint with zero warnings                              | Passed                                  |
| Merge-resolution formatting                                 | Passed                                  |
| Container image pin check                                   | Passed, 28 references                   |
| All package tests                                           | 4,850 passed, 6 failed, 10 skipped      |
| API HTTP end-to-end tests                                   | 106 passed, 1 failed (EICAR fixture)    |
| Workspace/portal production builds and dev exclusion checks | Passed for both apps                    |
| Authenticated browser workflows                             | Not run: no configured identity/runtime |

Heavy checks run through the machine-wide shared queue. Package tests use
`pnpm --workspace-concurrency=1 -r --no-bail --if-present run test --maxWorkers=2`.
Package totals: contracts 337 passed; database 433 passed; locale 18 passed and
10 skipped; seed tooling 141 passed; portal 281 passed; workspace 1,291 passed;
money rules 171 passed; API 2,178 passed and 6 failed.

The separate HTTP suite (`pnpm --filter @bos/api test:e2e`) passes both the P3
quote-to-cash exit journey and the 200-step money-model test, plus the BFF
(backend for frontend) client contract checks. Its only failed file is the
approval EICAR negative case described above. Production builds use
`pnpm --filter @bos/workspace... build` and
`pnpm --filter @bos/portal... build`, followed by
`node apps/workspace/scripts/check-no-dev-routes.mjs` and the same checker with
`apps/portal/.next`. No `next dev` process used either build directory.

Self-review confirmed both source heads are ancestors of the candidate, all
26 journal entries have SQL files and sequential unique indices, P3's prior
journal entries and migration SQL remain unchanged, and the final integration
diff has no whitespace errors. Docker image builds, full-history secret scans
and authenticated browser workflows were not run locally.

The checkout and dependencies stay available for follow-up work; no application
server is claimed to be running.
