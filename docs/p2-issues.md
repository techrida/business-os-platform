# Phase 2 Issues and Notes

## Status and features

Consolidated on `p2-main` on 2026-11-10, starting from
`origin/p2/crm-quotations` at `59f48faf`. The Phase 0 and Phase 1 records remain
in [p0-issues.md](p0-issues.md) and [p1-issues.md](p1-issues.md).

- **CRM (customer relationship management):** customers and contacts, duplicate
  checks, scoped access, leads, lead conversion, opportunities, stage transitions
  and activities are implemented in the API and staff workspace.
- **Quotation builder:** draft creation and editing, lines, costs, catalogue
  references, payment schedules, server-calculated pricing, discounts, tax,
  currency/FX rules and preview support. Shared money rules keep calculations
  consistent across consumers.
- **Quotation versions:** revision history, immutable submitted snapshots,
  approval summaries, generated PDF documents, send, customer portal responses,
  recorded outcomes and expiry handling.
- **Approval flow:** quotation-version subjects use the platform workflow and
  inbox, with scoped authorization, separation of duties and required step-up
  authentication. Existing Phase 1 internal memos remain included.
- **KYC/KYB (know your customer/business):** customer business-verification cases,
  evidence checklists, document attachment and independent review. Required
  evidence must pass document scanning; portal-access provisioning requires an
  approved KYB case. This is the repository's business-verification workflow,
  not certification of an external identity-verification provider.

## Integration record

| Source           | Source head | Integration commit |
| ---------------- | ----------- | ------------------ |
| `origin/p1-main` | `53462ca6`  | `76c5eb14`         |
| `cascade/c-p2`   | `9c063948`  | `a6b192d0`         |

The Phase 1 merge retained both the P0 shell browser regression and the P2
CRM/customer/quotation browser specs. The cascade's older account-switcher,
production-marker and navigation variants were resolved in favor of the newer
integrated implementation. Instant development switching and the credential
exclusion markers remain intact. The cascade adds normalization of omitted
protobuf organization login-policy defaults, with regression coverage for
omitted false/zero values, avoiding unnecessary policy rewrites.

Fetched origin before integration and inspected local and remote branch tips.
No additional P2 branch tips within the preceding 12 hours required merging;
`origin/p2/crm-quotations` was already the starting head. Historical P2 feature
branches were not blindly remerged. This assignment's destination is `p2-main`;
higher-phase consolidation and full-phase PR merges remain with their owners.

## Known limitations and deferred verification

- This Windows checkout has dependencies and production build output, but no
  `.env`, `.dev`, seeded identity configuration or running application stack.
  Authenticated demo workflows are not freshly browser-verified here. Existing
  external runtimes, seeded data and configuration were not changed.
- Development browser tests require the isolated API/database/identity stack,
  trusted CA and personas. The shell regression also needs `next dev` and
  `BOS_E2E_NEXT_DEV=1`. Keep runtime ports, containers and data isolated by phase.
- The API P2 exit test uses real HTTP, database, queue and worker paths, but a
  test identity issuer, fake PDF renderer and fake virus scanner. Its customer
  portal identity is seeded directly. It does not prove live identity-provider
  provisioning, real renderer/scanner integration or interactive portal login.
  The separate portal-access API exists and enforces approved KYB.
- Carry memo migration `0037_internal_memos.sql` with the hash-aware migration
  runner. Preserve existing SQL hashes and runtime data. This consolidation did
  not apply runtime migrations or deploy anything.
- Phase 1 icon motion is a standalone review prototype, not integrated app UI.
  Full screen-reader acceptance remains outstanding; see the inherited Phase 1
  notes and [memo delivery evidence](../design/memos/DELIVERY.md). Earlier P2
  checks there are historical evidence, not a substitute for this run.
- CI push filters cover `main` and `p*/**`; `p2-main` does not match that phase
  filter. A successful push does not itself establish hosted CI success.
- Local tests emit pg query-concurrency deprecation, Vite config-loader and
  EventEmitter listener warnings. These are recorded caveats, not suppressed.

### Windows antivirus fixture interference

Windows Defender identified `Virus:DOS/EICAR_Test_File` (threat ID
`2147519003`) in this run's `bos-docs-it-*`, `bos-e2e-files-*` and
`bos-scan-test-*` and `bos-docs-generated-*` temporary quarantine directories. Detection records confirm
successful remediation. The expected harmless EICAR antivirus-test bytes are
removed by the host before the application's fake scanner can exercise them.
This causes upload HTTP 500 and missing-file/scan failures in those tests.
No host protection was disabled and no antivirus exclusion was added. Recheck
these fixture cases in the repository's Linux CI environment before claiming
all tests pass.

### Document socket failures

Three additional package-test failures reproduce with a single test worker:

- `clamd.client.test.ts`: size-limit response expects the scanner's definite
  error text but receives `read ECONNRESET`; the related non-transient assertion
  consequently also fails (14 other tests pass in the isolated file).
- `documents.integration.test.ts`: the Content-Length 25 MiB + 1 rejection case
  receives `read ECONNRESET` rather than an observable HTTP 413 (the two other
  Content-Length-selected tests pass).

The client, fake scanner, document implementation and tests are byte-identical
to baseline `59f48faf`. Early socket closure while a sender is still streaming
is the suspected Windows-specific boundary; Linux parity and a definitive root
cause remain unverified. These are unresolved failures, separate from the
confirmed Defender fixture interference. No document-security behavior was
changed during consolidation.

### Existing formatting debt

Repository-wide Prettier also flags four inherited files:
`apps/workspace/src/dev/accounts.server.ts`, `design/memos/deliverable.html`,
`previews/p1-icon-motion/deliverable.html` and
`previews/p1-icon-motion/README.md`. They were retained without unrelated
formatting edits. The integration's browser configuration and seed changes
pass focused formatting checks.

## Consolidation verification

Windows, Node `24.18.0`, pnpm `11.28.11`, Docker Engine `29.8.2`.
Application source candidate: `a6b192d0`; browser-config formatting commit `ad92e7c4`
and this issues document do not change application runtime code.

| Check                                                  | Result                                                                 |
| ------------------------------------------------------ | ---------------------------------------------------------------------- |
| Frozen-lockfile dependency install                     | Passed                                                                 |
| Recursive typecheck                                    | Passed, all eight packages                                             |
| Root ESLint, zero warnings                             | Passed                                                                 |
| All package tests, sequential packages and two workers | 3,737 passed, 6 failed, 10 skipped                                     |
| API HTTP end-to-end suite                              | 80 passed, 1 failed (Defender/EICAR fixture)                           |
| Workspace production build                             | Passed                                                                 |
| Production dev-route/credential exclusion checker      | Passed: no dev routes or credential markers                            |
| Portal production build                                | Passed                                                                 |
| Scoped formatting, image-pin check, final diff review  | Passed for integration edits; 28 image references pinned/built locally |
| Repository-wide formatting                             | Failed on four inherited files; scoped changed-code formatting passed  |
| Authenticated browser workflows                        | Not run: no configured local identity/runtime                          |
| Docker image builds, full-history secret scan          | Not run locally                                                        |

Package totals: contracts 231 passed; database 300 passed; locale 18 passed and
10 skipped; seed tooling 133 passed; portal 238 passed; workspace 851 passed;
money rules 116 passed; API 1,850 passed and 6 failed. The HTTP end-to-end suite
is separate: 80 passed and 1 EICAR-fixture failure across six files, including
the successful P2 lead-to-accepted-quotation exit journey. Focused diagnostic
reruns are not added to these totals.

Verification commands used the shared heavy-job queue for installation,
typechecking, lint, builds and suites. Main test command:
`pnpm --workspace-concurrency=1 -r --if-present run test --maxWorkers=2`.
HTTP suite: `pnpm --filter @bos/api test:e2e`. Production builds:
`pnpm --filter @bos/workspace... build` and
`pnpm --filter @bos/portal... build`, followed by
`node apps/workspace/scripts/check-no-dev-routes.mjs`.

The checkout and installed dependencies are retained for follow-up work. No
application server is claimed to be running. Configure a dedicated P2 runtime
before using the workspace's `dev` or stack commands; do not borrow P0/P1 data.
