# P4 Linux runtime handoff — 2026-11-12

All project execution is Linux only: Ubuntu WSL, Node 24 and pnpm, after
`source infra/scripts/env.sh`. Never run project tooling on native Windows.
The Windows resource queue may wrap a WSL command, but the payload runs entirely
inside Linux. Evidence and results are in [p4-issues.md](p4-issues.md).

## What changed on 2026-11-12

The earlier P4 runtime is gone. The hourly WSL scratch cleaner removed
`/var/tmp/agents-bosqa-p4` (including the pre-P4 database dump
`p4-before-upgrade.dump`, the loaders, the run scripts and
`progress-fixtures.json`) and the config of the old compose project
`bos-qa-p2-4` on 2026-11-12. Treat all of these as lost:

- Do not follow older notes that point at `/var/tmp/agents-*` paths.
- `bos-qa-p2-4` cannot start. Its Docker volumes are kept and untouched; removing
  them needs Kuu's explicit approval. Do not point new code at them: their
  database already carries P4 migrations.
- Keep every runtime under `~/private-runtimes`, which the cleaner does not touch.

## The isolated P4 stack: `bos-p4v`

| Item            | Value                                                                                                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source          | Detached WSL worktree `~/private-runtimes/p4v`, created from the shared clone `~/src/business-os-platform` at the tested head (`764f2abf` plus any later documentation-only commits) |
| Compose project | `bos-p4v` (every compose command needs `COMPOSE_PROJECT_NAME=bos-p4v`)                                                                                                           |
| Images          | `bos-p4v/api:dev`, `bos-p4v/workspace:dev`, `bos-p4v/portal:dev` (production builds); override `~/private-runtimes/p4v-images.yaml`                                                  |
| URLs            | `https://app.localhost` (staff), `https://api.localhost`, `https://portal.localhost` (vendor portal)                                                                             |
| Trusted CA      | `~/private-runtimes/p4v/.dev/caddy-root.crt`, copied from the stack's Caddy; use it, never disable certificate verification                                                          |
| Personas        | `~/private-runtimes/p4v/.dev/personas.json` (private); eleven seeded personas                                                                                                        |
| Stack secrets   | `~/private-runtimes/p4v/.env` and `.dev/` (mode 600); never copy another stack's secrets                                                                                             |
| Browser state   | `~/private-runtimes/p4v-browser` (mode 700): fixtures, `progress.json`, `fixtures.env`, storage state, logs, screenshots                                                             |

Never publish, print or commit credentials, the personas file, storage state,
`fixtures.env` or database backups.

The helper scripts live outside Git, in
`C:\Users\kuu\.an assistant\handoffs\business-os-p4-consolidation\r2\` (WSL path
`/mnt/c/Users/kuu/.an assistant/handoffs/business-os-p4-consolidation/r2/`). They share
`p4v-common.sh`, which defines `R=$HOME/private-runtimes/p4v`, the `dc` compose helper
and the `svc` container lookup. To use the same helper in a shell:

```bash
source /mnt/c/Users/kuu/.an assistant/handoffs/business-os-p4-consolidation/r2/p4v-common.sh
cd ~/private-runtimes/p4v && source infra/scripts/env.sh
dc --profile core --profile files --profile app ps
```

## Starting from zero

Run each heavy step through the host queue (see the wrapper below). Do not start
this stack while another stack holds ports 80, 443, 5432, 6379, 1025 or 3310.

1. **Core setup** — `p4v-a-setup.sh <git ref>`: writes the image override, creates
   or moves the detached worktree to `<git ref>`, `pnpm install --frozen-lockfile`,
   `make-dev-env.sh` (only if there is no `.env`), starts the `core` and `files`
   profiles, copies Caddy's root CA to `.dev/caddy-root.crt`, runs
   `migrate-dev.sh` (includes the tenancy check) and the ZITADEL seed. The known
   seed warning is the Actions webhook DeniedURL, covered by the ten-minute
   reconcile.
2. **App images and services** — `p4v-b-app.sh`: builds the API, workspace and
   portal images and brings up `api worker workspace portal gotenberg`, recreates
   Caddy and checks the three health endpoints. To rebuild only the portal at the
   shared clone's current head, use `p4v-portal.sh`.
3. **Demo data** — `p4v-fx-sql.sh`: adds a "General" department in one audited
   transaction (as system actor `p4-qa-fixture-general-department`) and assigns it
   only to memberships with no department, and adds the `entity.address` demo
   setting that P3 invoice issuing needs (system actor
   `p4-qa-fixture-demo-issuer`). The seed does not provide `entity.address`.
4. **Portal OIDC client** — `portal-client.sh`: **required**. The seed does not
   create the vendor/customer portal OIDC client, so portal sign-in fails with
   "redirect_uri is missing in the client configuration" without it. The script
   copies `portal-client.mjs` into the seed container, which creates a separate
   public OIDC app `portal`, writes `.dev/zitadel-portal.env`, appends the client
   id to `OIDC_ALLOWED_AZP` in `.dev/zitadel.env` and recreates api, worker and
   portal. It refuses to run unless the isolation guards pass (compose project
   `bos-p4v`, database `bos` on host `postgres`, `/repo` working directory), so it
   cannot touch another stack. The lasting fix belongs in `tools/seed-zitadel` at
   the lowest affected phase (see p4-issues.md); until then, repeat this step after
   every re-seed. Removing the client id from `OIDC_ALLOWED_AZP` breaks the portal
   callback with 401.
5. **Fixtures and browser checks** (below).

Heavy-queue wrapper (all code inside the command runs on Linux):

```powershell
& "$env:USERPROFILE\.agents\bin\heavy.ps1" -Kind docker -GB 4 `
  -Cwd 'C:\Users\kuu\.t3\worktrees\business-os-platform\p4-main' `
  -Command 'wsl.exe -d Ubuntu -- bash /mnt/c/Users/kuu/.an assistant/handoffs/business-os-p4-consolidation/r2/p4v-b-app.sh'
```

Use `-Kind docker` for the core and image steps, `-Kind browser` for the
Playwright runs and `-Kind devserver` for long-lived processes. Keep a
foreground WSL process alive while the stack runs; WSL idle shutdown has stopped
stacks before.

## Stopping

`p4v-stop.sh` stops the `core`, `files`, `app` and `tools` profiles with volumes
kept, then prints the number of running containers. Stop this stack before
another phase uses the shared ports. Stop only containers this stack owns.

## Fixtures and browser checks

- `r2/fx/run.sh [--reset]` runs the 15-stage fixture driver through the real UI
  (ZITADEL password and TOTP personas, real ClamAV and Gotenberg). It is
  resumable from `~/private-runtimes/p4v-browser/progress.json`; use `--reset` only
  after re-seeding, otherwise it points at old ids. It copies its spec into the
  worktree for the run and removes it afterwards. Do not blindly replay creation,
  quote conversion, receipt confirmation or invoice submission: read progress
  first.
- `r2/fx/consumers.sh [--exit]` runs the repository's own P4 browser specs against
  those fixtures (staff `apps/workspace` then portal `apps/portal`). The plain run
  consumes the open RFQ and creates rows; `--exit` also runs the Journey 11 specs,
  which write rows too. Run once per fixture set.
- `r2/gates.sh` runs install, typecheck, lint, format, image pins, builds, the
  two production dev-route exclusion checks, package tests and API HTTP e2e in the
  shared clone and refuses to start if a `next dev` process is running. Its
  summary is `r2/gates-summary.txt`.
- Staff checks use the `dev` Playwright project against the production workspace
  image, which returns 404 for `/dev/*`, so they sign in through real ZITADEL.
  `BASE_URL=https://app.localhost`, `PORTAL_E2E_BASE_URL=https://portal.localhost`,
  `BOS_E2E_CA_FILE` and `NODE_EXTRA_CA_CERTS` point at `.dev/caddy-root.crt`.
- The P0 shell spec needs `next dev` and `BOS_E2E_NEXT_DEV=1`; it was not run.
  The account switcher exists only under `next dev`; production correctly
  excludes it.
- **Never build into an active `next dev` `.next`.** Use an isolated scratch
  build for production checks, and run `gates.sh` only when no dev server holds
  the checkout.
- Run browser suites after any Testcontainers run finishes; network changes
  during temporary container teardown caused a navigation error before.

Financial records in the fixtures were created through normal UI commands and are
kept as demo evidence. The payment request is left as a draft: no bank payout was
performed or is possible from this stack.

## Upgrading or re-seeding

Before changing source, migrations or images: take a protected database dump and
copy `.env` and `.dev` somewhere under `~/private-runtimes` (not `/var/tmp`), move the
worktree to the new ref with `p4v-a-setup.sh <ref>`, rebuild complete dependency
outputs and images, then repeat the demo-data and portal-client steps above.
Existing applied SQL hashes must stay intact; the hash-aware migration runner
rejects unknown applied hashes.

Local green gates do not certify hosted CI, which is blocked by the GitHub billing
limit. Plans and decision defaults for P3 are listed in
[p3-linux-runtime.md](p3-linux-runtime.md).
