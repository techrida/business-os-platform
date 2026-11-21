# @bos/db

Schema, migrations, the migration runner and the SQL fixtures of Business OS.

## Adding a migration

1. Write `packages/db/migrations/<NNNN>_<snake_case_name>.sql`. Use only the numbers of your unit's block.
2. Merge `origin/p4-main` first, then append the journal entry with the helper instead of editing
   `migrations/meta/_journal.json` by hand:

   ```sh
   node tools/migration-append.mjs packages/db/migrations/0140_my_change.sql
   ```

   It adds an entry with the next `idx` and a `when` one above the highest `when` in the journal, so `when` only
   grows. It refuses a file outside `packages/db/migrations`, a tag that is already journaled and an empty file.
   `--dry-run` prints the entry without writing.

3. A data migration sets the audit actor first (copy the `set_config('bos.actor_*')` preamble from
   `0013_legal_entities.sql`).
4. Re-run the migration tests after the merge.

## Testing against Postgres

Every vitest suite that needs a database uses ONE `postgres:16-alpine` container per run:

- `src/testing/vitest-global-setup.ts` (a vitest `globalSetup`) starts the container, creates the roles and
  privileges of `infra/postgres/init-dbs.sh` and applies every migration once into a template database.
- A test file calls `createTestDatabase()` from `src/testing/test-database.ts` (import `@bos/db/testing` from
  other packages) in `beforeAll` and `drop()` in `afterAll`. It gets its own `CREATE DATABASE … TEMPLATE …` copy,
  so files stay isolated. `createTestDatabase({ migrated: false })` gives a copy with roles and privileges but
  no migration, for tests that apply migrations themselves.
- Nothing else may start a `PostgreSqlContainer`. The `vitest.config.ts` of `packages/db`, `apps/api` and
  `tools/seed-zitadel` register the global setup and cap the number of workers.

Run the whole gate with `tools/gate.sh` (it takes a machine-wide lock, so two gates never run together).
