# Phase 2 Linux runtime and verification handoff

Use Ubuntu WSL and Linux Node 24/pnpm. The shared source is
`~/src/business-os-platform`; obtain the current owner's release before
switching phases. The verification order is P2 -> P3 -> P4. Preserve the existing
`.env`, `.dev`, Docker volumes and demo records. Do not build into an active
Next.js development output directory.

## Checks

From the ext4 checkout:

```bash
source infra/scripts/env.sh
pnpm install --frozen-lockfile
pnpm --workspace-concurrency=1 -r --if-present run test --maxWorkers=2
pnpm --filter @bos/api test:e2e
pnpm typecheck
pnpm lint
pnpm format:check
pnpm --workspace-concurrency=1 -r --if-present run build
node apps/workspace/scripts/check-no-dev-routes.mjs
node infra/scripts/check-image-pins.mjs
pnpm --filter @bos/workspace e2e:prod
```

Run heavy commands through the machine-wide host resource queue, with a WSL
payload. Example from PowerShell (no Windows Node or pnpm is invoked):

```powershell
& "$env:USERPROFILE\.agents\bin\heavy.ps1" -Kind test -Cwd (Get-Location).Path -Command "wsl -d Ubuntu -- bash /mnt/c/Users/kuu/.an assistant/handoffs/business-os-p2-consolidation/wsl-run.sh pnpm --filter @bos/api test:e2e"
```

`wsl-run.sh` enters the checkout and sources the Linux toolchain before executing
its arguments. The existing `infra/scripts/w.sh --branch` has force/reset
behavior; do not use that branch-switch option to discard dirty work.

## Existing reusable runtime

- Compose project: `bos-qa-p2-4`.
- Protected Compose environment: `/var/tmp/agents-bosqa-p2/stack.env`.
- Protected seed outputs/personas: `/var/tmp/agents-bosqa-p2/.dev/`.
- Task override: `/var/tmp/agents-p2-runtime/compose.p2.yaml`.
- Host app/auth configuration loader: `/var/tmp/agents-p2-runtime/env.sh`.
- Real local CA: `/var/tmp/agents-p2-runtime/p2-root.crt`.
- Dedicated development login-client token: protected file in that same runtime
  directory; never print it or add it to Git.

Start the existing core/files services from the current phase source:

```bash
source infra/scripts/env.sh
docker compose -p bos-qa-p2-4 \
  --env-file /var/tmp/agents-bosqa-p2/stack.env \
  -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml \
  -f /var/tmp/agents-p2-runtime/compose.p2.yaml \
  --profile core --profile files up -d --wait --wait-timeout 600
docker compose -p bos-qa-p2-4 \
  --env-file /var/tmp/agents-bosqa-p2/stack.env \
  -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml \
  -f /var/tmp/agents-p2-runtime/compose.p2.yaml up -d --wait gotenberg
```

Keep a foreground WSL session active for the runtime lifetime: systemd-managed
Docker alone did not prevent this machine's WSL idle shutdown. Services are
localhost-bound; browser addresses are `https://app.localhost`,
`https://auth.localhost`, `https://api.localhost`, `https://portal.localhost`,
and `https://mail.localhost`. The existing override publishes OIDC Valkey on
6380 and Gotenberg on 3003 for host app processes. Standard API/workspace/portal
ports are 3001/3000/3002.

After the phase's required packages are built, source the runtime loader and
start API, worker and workspace in separate foreground terminals, each through
the host resource queue:

```bash
source infra/scripts/env.sh
source /var/tmp/agents-p2-runtime/env.sh
METRICS_PORT=9464 node apps/api/dist/main.js
# Separate terminal, with the same environment loader:
METRICS_PORT=9465 node apps/api/dist/worker.js
# Separate terminal, with the same environment loader:
pnpm --filter @bos/workspace dev --hostname 0.0.0.0 --port 3000
```

Set metrics ports explicitly: the reused legacy `.env` contains 9464, which
would otherwise make API and worker collide. For the portal, also source
`/var/tmp/agents-bosqa-p2/.dev/zitadel-portal.env`, export its `OIDC_CLIENT_ID`,
and use portal-specific `OIDC_REDIRECT_URI`, `WORKSPACE_PUBLIC_URL`, and session
key ID before starting port 3002. P2's final staff-only run stops the unused
portal process; a production build is not a running portal.

## Browser prerequisites and coverage

The existing P2 personas sign in through real ZITADEL password/TOTP, with a
separate development login client for instant switching. Credentials remain in
protected files and server processes. Source `env.sh`, then export variables
from `/var/tmp/agents-p2-runtime/fixtures.env` before `pnpm --filter
@bos/workspace e2e`; the task's `wsl-browser.sh` does this. The CA stays verified;
no TLS bypass was introduced. Traces/videos stay disabled to protect credentials.

The runtime had no department. Setup added a General department and assigned it
only to seeded personas with null department membership. Manual assignments
were preserved. A unique P2 demo customer, qualified opportunity and submitted
KYB review case were added. The review case is a UI-validation fixture, not a
claim of a genuine document-backed submission. P3 and P4 own their new fixtures.
The exact guarded setup is in the task's `wsl-demo-fixtures.sh`; its generated
runtime script and fixture IDs remain outside Git.

Quotation detail/send/outcome/download/revise browser specs require their
explicit approved/sent/scanning/revisable fixtures. P2 populated these through
real approvals and rendering and exercised them in staged runs. The fixture
IDs are consumable state: sending, rejecting and revising change them, so prepare
fresh lifecycle records before repeating a full run. Missing fixtures are skips,
not passing workflow evidence. The local demo issuer address was set only when
`entity.address` had no existing version; no tax identity was invented. The API end-to-end suite separately
covers the complete P2 journey. A no-customer-access browser case is an existing
`fixme`. Production LCP needs a signed-in production stack and is separately
skipped by the localhost production exclusion run.

## Persistent schema and backups

The compatible P2 database received only `0037_internal_memos.sql`; its ledger
advanced from 19 to 20. Historical SQL and ledger entries were preserved; the
tenancy check passed. The protected pre-upgrade dump is
`/var/tmp/agents-p2-runtime/p2-before-upgrade.dump`. Higher phases must build
and use their complete migration source, retain existing hashes, and apply
missing known migrations with the guarded runner. Never relabel an applied hash.

The separate legacy `bos` database has six unknown historical hashes. Its
migration attempt rolled back; it remains preserved and stopped. Its protected
backup is `/var/tmp/agents-p2-runtime/bos-before-p2.dump`. Its Valkey AOF had a
614-byte incomplete tail; recovery touched a copy only. Original named-volume
data and a full snapshot remain intact. This legacy project is not the P2
browser database. Do not use its incompatible ledger as a reason to reset it.

## Requirements and decision defaults

Current plans and decision records live at:

```text
/mnt/f/Projects/Life/life-kb/Techrida/projects/business-os/docs/platform/P2-BUILD-PLAN.md
/mnt/f/Projects/Life/life-kb/Techrida/projects/business-os/docs/platform/P3-BUILD-PLAN.md
/mnt/f/Projects/Life/life-kb/Techrida/projects/business-os/docs/platform/OPEN-DECISIONS.md
```

Use Kuu's latest authorization and reasonable recommended defaults. Historical
Prisma-era decision logs in the separate old Business-OS tree are not the current
phase authority. Keep real roles, scopes, evidence rules and distinct approvers.
