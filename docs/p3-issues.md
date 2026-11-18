# Phase 3 Issues and Notes

## Status and features

Consolidated on `p3-main` on 2026-11-10 and verified on Linux on 2026-11-11,
starting from
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

## Linux integration and fixes (2026-11-11)

P2 explicitly released the shared ext4 checkout and runtime before this work.
Merged real remote `github/p2-main` at
`c703bcb50a7ec0545bf6f0150fadb29fd3161afa` into `p3-main` with
`b7775b18`. This includes `b48db344` (Linux policy, format and browser fixes,
CI phase filters) and `c703bcb5` (API Docker money-rules packaging).
The real remote in this clone is `github`; `origin` is a local Windows mirror.

The original ancestry-preserving integrations remain: P2 `6f79a26a` through
`f15672bc`, and `cascade/c-p3` `79a4be01` through `76ec9eb2`.
A fresh remote inspection found no additional recent unmerged P3 branch;
the local cascade tip `4a7f0447` is already an ancestor. No published history
was rewritten and no full-phase PR was merged.

Real production-mode browser acceptance exposed and fixed four integration
problems that isolated component/service tests did not establish:

1. **Manual invoice customer picker:** requested 200 customers while the API
   allows at most 100, leaving the form without a usable customer. Commit
   `53227f89` uses 100; a regression validates the page query against the
   actual API query schema.
2. **Issued invoice credit-note actions:** the server component called
   `creditSource` exported by a client component, crashing Finance's issued
   invoice page. Commit `a8959105` projects the serializable line data on
   the server; a boundary regression rejects calls into that client helper.
3. **Portal invoice-linked payment absence:** invalid, unknown, draft and
   foreign invoice references reached a generic framework 404. Commit
   `94a11254` gives that route the same safe invoice-not-found boundary and
   exercises all four cases through the real portal.
4. **Ledger errors at the HTTP boundary:** allocation caps correctly refused
   the command, but the response filter discarded `OVER_ALLOCATION` (409)
   and `MISMATCHED_ITEMS` (422). The screen consequently reported a stale
   payment. Commit `e48c13a5` preserves these narrowly allowed codes only at
   their domain status; the workspace handles mismatch at 422. Regressions
   use real `LedgerError` instances, validate the shared response schema
   and reject wrong-status code claims.

The staff browser checks now use precise error/panel locators instead of
matching Next's hidden route announcer or a nested scroll region. Previously
deferred coverage is implemented for Sales receivables denial, over-allocation,
reasoned allocation reversal and payment self-verification refusal. Financial
write tests require explicit disposable fixture identifiers rather than choosing
an arbitrary existing payment.

## P2 READY integration (2026-11-12)

P2 released `p2-main` at `13fb0c1a8000fc5d727cee7f63a88dce4ba8b2cf` (verified
remote head). It carries P1 release `731907f4` through P2's merge `b2d5ff02`
and P2's removal of the P1-only money, currency, upload and attach test
controls from internal memos. Template memos now route to their named signers
as explicit user steps with no amount rules. No migration or journal change.
P1 was not merged directly into P3.

Merged with a normal merge as `ee6b988a`. The only conflict was
`memos/page.tsx`, resolved to P2's version (scoped memo list and status filter).
The approval engine changes (`explicitSteps`, `activeUserIds` undefined unless a
user is named, named-user loading in SLA) were checked against P3 callers:
invoice and credit/debit-note approvals use role steps and pass no
`explicitSteps`, so their routing is unchanged; the suites below confirm it.

Follow-up commits found by running the gates:

1. `d8798d58`, `6ada221e`: P2 removed `minimalPdf` from the memo e2e helper;
   the P3 payment specs still upload a PDF proof. It now lives in
   `e2e/helpers/pdf-fixture.ts`.
2. `f06ea428`, `eb6b48ae`: the manual-invoice picker regression (from
   `53227f89`) imported the API's customer query schema from `apps/api` source.
   The workspace production image installs only workspace dependencies and
   type-checks tests during `next build`, so the image failed to build. The
   page-size limit is now `CUSTOMER_LIST_MAX_LIMIT` in `@bos/contracts`, used by
   both the API schema and the invoice page. This affected only image builds,
   not host builds.
3. `dea5b5a8`: P3's `ae6a61cc` shows historical `test_memos.*` audit actions as
   "Memo ..." but the memo exit spec still expected "Test memos insert". The
   drift surfaced when the memo journey first ran against P3.
4. `ed601763`: the aging and payments list checks matched Next's empty route
   announcer (also `role=alert`) when a list was empty.

### Linux verification at the final application source

All execution ran in Ubuntu WSL with Linux Node 24 and pnpm through the host
resource queue. Results at `ee6b988a` unless noted; the later commits change
only tests, a shared constant and formatting, and the affected gates were rerun.

| Check                                              | Result                                                                                  |
| -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Frozen-lockfile install                            | Passed                                                                                  |
| Recursive typecheck, root ESLint (zero warnings)   | Passed at `eb6b48ae` (failed at `ee6b988a`, fixed)                                      |
| Full repository formatting                         | Passed at `eb6b48ae`                                                                    |
| Pinned container image check                       | Passed                                                                                  |
| Complete package suites                            | 4,947 passed, 10 existing locale skips                                                  |
| API package (includes invoice approval tests)      | 2,213 passed                                                                            |
| API HTTP suite (includes `p3-exit`, `p3-model`)    | 107 passed (8 files)                                                                    |
| Workspace unit suite                               | 1,349 passed at `d8798d58`                                                              |
| All-package production builds                      | Passed at `d8798d58`                                                                    |
| Production dev-route exclusion, workspace + portal | Passed                                                                                  |
| After the contracts change (`f06ea428`)            | invoices/new 31, API customers 59, contracts 341 passed; API and workspace images built |

Browser checks ran against production images on a fresh isolated stack
(`bos-p3v`, see [p3-linux-runtime.md](p3-linux-runtime.md)) with real ZITADEL
password and TOTP sign-ins, ClamAV, Gotenberg, API and worker:

- Persona sign-in and sign-out for all seven personas, and expired-login
  recovery: passed. The two development switcher tests skip on production
  images by design.
- Production checks (`/dev/personas` and other `/dev` paths 404, LCP): 3 passed.
- Memo exit journey after P2's change (named signers, two approvals, emails,
  audit timeline) and the inbox spec: passed.
- P3 fixtures were created through the real UI only: a customer, a manual NPR
  tax invoice drafted and submitted by Founder, approved by Accountant then
  Finance, issued as `INV-2083/84-00001` with a clean rendered PDF; an NPR 500.00
  payment recorded by Accountant with a scanned PDF proof and verified by
  Finance as `RCPT-2083/84-00001`.
- With those records, the full staff P3 browser suite and inbox passed 16 of 16:
  invoice list, detail totals and note buttons, manual form validation, record
  payment with proof, payment list and unknown-payment words, self-verification
  refusal, allocate panel, over-allocation refusal, allocate then deallocate
  with a reasoned reversal row, aging and statement, unknown customer, and
  Sales receivables denial.

Fresh-stack prerequisites added for this run, both through audited system-actor
transactions in the isolated database only: a "General" department (memos need
one) and a clearly labelled demo `entity.address` (issuing needs a seller
address; P2 used the same demo value). Without the address, Issue returns 422
"The issuing entity has no address set", but the workspace shows the generic
"The platform did not accept this. Check what you entered" message. That
wording is misleading for a configuration gap and is recorded as a follow-up.

Not run this round: the customer portal browser suite (a fresh seed has no
portal OIDC client env or customer master for the seeded portal party, and no
portal image was built), screen reader, physical print, and hosted CI. The
earlier portal browser evidence (5 passed, 2026-11-11) predates this merge.

### Hosted CI and secret scan

Hosted CI did not run for `fc2cdbf1`: every job stopped before its first step
with GitHub's "recent account payments have failed or your spending limit needs
to be increased" annotation. This is an account billing block, not a test result.
The previous P3 run (`66c9efef`, 2026-11-11) had two real failures. The docker job
failed on the workspace image's import of API source, fixed by `f06ea428` and
confirmed by the local image build. The secrets job found one gitleaks match: a
made-up example UUID assigned to `KEY` in the portal payment-form test
(`2beaa749`). `a7f9901f` allowlists only that literal. Locally, gitleaks 8.30.1
(the CI-pinned build, checksum-verified) scanned the full history with the repo
config: no leaks. Typecheck also passed again at `fc2cdbf1`.

### Runtime loss

The scheduled WSL scratch cleaner removed `/var/tmp/agents-bosqa-p3` (startup
scripts, loaders, fixture inputs and the `p3-before-upgrade.dump` backup;
confirmed absent on 2026-11-12) and P2's runtime folders. The `bos-qa-p2-4`
database is no longer usable for P3. P3 now uses its own `bos-p3v` stack under
`~/private-runtimes`; the 2026-11-11 runtime notes below are historical.

## Decisions and retained limits

Kuu authorized the recommended existing defaults for unanswered blocking
choices. Retained the subledger design, prorated VAT with final-slice
reconciliation, zero-rate demo withholding pending accountant signoff,
distinct Accountant then Finance approval, permission-gated Finance draft
actions, evidence requirements and customer portal visibility. These defaults
are documented assumptions; local acceptance does not certify accounting policy
or execute a payout.

Recurring invoices and payment-method administration remain unbuilt navigation
items. The inherited standalone icon-motion prototype and memo screen-reader
acceptance are outside this P3 financial verification. Locale's ten existing
translation-related skips remain reported.

The HTTP exit journey uses a test identity issuer, fake renderer and fake scanner;
the 200-step money model is bounded randomized evidence, not an exhaustive proof.
The additional real browser journeys use ZITADEL, trusted local TLS, ClamAV,
Gotenberg, API, worker and persistent database. Dedicated sales-order evidence
upload and full interactive credit/debit-note lifecycles were not separately
repeated in the browser; their API/integration coverage passes.

## Linux verification

All project tools execute under Ubuntu WSL on ext4:
Linux `6.18.33.2-microsoft-standard-WSL2`, native Node `24.22.2`,
pnpm `11.28.11`. Heavy jobs use the shared resource queue with WSL payloads.

The complete package baseline at `54a6edf5` passed **4,856 tests**, with
**10 existing locale skips**. API was **2,184/2,184**. API HTTP was
**107/107** across eight files, including quote-to-cash and the 200-step money
model. After browser-driven fixes, all affected suites and production builds
were rerun. Final application/test source is `22efe257`; final results are listed below.

| Check                                     | Result                                                            |
| ----------------------------------------- | ----------------------------------------------------------------- |
| Frozen-lockfile install                   | Passed                                                            |
| Recursive typecheck                       | Passed, all eight packages                                        |
| Root ESLint, zero warnings                | Passed                                                            |
| Full repository formatting                | Passed                                                            |
| Pinned container image check              | Passed, 28 references                                             |
| Complete package baseline                 | 4,856 passed, 10 existing locale skips                            |
| Final affected API package suite          | 2,186 passed                                                      |
| Final API HTTP suite                      | 107 passed                                                        |
| Final workspace unit suite                | 1,293 passed                                                      |
| Portal unit suite after route fix         | 281 passed                                                        |
| All-package production builds             | Passed; affected API/workspace/portal outputs rebuilt after fixes |
| Production dev-route/credential exclusion | Passed for both apps                                              |
| Staff P3 browser suite                    | 15 passed across staged runs; no P3 fixmes remain                 |
| Customer portal P3 browser suite          | 5 passed, real customer sign-in and proof submission              |

The earlier Windows record is superseded for acceptance. Its six package and
one HTTP failures all pass unchanged on Linux; no scanner rewrite, antivirus
exception or weakened size/security check was introduced. P2 also cleared the
inherited formatting debt and enabled CI push filters for `p[1-4]-main`.

Warnings from pg concurrent queries, the Vite config loader and listener-count
checks remain visible. Hosted CI is checked separately from local results;
a successful push alone is not a hosted CI or deployment claim.

## Persistent runtime and handoff

See [p3-linux-runtime.md](p3-linux-runtime.md) for exact safe startup, fixture
and credential-file references. P3 reused `bos-qa-p2-4`; the incompatible legacy
`bos` database and its original volumes remain preserved and stopped.
The compatible database advanced from migration ledger 20 to 26 using existing
SQL only; previous hashes were retained and tenancy checks passed. Protected
pre-P3 backup: `/var/tmp/agents-bosqa-p3/p3-before-upgrade.dump`.
No migration SQL, applied hash or historical ledger row was rewritten.

Seed preparation preserved every pre-existing grant, identity, membership and
financial record. It added P3 grants/workflows and minimal customer master data.
New invoices were drafted, approved by distinct Accountant/Finance users, issued,
rendered and scanned through actual application commands. Payment proof uploads,
verification and allocation/reversal likewise use application commands.
These local demo records are retained; acceptance is intentionally consumable.

The local API allowlist now includes the specifically registered portal client,
in addition to the workspace client. This fixes portal callback 401 without
relaxing token verification. Protected credentials and browser storage remain
outside Git. T3 preview rejected the local CA with
`ERR_CERT_AUTHORITY_INVALID`; the authorized Linux Playwright fallback
validates the explicit CA and keeps `ignoreHTTPSErrors: false`.

P4 owns the next integration and final higher-phase browser checks only after
explicit P3 release. Application processes must be stopped before P4 changes
source; core services, volumes, backups and private startup scripts remain
available. Keep a foreground WSL session alive while using the shared runtime.

## P3 study issues and decisions

## Resolved

- D15: Sales means sales orders with a billing schedule. Planning question Q28 is closed by this scope answer plus retirement of its obsolete schedule question D16. Verify the existing behavior rather than rebuilding it.
- D18 inherited: a signed quote is the default Won evidence; verify the same evidence policy at sales-order confirmation.

## Clarify at P3, not during P0

- D19: P3-BUILD-PLAN A5 specifies Accountant → Finance for invoice, credit-note and debit-note approval; empty routes refuse submission. A3's money comparison rule does not itself add Management/Founder steps to invoices. Explain the distinction from purchase commitments and matched/non-PO payment routes. Kuu asked whether the plan already covers this; no choice or threshold change was confirmed.
