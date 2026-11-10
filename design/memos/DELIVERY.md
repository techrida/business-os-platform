# Internal memo delivery record

Implementation owner: Codex. Starting P1 head: ee22fd34542e8345e4b19758774535d6baf999c9.

Status: P1 delivered, refreshed and browser-verified, including the human-only directory and frozen approval-page preview. Higher-phase cascades are in progress. Canonical heads are recorded in the shared KB and coordinator handoff.

## Migration cascade

`0037_internal_memos.sql` adds nullable membership `job_title` and nullable memo `template` snapshots. Existing memos keep null; there are no invented historical signers or job titles. No real logo source exists in P1; omit the logo cleanly.

Existing phase migration SQL, ledger hashes and timestamps must stay unchanged. The migration runner now serializes with a PostgreSQL advisory transaction lock and applies journal entries whose SQL hashes are absent from the existing Drizzle ledger. This handles a P1 database with memo timestamp 37 subsequently gaining CRM timestamps 15–18, without skipping CRM or rerunning already recorded SQL. The transaction rolls back both schema and ledger on error.

On each normal phase merge, retain the target journal entries in existing order, append the new memo entry, and give its journal `idx` the next target index. Preserve tag/hash/timestamp. Do not copy lower-phase schema files over higher-phase features. The new runner is mandatory for all phases before migration.

Runtime owner must back up P1, preserve prior API image, build only P1 API/migrate images, briefly stop P1 API/worker, run migrations on existing P1 volumes, inspect ledger/columns, recreate only P1 API/worker and restart the P1 development server. Never build into its active `.next`.

## Verification so far

- Final API and workspace typechecks passed.
- Real Postgres memo integration: 35 tests passed with the final hash-aware runner and migration tag.
- Real Postgres phase-upgrade migration regression passed: missing older migration applies once, original ledger rows and seeded data stay intact, failure rolls schema and ledger back.
- Browser save/reopen/preview/submit, runtime refresh, runtime refresh remain pending. Isolated feature-worktree production build and dev exclusion checker passed.
- P2, P3, combined P4 memo cascade sessions remain pending P1 completion.

Follow-up verification: runner rejects unknown applied hashes before applying pending migrations. Real Postgres regression passed for changed historical SQL and rollback. Memo decision authorization now requires the selected staff member (or an existing authorized delegate), in addition to all normal live role and separation-of-duties checks. The real memo integration regression proves another eligible role holder cannot approve under the selected person's printed name and the selected people can complete approval. All 35 memo tests pass with this guard.

Browser acceptance (2026-11-10): live P1 created MEMO-2083/84-00004, reopened it with persisted letterhead/people/date/department/closing/body, and submitted to internal approval request 06ae6b0e-c6b2-4427-acc1-0e04ae0b8c33. No external correspondence action used. Preview preserves single newlines, paragraph gap, app font and no subject divider; 390px layout has no horizontal overflow. Keyboard search, ArrowDown/Enter selection, Escape focus restoration, empty-result announcement and one closed popup after selection verified. Full assistive-technology screen-reader testing remains unrun. Missing departments initially showed the honest empty state; runtime owner added an actual Operations directory department for the test, without fabricated staff/titles.

Human-only eligibility uses nonempty mirrored human email: the existing ZITADEL mapper reads email only from `human.email`, never machine profiles. The upstream CreateUserRequest.Human and AddHumanUserRequest both require SetHumanEmail (https://github.com/zitadel/zitadel/blob/main/proto/zitadel/user/v2/user_service.proto). No email is returned to the client or printed as a title. Focused integration proves service-account exclusion; human records with incomplete synchronization remain unavailable until synchronized.

Final P1 acceptance: the refreshed directory contains six real human staff and omits all service accounts. The submitted approval route renders the frozen memo as a document and names the selected accountant and finance approver. Source and type checks passed after this consumer fix. Browser form submissions use CRLF line endings; normalize those in presentation before paragraph splitting so paragraph ends do not introduce extra visual blank lines. Stored snapshots and single newlines remain intact. No real job titles were invented; null titles omit cleanly. Full screen-reader testing remains outstanding.

## P2 cascade, 2026-11-10 (Codex)

Integrated exact final P1 `41f664a816ae721c998c0d99c8ed88e73bb2fa6f` by normal merges onto canonical P2 baseline `8baff62238e9e80a970f9a09a94263b3561788e4`. CRM, quotation workflows and inbox behavior retained. The only conflict was the journal: existing P2 entries remain unchanged; memo migration appended at idx 19 with original timestamp 1783000000037. No prior SQL changed.

Passed on P2: database 300 tests/17 files, contracts 231/8, API 1856/133 (including memo, approvals, CRM/quotations), workspace 851/66; all eight package typechecks; zero-warning lint; isolated production webpack build and check-no-dev-routes. Real Postgres tests used the private ephemeral Docker proxy. The initial root typecheck wrapper could not find bare pnpm; its recursive command passed through Corepack. Scratch build's pnpm dependency preflight refused the external node_modules symlink; Next itself completed successfully and exclusion inspection passed. No runtime data migrated or deployment performed.

P1 live browser acceptance is inherited evidence from the source owner, not repeated on a P2 runtime: human directory, save/reopen/preview/submit, frozen approval paper/named route, mobile and keyboard passed. Full screen-reader testing and P2 live browser workflows remain unrun. P3 and combined P4 delivery remain downstream until their verified remote heads are recorded by their owners. Central KB reconciliation belongs to the primary coordinator.
