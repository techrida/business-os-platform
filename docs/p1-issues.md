# Phase 1 Issues and Notes

## Status and scope

Consolidated on `p1-main` on 2026-11-10, starting from
`origin/p1/platform-kernel` at `41f664a8`. Phase 0 is represented by `main`;
its notes are retained in [p0-issues.md](p0-issues.md).

- **Platform Kernel:** existing staff administration, scoped roles, approval
  workflows, inbox, notifications, documents, audit and locale infrastructure.
- **Internal memos:** persisted template snapshots, human staff directory,
  selected signers, frozen approval-page document and preserved paragraph
  formatting. `origin/kuu/p1-internal-memos` (`2d1277cf`) was already an ancestor
  of the starting Phase 1 head; no duplicate feature merge was needed.
- **Icon motion:** merged `origin/kuu/p1-icon-motion` (`fea48a50`). This delivers
  a standalone interaction review and prototype under `previews/p1-icon-motion/`.
  Proposed icon treatments and 44px targets are not integrated into application
  controls. See its [review notes](../previews/p1-icon-motion/README.md).
- **Development floating menu and whoami:** retained the current development
  widget, authenticated identity inspection and instant account switching.
  `/dev/api/whoami` returns an explicit allow-list of identity fields and requires
  the normal session. Account switching remains development-only.
- **Shell:** retained the Welcome back overview, disabled unbuilt navigation
  items without phase labels, and navigation-only sidebar scrolling. Added the
  cascade's shell browser regression to the development Playwright suite.

## Memo workflow refinement

Added on `t3/7725dac5` after the consolidation above; details, the P2 removal
map and acceptance points are in [the memo delivery record](../design/memos/DELIVERY.md).

- **Memos list:** `/memos` is a real list (`GET /v1/test-memos`, scoped by the
  caller's `memo.read` grant, keyset-paginated) with loading, empty, error and
  forbidden states. The paste-an-id lookup is gone.
- **Staff fields:** one reusable inline combobox for Prepared by, Recommended by
  and Approved by. Up to 20 staff are listed flat, more than 20 grouped by their
  real directory department. Two blank recommender rows, at most 20, blank rows
  never sent. Prepared by is only the signed-in author; server authorization is
  unchanged.
- **Preview, PDF and print:** sticky paper on wide screens, stacked on phones,
  icon-only Download PDF (real PDF via `pdfkit`, Noto Sans and Noto Sans
  Devanagari fonts, SIL OFL) and Print (the paper only).
- **P1 boundary:** the amount, currency and PDF upload controls exist in P1 to
  exercise the kernel workflow. P2 removes them from the internal memo UI and
  keeps the memo, list, export and signers. The removal map is in the delivery
  record.
- **Runtime refreshed (Nov12):** API/worker image rebuilt and containers recreated,
  workspace dependencies and contracts built, Next dev restarted on3101 with its
  cache retained. No migration or seed reset. P0 untouched.
- **Limits:** PDF fonts cover Latin, Latin Extended, Vietnamese, Greek, Cyrillic
  and Devanagari; other scripts print as `?` and the download says so. A memo
  edited by someone other than its author retains the saved preparer. The server
  continues to refuse saving under another person’s attribution; no silent reassignment.
- **Live acceptance:** full P1 exit Playwright passed (PDF scan, real sign-in,
  selected Accountant/Finance decisions, self-approval refusal, Mailpit and audit
  timeline). Separate live controls check passed: blank row save, attach redirect,
  current/saved real PDF bytes, paper-only print interception, list and390px
  overflow/hydration checks. Native print dialog, physical printer and
  screen-reader testing remain unrun. See the canonical KB P1 test guide.

## Integration record

| Source                      | Source head | Integration commit |
| --------------------------- | ----------- | ------------------ |
| `origin/main`               | `5a49eb8f`  | `6c75231a`         |
| `origin/kuu/p1-icon-motion` | `fea48a50`  | `453ae6b8`         |
| `cascade/c-p1`              | `9d0dd496`  | `2c80b03c`         |

The cascade merge conflicted in the persona browser test, production exclusion
checker, dev menu and navigation comments. The current Phase 1 versions preserve
newer instant-login behavior, real-login regression coverage and additional
production credential markers. The cascade's new shell spec and suite
configuration were retained. No Phase 1 application behavior was downgraded.

This consolidation targets `p1-main`; other phase branches and full-phase pull
requests are outside this task's explicitly designated destination.

## Known limitations and operational notes

- This Windows checkout has installed dependencies but no `.env`, `.dev`, seeded
  identity configuration or running application stack. Source consolidation does
  not migrate or restart the separate P1 runtime at `https://app.p1.bos.test`.
  Do not reuse P0 runtime addresses, containers or data for P1.
- Memo migration `0037_internal_memos.sql` and the hash-aware transactional
  migration runner must travel together. Preserve historical SQL hashes,
  timestamps and existing data. Back up a runtime before applying migrations;
  no runtime migration was performed by this consolidation.
- Existing memos retain nullable template snapshots. Missing job titles are
  omitted; role names do not substitute for titles. No official logo source is
  available in P1, so the application omits it. Signatures remain disabled.
- Staff with incomplete identity synchronization remain unavailable in the memo
  picker; service accounts are excluded. Full screen-reader testing remains
  outstanding. Prior browser acceptance and migration evidence are recorded in
  [the memo delivery record](../design/memos/DELIVERY.md); that document contains
  chronological pending notes followed by later acceptance results. Those prior
  results are not a fresh browser certification of this consolidated branch.
- The icon review still calls for application integration checks covering dark
  tokens, touch, drawer focus and notification read persistence/failure behavior.
  The existing desktop collapse control's accessible label should reflect the
  collapsed state when that follow-up is implemented.
- The newly included `p0-shell.spec.ts` requires `next dev` and
  `BOS_E2E_NEXT_DEV=1`. Authenticated browser tests also need the real isolated
  identity/API/database stack, trusted development CA and test personas.
- CI push filters currently cover `main` and `p*/**`; the branch name `p1-main`
  does not match that phase filter. A push alone does not establish CI success.

## Consolidation verification

Checked on Windows with Node `24.18.0` and pnpm `11.28.11`, against integrated
application commit `2c80b03c` (the subsequent issues commit changes docs only).

| Check                                                                            | Result                                                                                                                  |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                                 | Passed; no lockfile changes. pnpm reported blocked optional `protobufjs` install script.                                |
| `pnpm typecheck`                                                                 | Passed across all six workspace packages.                                                                               |
| `pnpm lint`                                                                      | Passed with zero warnings.                                                                                              |
| `pnpm --filter @bos/workspace --filter @bos/contracts --filter @bos/locale test` | Passed: workspace 403, contracts 48, locale 18; 10 conditional locale tests skipped in the outer run.                   |
| `pnpm --filter '@bos/workspace...' build`                                        | Passed, including workspace dependency builds and production Next.js build. No dev server used this checkout's `.next`. |
| Production dev-route exclusion and image pin checks                              | Passed: no dev routes or dev markers in production output; all 24 image references in 8 files pinned or built locally.  |
| `git diff --check`                                                               | Passed after merge resolution; repeated before push.                                                                    |

Test tooling emitted a Vite configuration compatibility warning and Node
listener-count warnings; the selected tests completed successfully. This run did
not execute the full database/API integration suites, Docker image builds,
authenticated browser workflows, full-repository formatting or secret-history
scan. No deployment or runtime demo readiness is claimed from these source checks.

To start local development after provisioning an isolated P1 environment, use
`pnpm --filter @bos/workspace dev --port 3101` with the P1 API, identity service,
Valkey and proxy configured. Run heavy jobs through the shared resource queue.

## Private tailnet development access (Nov15)

Kuu requested private remote-PC/phone access as a development default. The dev-only
account service now accepts additional exact HTTPS origins only when explicitly
listed in BOS_DEV_TRUSTED_ORIGINS. Host, port, Origin and Fetch Metadata checks
remain enforced; production routes remain excluded and the production guard refuses.
BOS_DEV_IDENTITY_API_URL separates privileged server-side identity calls from a
restricted browser OIDC bridge. No browser receives the login-client token.
Runtime configuration belongs to the isolated P1 checkout; it uses a canonical
identity issuer, two registered app callbacks and separate Next dev cache directories.
Cookies are not port-isolated: future same-host phase apps need distinct cookie
names or service hostnames. Host Serve configuration is owned by Config Omarchy.
This is a later development convenience request, not an original PRD main feature.
Verification: 448 workspace tests and typecheck/lint passed; live/prod verification
is in progress and must be recorded before calling the remote login ready.
