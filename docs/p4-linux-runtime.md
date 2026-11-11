# P4 Linux runtime handoff — 2026-11-11

P4 owns `~/src/business-os-platform` in Ubuntu following explicit
P2 → P3 → P4 release. All project execution must remain Linux/WSL only.
Do not switch the shared checkout or modify its containers while another phase
owns it. No duplicate stack was created. P0/P1 and legacy `bos` remain separate.

## Source and protected state

- Branch `p4-main`, based on the published P3 head `66c9efef`; P2 `c703bcb5`
  is ancestral. Read `git status`/`git rev-parse HEAD` before another handoff.
- Reused core compose project `bos-qa-p2-4`, protected compose file
  `/var/tmp/agents-p2-runtime/compose.p2.yaml` and protected stack config
  `/var/tmp/agents-bosqa-p2/stack.env`. Preserve volumes and `.env`/`.dev`.
- Pre-P4 database dump: `/var/tmp/agents-bosqa-p4/p4-before-upgrade.dump`
  (ledger 26); configuration backup: `/var/tmp/agents-bosqa-p4/dev-before-p4`.
  Prior P2/P3 dumps remain preserved. Current normal migration ledger is 35;
  existing SQL hashes were preserved and tenancy verification passed.
- Persona credentials: `/var/tmp/agents-bosqa-p2/.dev/personas.json` (private).
  Normal P4 seed adds procurement, warehouse, depthead and management2.
  Six retired receiver grants were intentionally removed under D03; all other
  original grants are retained. No financial ledger was directly seeded by QA.
- API loader `/var/tmp/agents-bosqa-p4/env.sh` retains the P3 loader's explicitly
  registered portal OIDC client in `OIDC_ALLOWED_AZP`. Removing it breaks the
  portal callback with 401. Portal has its own OIDC client and key ID.
- Trusted CA: `/var/tmp/agents-p2-runtime/p2-root.crt`. The inherited repository
  `.dev/caddy-root.crt` can be stale. Never disable certificate verification.
- Seed's ZITADEL Actions registration received denylist 400; normal seed
  mirrored the new identities and ten-minute reconciliation remains enabled.

Do not publish credentials, storage state, configuration backups or database
backups. Private files under `/var/tmp/agents-bosqa-p4` remain for active QA;
cleanup is deferred while the user needs this shared runtime and evidence.

## Running and restarting

Currently checked production outputs serve workspace `https://app.localhost`
(port 3000), API `https://api.localhost` (3001) and vendor portal
`https://portal.localhost` (3002), behind the existing Caddy. API/worker metrics
use 9464/9465. Core includes PostgreSQL, both Valkey services, ZITADEL API/login,
ClamAV, Mailpit, Gotenberg and backup scheduler. Inspect live listeners and
queue leases before restarting; do not kill unrelated services.

Every heavy command must use the host shared resource queue. Example wrapper
(all code inside the command runs on Linux):

```powershell
& "$env:USERPROFILE\.agents\bin\heavy.ps1" -Kind devserver -GB 1 `
  -Cwd 'C:\Users\kuu\.t3\worktrees\business-os-platform\p4-main' `
  -Command 'wsl.exe -d Ubuntu -- bash /var/tmp/agents-bosqa-p4/workspace-serve.sh'
```

Equivalent existing scripts: `core-start.sh` (docker kind), `api-serve.sh`
(API and worker), `workspace-serve.sh`, `portal-serve.sh`. They do not migrate or
seed. Keep a foreground WSL session alive to avoid idle shutdown. Stop only
owned app processes before changing source, migrations or production builds.
Never build into `.next` while a dev or production server is using that output.
For account-switcher checks, use a separate stopped-build/`next dev` turn;
production correctly excludes the development tooling.

Before future upgrades, take a protected database/configuration backup, source
`infra/scripts/env.sh` and the P4 loader, then follow the repository's normal
migration/tenancy/seed commands. Use the shared queue for builds/checks, and
rebuild complete dependency outputs before serving a new source revision.

## Acceptance evidence and fixtures

Sanitized screenshots and the final handoff are in the Windows task handoff
folder `C:\Users\kuu\.an assistant\handoffs\business-os-p4-consolidation`.
Protected acceptance scripts, storage states, progress and logs are in
`/var/tmp/agents-bosqa-p4`.

- `checks-summary.txt`, `packages.log`, `api-e2e.log` record the Linux gates.
- `browser-run.sh` runs staff Playwright with the trusted CA and real personas.
- `portal-run.sh` runs portal checks with actual vendor storage state.
- `progress-fixtures.json` identifies the specific disposable PR/RFQ/PO,
  receipt and bill created through UI. It records progress to prevent replay.
- `fixture.spec.ts`, `journey-fixture.spec.ts`, `receipt-bill-fixture.spec.ts`
  are task-local acceptance helpers, not a replacement for repository tests.

The RFQ is already recommended/committed, PO issued, and serialized receipt
confirmed. Do not blindly replay RFQ creation, quotation conversion, receipt
confirmation or invoice submission. Read progress first. Financial records
were created through normal UI commands; database reads only located/status
checked those records. New data is deliberately retained as demo evidence.
No real bank payout was performed.

P3's original safe allocation/refusal/reversal fixtures remain separate under
`/var/tmp/agents-bosqa-p3`. Do not substitute arbitrary payments or rerun its
invoice-preparation fixture blindly. See `docs/p3-linux-runtime.md` for details.

Run browser suites after Testcontainers finish; network changes during temporary
container teardown caused one navigation error before app assertions began.
Ten conditional locale skips and fixture-gated browser checks are disclosed in
`docs/p4-issues.md`. Local green gates do not certify hosted CI.
