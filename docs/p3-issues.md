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
