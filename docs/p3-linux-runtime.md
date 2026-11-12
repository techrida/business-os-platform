# Phase 3 Linux runtime handoff

Run all project commands in Ubuntu WSL with Linux Node 24 and pnpm, after
`source infra/scripts/env.sh`. The Windows host resource queue may wrap a WSL
payload; native Windows project execution is not supported. The shared verification
order is P2 -> P3 -> P4: obtain the current owner's explicit release before
switching the shared source or starting a stack on the shared ports.

## What changed on 2026-11-12

The scheduled WSL scratch cleaner removed every `/var/tmp/agents-*` runtime
folder, including the earlier P3 scripts, loaders, fixture inputs and the
`p3-before-upgrade.dump` backup under `/var/tmp/agents-bosqa-p3` (confirmed absent).
The `bos-qa-p2-4` volumes remain, but their secrets are gone and their database
now carries P4 migrations; do not point P3 code at them. Keep runtimes under
`~/private-runtimes`, which the cleaner does not touch.

## Isolated P3 stack: `bos-p3v`

- Source: detached WSL worktree `~/private-runtimes/p3v` (from the shared clone
  `~/src/business-os-platform`), with its own `.env` from
  `infra/scripts/make-dev-env.sh` and its own `.dev` seed output. Never copy
  another stack's secrets.
- Images: `bos-p3v/api:dev` and `bos-p3v/workspace:dev` (production builds);
  override file `~/private-runtimes/p3v-images.yaml`.
- Compose project `bos-p3v`. Every command needs `COMPOSE_PROJECT_NAME=bos-p3v`
  and the override:

```bash
export COMPOSE_PROJECT_NAME=bos-p3v
cd ~/private-runtimes/p3v && source infra/scripts/env.sh
dc() { docker compose --env-file .env -f infra/compose/compose.yaml \
  -f infra/compose/compose.dev.yaml -f ~/private-runtimes/p3v-images.yaml "$@"; }
```

Bring-up from zero (each heavy step through the host queue):

1. `git worktree add --detach ~/private-runtimes/p3v <p3-main sha>`;
   `pnpm install --frozen-lockfile`; `bash infra/scripts/make-dev-env.sh`;
   create an empty `.dev/caddy-root.crt` placeholder.
2. `dc --profile core --profile files up -d --wait`, then copy the Caddy root CA
   from the caddy container to `.dev/caddy-root.crt`
   (`infra/scripts/export-dev-ca.sh` hard-codes project `bos`).
3. `bash infra/scripts/migrate-dev.sh` (includes the tenancy check);
   `pnpm --filter ./tools/seed-zitadel build`;
   `dc --profile tools run --rm seed-zitadel > .dev/seed.log`. The seed's
   only manual note is the known "Actions webhook DeniedURL" caveat.
4. Build both images, then with
   `WORKSPACE_UPSTREAM=workspace:3000 API_UPSTREAM=api:3001` run
   `dc --profile core --profile files --profile app up -d --wait api worker workspace gotenberg`
   and recreate caddy (`dc --profile core up -d --force-recreate --no-deps caddy`).
5. A fresh seed has no department, and memos need one. Add a "General"
   department in one audited transaction as system actor
   `p3-qa-fixture-general-department` and assign it only to memberships with no
   department (same SQL as P2's `bos-p2v` note in
   [p2-linux-runtime.md](p2-linux-runtime.md)).

The production workspace image returns 404 for `/dev/*`, so the browser checks
sign in through real ZITADEL password plus TOTP from `.dev/personas.json`.
The portal image was not built or started in this round (see p3-issues.md).

Browser checks run from `~/private-runtimes/p3v/apps/workspace`:

```bash
BASE_URL=https://app.localhost pnpm exec playwright test --project=dev \
  exit.spec.ts inbox.spec.ts personas.spec.ts p3/ --reporter=line \
  --output=$HOME/private-runtimes/p3v-browser/<run>
BASE_URL=https://app.localhost pnpm exec playwright test --project=prod --reporter=line
```

P3 specs that need records read `BOS_E2E_INVOICES_READY`,
`BOS_E2E_INVOICE_ISSUED`, `BOS_E2E_PAYMENT_VERIFIED` and
`BOS_E2E_PAYMENT_CUSTOMER`; without them they skip, and a skip is not a pass.
Create those records only through real application commands with distinct
approvers. Financial writes in specs use explicit disposable identifiers.

Keep a foreground WSL process alive while the stack runs; WSL idle shutdown has
stopped stacks before. Stop with `dc --profile core --profile files --profile app stop`
(volumes kept) before another phase uses ports 80, 443, 5432, 6379, 1025 and 3310.

Credentials stay in `~/private-runtimes/p3v/.env` and `.dev` (mode 600) and in
server processes; never print or commit them.

## Plans and decision defaults

```text
/mnt/f/Projects/Life/life-kb/Techrida/Yes/business-os/docs/platform/P3-BUILD-PLAN.md
/mnt/f/Projects/Life/life-kb/Techrida/Yes/business-os/docs/platform/OPEN-DECISIONS.md
```

Kuu authorized recommended defaults for unanswered blocking decisions: keep the
subledger, VAT-slice reconciliation, permission-gated Finance drafts, portal
visibility, evidence requirements and distinct approvers. Local demo
configuration does not establish accountant certification or authorize payouts.
