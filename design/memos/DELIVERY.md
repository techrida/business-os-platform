# Internal memo delivery record

Implementation owner: an assistant. Starting P1 head: ee22fd34542e8345e4b19758774535d6baf999c9.

Status: implementation and verification in progress; not yet shipped or refreshed.

## Migration cascade

`0037_internal_memos.sql` adds nullable membership `job_title` and nullable memo `template` snapshots. Existing memos keep null; there are no invented historical signers or job titles. No real logo source exists in P1; omit the logo cleanly.

Existing phase migration SQL, ledger hashes and timestamps must stay unchanged. The migration runner now serializes with a PostgreSQL advisory transaction lock and applies journal entries whose SQL hashes are absent from the existing Drizzle ledger. This handles a P1 database with memo timestamp 37 subsequently gaining CRM timestamps 15–18, without skipping CRM or rerunning already recorded SQL. The transaction rolls back both schema and ledger on error.

On each normal phase merge, retain the target journal entries in existing order, append the new memo entry, and give its journal `idx` the next target index. Preserve tag/hash/timestamp. Do not copy lower-phase schema files over higher-phase features. The new runner is mandatory for all phases before migration.

Runtime owner must back up P1, preserve prior API image, build only P1 API/migrate images, briefly stop P1 API/worker, run migrations on existing P1 volumes, inspect ledger/columns, recreate only P1 API/worker and restart the P1 development server. Never build into its active `.next`.

## Verification so far

- API and workspace typechecks passed; final recheck after migration runner changes underway.
- Real Postgres memo integration: 35 tests passed with the final hash-aware runner and migration tag.
- Real Postgres phase-upgrade migration regression passed: missing older migration applies once, original ledger rows and seeded data stay intact, failure rolls schema and ledger back.
- Browser save/reopen/preview/submit, runtime refresh, runtime refresh remain pending. Isolated feature-worktree production build and dev exclusion checker passed.
- P2, P3, combined P4 memo cascade sessions remain pending P1 completion.

Follow-up verification: runner rejects unknown applied hashes before applying pending migrations. Real Postgres regression passed for changed historical SQL and rollback. Memo decision authorization now requires the selected staff member (or an existing authorized delegate), in addition to all normal live role and separation-of-duties checks. The real memo integration regression proves another eligible role holder cannot approve under the selected person's printed name and the selected people can complete approval. All 35 memo tests pass with this guard.
