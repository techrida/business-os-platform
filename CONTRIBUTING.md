# Contributing to Business OS

Thank you for contributing to Business OS. Follow this guide to set up your environment, run local quality gates, and open a pull request.

## Local setup

Follow [Getting started](docs/getting-started.md) to install Node.js 24, pnpm 11, and Docker, generate `.env`, start the local stack, and seed ZITADEL.

## Branch and commit conventions

1. Create a short, descriptive branch from the target base branch before making edits.
2. Write commit messages using Conventional Commits, matching the repository history:

   ```text
   type(scope): short summary
   ```

   Common types are `feat`, `fix`, `test`, `docs`, `refactor`, and `chore`. Examples:
   - `fix(invoices): round partial credit note NPR allocation`
   - `test(documents): reject quarantined versions without sha256`
   - `docs: update getting-started troubleshooting steps`

3. Keep each commit focused on one logical change. Never commit `.env`, `.dev/` files, credentials, or local artifacts.

## Code standards

- **Money precision**: Never use JavaScript floating-point math for money. Use `@bos/locale` (`Dec`, `formatMoney`) and `@bos/money-rules`. Store, compute, and display monetary amounts to at most 2 decimal places using half-up rounding, and put any split remainder on the last line. Percentages may use up to 4 decimal places.
- **Authorization**: Every API controller route must declare `@Can(...)`, `@AnyAuthenticated()`, or `@Public()`. The API checks route policy at startup and refuses to boot if a route lacks a decorator.
- **Database tenancy and audit**: New business tables in schema `app` must include `tenant_id` (and `organization_id` for entity-owned tables) and attach the `audit_capture` trigger. Verify both with `pnpm --filter @bos/db check-tenancy` and `pnpm --filter @bos/db check-audit`.
- **Container images**: Pin every `image:` in Docker Compose files and every `FROM` in Dockerfiles by `@sha256` digest. CI verifies this with `node infra/scripts/check-image-pins.mjs`.
- **Development-only tools**: Keep testing controls and debug helpers out of production builds. Production exclusion is checked automatically in `tools/gate.sh` and CI.

## Running the local gate

Run the full repository gate from the repo root before opening a pull request:

```bash
bash tools/gate.sh
```

`tools/gate.sh` acquires a machine-wide lock (via `flock`) so concurrent runs do not contend for CPU or memory, writes step logs under `/tmp/bos-gate-logs/`, and runs these steps in order:

1. `pnpm install --frozen-lockfile` (ensures the lockfile matches every `package.json`)
2. Production-profile build (`BOS_BUILD_PROFILE=production BOS_NEXT_DIST_DIR=.next-gate pnpm -r --if-present build`)
3. Dev-tools boundary check (`apps/workspace/scripts/check-no-dev-routes.mjs` on the production workspace build, the dev-profile workspace build, and the production portal build)
4. `pnpm typecheck`
5. `pnpm lint` (ESLint with `--max-warnings 0`)
6. `pnpm format:check` (Prettier)
7. `pnpm test` (Vitest unit suites across all workspace packages)

To auto-format files before re-running the gate:

```bash
pnpm format
```

Do not run `next build` into `.next` while `next dev` is running in the same directory. `tools/gate.sh` uses isolated scratch directories (`BOS_NEXT_DIST_DIR`) so it does not interfere with a live dev server.

## Running integration and browser tests

Unit tests run inside `bash tools/gate.sh`. When your change touches database migrations, API endpoints, or browser workflows, also run the matching integration or end-to-end suite:

```bash
# Database migration, tenancy, and audit checks (uses Testcontainers PostgreSQL)
pnpm --filter @bos/db test

# API end-to-end tests (uses Testcontainers PostgreSQL)
pnpm --filter @bos/api test:e2e

# Container image digest pin check
node infra/scripts/check-image-pins.mjs
```

Playwright browser suites require the local Docker stack (`pnpm stack:up`) and seeded ZITADEL (`pnpm seed`):

```bash
pnpm --filter @bos/workspace e2e
pnpm --filter @bos/portal e2e
```

## Pull request process

1. Push your branch to your fork or feature branch and open a pull request using the repository template (`.github/pull_request_template.md`).
2. Describe what changed, why it changed, and which checks you ran.
3. Wait for all GitHub Actions CI jobs to pass:
   - `checks`: typecheck, lint, unit tests, format check, and image pin check
   - `secrets`: full-history secret scan with `gitleaks`
   - `e2e`: `@bos/db` tests and `@bos/api` end-to-end tests
   - `web`: production builds for Workspace and Portal plus dev-route exclusion checks
   - `docker`: production Docker image builds and Login V2 tests
4. Address review feedback with clear follow-up commits.

## Licensing of contributions

Business OS is licensed under the GNU Affero General Public License v3.0 only (`AGPL-3.0-only`). By submitting a pull request or other contribution to this repository, you agree that your contribution is licensed under `AGPL-3.0-only` as stated in the repository `LICENSE` file.

## Code of conduct

All contributors and participants must follow the [Code of Conduct](CODE_OF_CONDUCT.md).
