# Getting started

Set up a local development environment for Business OS on Linux or WSL2. When you finish, the core infrastructure runs in Docker Compose behind Caddy over HTTPS, database migrations and ZITADEL roles are seeded, and the API, worker, staff workspace, and portal respond on `https://*.localhost`.

## Prerequisites

Install these tools before you start:

- Linux or Ubuntu on WSL2. On WSL2, keep your clone on the native Linux filesystem rather than a mounted Windows drive so Docker binds and file watchers stay fast and reliable.
- Node.js 24 (`>=24.0.0`, see `.nvmrc`).
- pnpm 11 (`11.29.0`, pinned in `package.json`).
- Docker Engine with Compose v2 (`docker compose`).
- OpenSSL (used to generate random local secrets).

On Ubuntu, you can install Docker, Node.js 24, and pnpm 11 with the setup script:

```bash
bash infra/scripts/dev-machine-setup.sh
```

If you used that script, load the project Node 24 environment in each new shell before running `pnpm`:

```bash
source infra/scripts/env.sh
```

## 1. Create the environment file

Generate `.env` from `.env.example` with fresh random development secrets:

```bash
bash infra/scripts/make-dev-env.sh
```

The script copies `.env.example` to `.env` with mode `600`, replaces every placeholder secret, and adds required keys (`VALKEY_PASSWORD`, `SESSION_ENC_KEY`, `PORTAL_SESSION_ENC_KEY`, `DOCS_LINK_SECRET`, `FIELD_ENC_KEYS`, `PGBACKREST_REPO1_CIPHER_PASS`, and `RESTIC_PASSWORD`) without overwriting keys you already set. It is safe to run again after pulling new environment variables.

Keep these rules in mind:

- Never commit `.env`. Only `.env.example` belongs in git.
- Do not change `ZITADEL_MASTERKEY` (exact 32 characters) or `PGBACKREST_REPO1_CIPHER_PASS` after first boot. Existing encrypted ZITADEL records and pgBackRest backups cannot be read with a different key.
- Every `docker compose` command must pass `--env-file .env` from the repository root because Compose resolves relative paths from `infra/compose/`. The `pnpm stack:*` scripts pass this flag for you.

## 2. Install packages and build

Install workspace dependencies and compile the shared packages and seed CLI:

```bash
pnpm install --frozen-lockfile
pnpm build
```

`pnpm build` compiles `@bos/contracts`, `@bos/db`, `@bos/locale`, `@bos/money-rules`, `@bos/seed-zitadel`, `@bos/api`, `@bos/workspace`, and `@bos/portal` in dependency order.

`pnpm install` also points git at `.githooks` (`core.hooksPath`), so every `git push` runs `tools/check-public-repo.mjs` on what is pushed and refuses internal files, private hostnames and `*wip-t3-*` branches. Skip it in an emergency with `git push --no-verify`.

## 3. Start the infrastructure stack

Start the `core` Compose profile:

```bash
pnpm stack:up
```

This builds the PostgreSQL 16 image (with pgBackRest) and the custom ZITADEL Login V2 image, then starts `postgres`, `backup-scheduler`, `valkey`, `valkey-oidc`, `zitadel-api`, `zitadel-login`, `caddy`, and `mailpit`. First startup takes 2 to 5 minutes while ZITADEL initializes its database.

To include ClamAV antivirus scanning for document uploads, start with the `files` profile instead (ClamAV requires roughly 1.8 GiB of container memory and downloads signatures on first boot):

```bash
pnpm stack:up:files
```

### Compose profiles reference

| Profile | Services                                                                                                          | Purpose                                                                 |
| ------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `core`  | `postgres`, `backup-scheduler`, `valkey`, `valkey-oidc`, `zitadel-api`, `zitadel-login`, `caddy`, `mailpit` (dev) | Required backing services and local HTTPS proxy                         |
| `files` | `clamav`                                                                                                          | Optional antivirus scanner for uploaded files (`127.0.0.1:3310` in dev) |
| `app`   | `migrate`, `api`, `worker`, `workspace`, `portal`, `gotenberg`                                                    | Containerized application services and PDF renderer                     |
| `tools` | `seed-zitadel`, `k6`, `restore-drill`                                                                             | One-shot provisioning, load testing, and backup restore drills          |
| `obs`   | `prometheus`                                                                                                      | Optional local Prometheus scraper (`127.0.0.1:19090` in dev)            |

## 4. Export and trust the local CA certificate

Caddy terminates HTTPS for `*.localhost` using its own internal Certificate Authority (CA). Export the root certificate to `.dev/caddy-root.crt`:

```bash
bash infra/scripts/export-dev-ca.sh
```

Node processes read this file via `NODE_EXTRA_CA_CERTS=.dev/caddy-root.crt` (already set in `.env`).

Trust `.dev/caddy-root.crt` in your browser so HTTPS pages load without warnings:

- **Linux**: Add `.dev/caddy-root.crt` to your system trust store (for example `/usr/local/share/ca-certificates/bos-caddy-root.crt` followed by `sudo update-ca-certificates`) and import it in Firefox if Firefox does not use enterprise roots.
- **macOS**: Import `.dev/caddy-root.crt` into Keychain Access and set it to Always Trust.
- **Windows with WSL2**: Run `powershell -ExecutionPolicy Bypass -File infra/scripts/trust-dev-ca.ps1` from PowerShell and restart your browser. For Firefox, import the file under **Certificates > Authorities** or set `security.enterprise_roots.enabled` to `true` in `about:config`.

If you delete the `caddy-data` Docker volume, Caddy generates a new CA and you must repeat this step.

## 5. Run database migrations and seed ZITADEL

Apply all Drizzle SQL migrations and run the tenancy schema check against local PostgreSQL (`127.0.0.1:5432`):

```bash
bash infra/scripts/migrate-dev.sh
```

Provision the ZITADEL project, roles, OIDC applications (Workspace and Portal), organizations, development personas, and Mailpit email provider:

```bash
pnpm seed
```

`pnpm seed` is idempotent and writes generated OIDC client IDs, webhook keys, and development personas to git-ignored files under `.dev/`:

- `.dev/zitadel.env` (OIDC issuer, audience, Workspace client ID, organisation ids; no secrets)
- `.dev/zitadel-api.env` (provisioner token and actions signing key; read by the API and the worker only)
- `.dev/zitadel-portal.env` (Portal client ID)
- `.dev/personas.json` (development persona definitions used by the dev-only account switcher)
- `.dev/k6.env` (machine-user credentials for `pnpm perf:load`)

Verify the core stack, OIDC issuer resolution, PostgreSQL, Valkey, and Mailpit:

```bash
bash infra/scripts/check-core.sh
```

## 6. Run the applications

Choose either host development servers (faster iteration) or containerized services (closer to production).

### Option A: Run apps on the host

The development Compose overlay configures Caddy to forward `app.localhost` to `host.docker.internal:3000`, `api.localhost` to `host.docker.internal:3001`, and `portal.localhost` to `host.docker.internal:3002`.

Load `.env` and `.dev/zitadel.env` in each terminal before starting a process:

```bash
set -a
source .env
source .dev/zitadel.env
set +a
```

Start each service in its own terminal. The API and the worker also need the identity secrets, so load `.dev/zitadel-api.env` in those two terminals only (the web apps never get it):

```bash
# Terminal 1: NestJS HTTP API (listens on 0.0.0.0:3001)
set -a; source .dev/zitadel-api.env; set +a
pnpm --filter @bos/api start:dev

# Terminal 2: BullMQ background worker (metrics on :9465)
set -a; source .dev/zitadel-api.env; set +a
pnpm --filter @bos/api start:worker

# Terminal 3: Staff Workspace (bind 0.0.0.0 so Caddy can reach it)
pnpm --filter @bos/workspace dev -- -H 0.0.0.0
```

For the Customer and Vendor Portal, also load `.dev/zitadel-portal.env` after `.dev/zitadel.env` so the portal gets its own `OIDC_CLIENT_ID` and `SESSION_ENC_KEY`:

```bash
# Terminal 4: Customer and Vendor Portal (port 3002)
set -a
source .env
source .dev/zitadel.env
source .dev/zitadel-portal.env
export SESSION_ENC_KEY="$PORTAL_SESSION_ENC_KEY"
export SESSION_ENC_KEY_ID="$PORTAL_SESSION_ENC_KEY_ID"
export OIDC_REDIRECT_URI="https://portal.localhost/auth/callback"
set +a
pnpm --filter @bos/portal dev -- -H 0.0.0.0
```

Note that quotation, invoice, and purchase order PDF generation requires Gotenberg. To enable PDF rendering while running apps on the host, start the `gotenberg` container from the `app` profile or run Option B.

### Option B: Run apps in Docker containers

Build the application images first:

```bash
docker build -f apps/api/Dockerfile -t bos/api:dev .
docker build -f apps/workspace/Dockerfile -t bos/workspace:dev .
docker build -f apps/portal/Dockerfile -t bos/portal:dev .
```

Start the `core` and `app` profiles with Caddy pointing at container upstreams:

```bash
WORKSPACE_UPSTREAM=workspace:3000 API_UPSTREAM=api:3001 PORTAL_UPSTREAM=portal:3000 \
  docker compose --env-file .env -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml \
  --profile core --profile app up -d --wait --wait-timeout 300
```

You can also run `bash infra/scripts/app-up.sh` to start the API, worker, and workspace containers and verify their health endpoints.

## Local endpoints

| Service                    | URL                        | Notes                                                             |
| -------------------------- | -------------------------- | ----------------------------------------------------------------- |
| Staff Workspace            | `https://app.localhost`    | Redirects unauthenticated browsers to ZITADEL login               |
| Customer and Vendor Portal | `https://portal.localhost` | Customer pages at `/`, vendor pages at `/vendor`                  |
| HTTP API                   | `https://api.localhost`    | Health checks at `/health/live` and `/health/ready`               |
| Identity provider          | `https://auth.localhost`   | Login V2 UI at `/`, ZITADEL console at `/ui/console`              |
| Email catcher              | `https://mail.localhost`   | Captures all outbound development mail (SMTP on `127.0.0.1:1025`) |

## Stopping and resetting

Stop all running containers while keeping database and backup volumes intact:

```bash
pnpm stack:down
```

Follow logs from the core and app containers:

```bash
pnpm stack:logs
```

To wipe every container and Docker volume (database, backups, ZITADEL state, uploaded files, and Caddy CA) and start completely fresh:

```bash
BOS_CONFIRM_NUKE=yes pnpm stack:nuke
```

## Troubleshooting

- **ZITADEL shows "Instance not found".** Always use `https://auth.localhost` with no port number. ZITADEL matches requests against its initialized external domain (`AUTH_HOST`).
- **Caddy returns 502 on `app.localhost` or `portal.localhost`.** Verify that the host dev server is running and bound to `0.0.0.0` (`-H 0.0.0.0`), not `127.0.0.1`.
- **Node fails with `self-signed certificate in certificate chain`.** Confirm `.dev/caddy-root.crt` exists (`bash infra/scripts/export-dev-ca.sh`) and `NODE_EXTRA_CA_CERTS=.dev/caddy-root.crt` is exported in your shell.
- **PostgreSQL logs archive command warnings on a fresh stack.** Before the first backup runs, PostgreSQL may log WAL archive errors until pgBackRest initializes its stanza (`bash infra/backup/backup.sh full`).
- **A container fails to become healthy.** Inspect container logs with `docker compose --env-file .env -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml --profile core logs --tail 100 <service>`.

## Next steps

- Read [Architecture](architecture.md) to see how the API, worker, portals, ZITADEL, and PostgreSQL fit together.
- Read [Features](features.md) for a module-by-module overview of roles and workflows.
