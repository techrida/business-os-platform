# Business OS: phase P0 (Ground floor) implementation plan

This is a read-only plan: nothing was edited, built or run. I verified versions and licences on 2026-11-08 against the npm registry, the GitHub API and ZITADEL's official compose file at `zitadel/zitadel/main/deploy/compose/`. Anything I could not confirm is marked **[unverified]**. The advisor was rate-limited, so this plan has had no second review.

## 0. Findings that change the plan (read first)

1. **The WSL distro may break Kuu's own rule.** The rule says `Ubuntu` holds only the OS and Youanai packages, and an hourly job deletes npm caches and old scratch there. A Business OS clone, the pnpm store, Docker images and Postgres/ZITADEL volumes would break that rule or get cleaned away.
   - **Decision needed from Kuu:** put Business OS in its own distro (for example `BOS`, Ubuntu 26.04). Every command below writes it as `wsl -d BOS`.
2. **The repo is on `F:` (Windows).** `next dev` and `nest --watch` cannot watch files reliably over `/mnt/f` (9P has no inotify), and bind mounts from there are slow.
   - Develop from a clone on the WSL filesystem: `~/src/business-os-platform`, same origin.
   - The `F:` checkout stays for git and the architecture map only.
3. **`.gitignore` contains `.env*`.** That also ignores `.env.example`. The Foundation unit must change it to `.env*` plus `!.env.example`.
4. **ZITADEL v4 is two containers.** The API is `ghcr.io/zitadel/zitadel` and the separate Next.js Login V2 UI is `ghcr.io/zitadel/zitadel-login`.
   - Both containers share a bootstrap volume holding a login-client PAT.
   - The API must be reverse-proxied over **h2c** (gRPC/Connect).
   - `ZITADEL_EXTERNALDOMAIN`, `ZITADEL_EXTERNALPORT` and `ZITADEL_EXTERNALSECURE` must match the public URL exactly, or every request fails with "Instance not found".
   - Official guidance is at least 2 GB host RAM for the stack.
5. **ZITADEL access tokens are opaque by default.** For the API to verify tokens locally through JWKS:
   - The Workspace app and the k6 machine user must be set to the **JWT** access-token type.
   - The project must have "assert roles on authentication" turned on.
   - The seed tool owns all of this configuration.
6. **Newer majors already exist.** They don't change the fixed decisions, but there is a time limit:
   - NestJS: latest is **12.4.0**. 11.x is still patched (**11.2.8, 2026-10-23**).
   - Next.js: latest is **16.4.5**. 15.x is still patched (**15.5.29, 2026-11-03**).
   - Pin 11.x and 15.x and record an ADR to revisit at P2, before the client portal app is created.
7. **The model does not match the latest releases on two points.**
   - `architecture/model.js` says Valkey 8; the latest is 9.1.3.
   - It says Ubuntu 24.04 for the host. That is fine for production; dev is 26.04.
   - It has no `zitadel-login` container and no Mailpit.
   - A small follow-up edit to `model.js` would cover all three (it is not part of these units).
8. **Node version.** Node 24 entered maintenance on 2026-10-20 and is supported until 2028-04-30. Node 26 became Active LTS on 2026-10-28.
   - Pick **Node 24**: it matches the dev machine (v24.18) and is proven with Next 15 and Nest 11. Move to Node 26 together with the Next 16 / Nest 12 upgrade.

---

## 1. Repo layout

**Package manager: pnpm 11 (11.28.x, MIT, needs Node ≥ 22.13).**
- Strict `node_modules`, so no phantom dependencies.
- A content-addressed store saves disk. The WSL virtual disk sits on C:, so this matters.
- `workspace:` protocol, and recursive scripts run in topological order (`pnpm -r`).
- `--filter`, and `pnpm deploy --prod` for slim Docker images.
- Supply-chain settings: install scripts are blocked by default, plus `minimumReleaseAge`.
- npm workspaces were rejected: hoisting allows phantom deps, there is no `deploy`, and installs are slower.
- Pin it with `"packageManager": "pnpm@11.28.11"`.
- In Dockerfiles, install it with `npm i -g pnpm@<pin>`. Corepack is deprecated and gone after Node 24.

**Turborepo: no.** There are 5 workspaces, and `pnpm -r run build|typecheck|test` already orders them by their dependency graph. Remote caching is not worth another tool yet. Re-evaluate when CI wall time passes about 10 minutes.

```
business-os-platform/
├─ package.json              root scripts only (typecheck, lint, test, test:e2e, stack:*, seed, perf, drill)
├─ pnpm-workspace.yaml       apps/*, packages/*, tools/*; build-script allowlist; minimumReleaseAge
├─ pnpm-lock.yaml            generated once by Foundation; only the lead changes it afterwards
├─ tsconfig.base.json        strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes
├─ eslint.config.mjs         flat config: typescript-eslint typed rules + Next rules scoped to apps/workspace
├─ .prettierrc.json  .editorconfig  .nvmrc (24)
├─ .env.example              every env var, dev-safe placeholders, no secrets (owned by U1)
├─ .gitignore                + .dev/ .next/ dist/ coverage/ playwright-report/ !.env.example
├─ .github/workflows/ci.yml  typecheck, lint, unit, e2e, web build + no-switcher check, docker build
├─ architecture/             (existing) C4 system map, the source of truth for structure
├─ docs/
│  ├─ adr/                   0001 (existing) + 0002–0016 below
│  └─ runbooks/              dev-setup.md, restore-drill.md, perf-gates.md
├─ apps/
│  ├─ api/                   NestJS 11: HTTP API (src/main.ts) and worker (src/worker.ts), one image
│  │  ├─ src/platform/       config, obs, health, auth, tenancy, queue: the P0 kernel
│  │  ├─ src/modules/        business modules; P0 has only `me` and `telemetry`
│  │  ├─ test/e2e/           Testcontainers Postgres + in-process JWKS issuer
│  │  └─ Dockerfile          multi-stage, pnpm deploy, runs as non-root `node`
│  └─ workspace/             Next.js 15 staff app, backend-for-frontend (tokens never reach the browser)
│     ├─ src/app/            (app) shell, auth/* route handlers, dev/personas (dev-only), telemetry/vitals
│     ├─ src/lib/            oidc.ts, session.ts (Valkey), api.ts (server-side fetch with bearer)
│     ├─ e2e/                Playwright: `dev` project (personas) + `prod` project (no switcher, LCP)
│     ├─ scripts/            check-no-dev-routes.mjs
│     └─ Dockerfile          Next standalone output
├─ packages/
│  ├─ db/                    Drizzle schema, SQL migrations, migrate runner, tenancy check, scoped() helper
│  │  ├─ src/
│  │  └─ migrations/
│  └─ contracts/             Zod schemas + inferred types shared by api and workspace
├─ tools/
│  └─ seed-zitadel/          idempotent ZITADEL provisioning: project, roles, apps, orgs, personas, k6 user
├─ perf/
│  └─ k6/                    thresholds.js (NFR numbers), load.js, smoke.js
└─ infra/
   ├─ compose/               compose.yaml (base), compose.dev.yaml, compose.prod.yaml
   ├─ caddy/                 Caddyfile (hostnames and upstreams from env)
   ├─ postgres/              Dockerfile (pg16 + pgBackRest), init-dbs.sh, postgresql.conf, pgbackrest.conf
   ├─ backup/                backup.sh, restore-drill.sh
   └─ scripts/               export-dev-ca.sh, trust-dev-ca.ps1 (Windows user-store import, no admin)
```

Gitignored dev state lives in `.dev/`:
- `zitadel.env` (issuer, project id, client id);
- `personas.json` (usernames and passwords);
- `k6.env` (load-test client secret);
- `caddy-root.crt`.

---

## 2. Packages and libraries

Version means the pin line. "Latest" was checked on 2026-11-08.

### Runtime: API and worker (`apps/api`)
| Package | Version | Licence | Purpose | Rejected alternative |
|---|---|---|---|---|
| `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express` | 11.2.x | MIT | Modules, DI, guards | `@nestjs/platform-fastify`: faster, but Express 5 is the boring default, and the NFR (p95 < 300 ms) does not need Fastify |
| `reflect-metadata`, `rxjs` | 0.2.x, 7.x | Apache-2.0, Apache-2.0 | Nest peer dependencies | — |
| `@nestjs/terminus` | 11.1.1 | MIT | `/health/live`, `/health/ready` indicators | Hand-rolled endpoint (Terminus is small and standard) |
| `nestjs-pino`, `pino`, `pino-http` | 4.6.1, 10.x, 11.x | MIT | Structured JSON logs carrying the correlation id | `winston`: slower, and the model already names pino |
| `prom-client` | 15.1.3 | Apache-2.0 | Route latency histograms and `/metrics` | OpenTelemetry metrics, see the note below |
| `jose` | 6.2.x | MIT | JWT verification against a remote JWKS | `passport-jwt` + `jwks-rsa`: two extra layers; Passport adds nothing to one bearer check |
| `drizzle-orm` | 0.45.x (stable; 1.0 is still beta.22) | Apache-2.0 | Typed schema and queries; raw SQL through `sql` | Prisma: binary engine, heavier, weaker raw-SQL ergonomics; Kysely: no migration story |
| `pg` | 8.23.x | MIT | Postgres driver with pooling | `postgres` (postgres.js, Unlicense): fine, but `pg` is the most-used driver with Drizzle and Testcontainers |
| `zod` | 4.6.x | MIT | Env config, request validation (custom pipe), contracts | `class-validator`: decorators, duplicate types; Valibot: smaller ecosystem |
| `bullmq` | 5.81.x | MIT | Worker queues on Valkey (`@nestjs/bullmq` 11.0.5 accepts ^5 and ^6) | bullmq 6.x: new major, wait one phase. pg-boss: dropped by the fixed decision |
| `@nestjs/bullmq` | 11.0.5 | MIT | Nest wiring for BullMQ processors | Raw BullMQ `Worker` (acceptable fallback) |

**Why prom-client and not OpenTelemetry:**
- The blueprint's NFR table names a "Prometheus histogram".
- prom-client is one dependency and synchronous, gives exact bucket control and has no SDK bootstrap.
- The OTel JS Prometheus exporter and `sdk-node` are still 0.x-numbered (0.301.0). Auto-instrumentation adds startup time and memory, and there is no trace backend in P0.
- Downside: prom-client's last npm release was **June 2024**, although the repo (`prometheus/client_js`) was pushed 2026-11-01. Wrap it behind a `MetricsService` so a later switch to OTel touches one file.

### Runtime: Workspace (`apps/workspace`)
| Package | Version | Licence | Purpose | Rejected |
|---|---|---|---|---|
| `next`, `react`, `react-dom` | 15.5.x, 19.x | MIT | App Router, standalone output; `next/web-vitals` for LCP | — |
| `openid-client` | 6.8.x | MIT (panva, OpenID-certified, ESM-only) | Discovery, PKCE, code exchange, refresh, end-session | **next-auth/Auth.js v5**: still `5.0.0-beta.32`, and v4 does not fit the App Router. **better-auth**: wants to own users and sessions, which duplicates ZITADEL. **@zitadel SDKs**: tie us to ZITADEL and break the Keycloak fallback |
| `ioredis` | 5.x (same major BullMQ uses) | MIT | Server-side session store in Valkey | iron-session sealed cookie: ZITADEL JWT access, refresh and ID tokens approach the 4 KB cookie limit, and server-side sessions give idle/absolute timeouts and instant revocation (needed by P2 SCIM deprovisioning) |
| `zod` | 4.6.x | MIT | Validates the vitals payload and API responses | — |

### Tooling
| Package or tool | Version | Licence | Purpose | Rejected |
|---|---|---|---|---|
| `typescript` | 5.9.3 | Apache-2.0 | Strict TS | 6.0.3 and 7.0.x (Go-native): decorator-metadata support with Nest/SWC is unproven, so upgrade later |
| `@nestjs/cli`, `@swc/cli`, `@swc/core` | 11.0.x, 0.7.x, 1.16.x | MIT / Apache-2.0 | `nest start --watch` with SWC (emits decorator metadata) | `tsx watch`: esbuild drops `emitDecoratorMetadata`, which breaks Nest DI |
| `vitest`, `@vitest/coverage-v8` | 4.1.x **[unverified with 5.x: try 5.1 first; fall back to 4.1.12 if `unplugin-swc` breaks]** | MIT | Unit and e2e runner everywhere | **Jest**: jose 6 and openid-client 6 are ESM-only, which means transform/ESM friction |
| `unplugin-swc` | 2.0.0 | MIT | Decorator metadata under Vitest | — |
| `@nestjs/testing`, `supertest` | 11.2.x, 7.x | MIT | API e2e | — |
| `testcontainers`, `@testcontainers/postgresql` | 12.2.x (needs Node ≥ 22.22) | MIT | Throwaway Postgres 16 per e2e run | A shared compose Postgres: state leaks between runs and it needs the stack up in CI |
| `@playwright/test` | 1.65.x | Apache-2.0 | Web shell e2e, persona login, prod-no-switcher, LCP | Cypress: weaker multi-origin (ZITADEL login on another host) |
| `eslint`, `typescript-eslint`, `eslint-config-next`, `@eslint/eslintrc` | 9.39.x, 8.72.x, 15.5.x, 3.x | MIT | Lint (`eslint-config-next` 15 peers on ESLint ≤ 9, so not ESLint 10) | `next lint` (deprecated in 15.5) |
| `prettier` | 3.9.x | MIT | Formatting | Biome: fine, but one more decision |
| `tsx` | 4.x | MIT | Runs scripts without decorators (seed, checks) | — |
| `drizzle-kit` | 0.31.x | MIT | Generates SQL migrations; the committed SQL is the source | — |
| k6 (`grafana/k6:2.3.0` image) | 2.3.0 | AGPL-3.0, used only as a separate tool binary | Load tests with thresholds as exit gates | Artillery: weaker threshold semantics |

### Images
| Image | Pin | Licence | Notes |
|---|---|---|---|
| `postgres:16-bookworm` + `pgbackrest` 2.60 from the PGDG apt repo | 16.x | PostgreSQL / MIT | Custom Dockerfile in `infra/postgres`. ZITADEL v4 support for PG16 is **[unverified]**; its compose ships PG17 |
| `ghcr.io/zitadel/zitadel`, `ghcr.io/zitadel/zitadel-login` | v4.20.1 (2026-11-03) | AGPL-3.0, unmodified | Same tag for both |
| `valkey/valkey` | 9.1-alpine (9.1.3) | BSD-3 | BullMQ on Valkey 9 is **[unverified]**; fall back to 8.1 if the BullMQ tests fail |
| `caddy` | 2.11-alpine (2.11.9) | Apache-2.0 | `tls internal` for `*.localhost` |
| `axllent/mailpit` | v1.33 | MIT | Dev SMTP plus web UI |
| `prom/prometheus` (profile `obs`, optional) | 3.x **[unverified]** | Apache-2.0 | Only to view histograms; not needed for the gates |
| `louislam/uptime-kuma` (profile `ops`) | 2.x **[unverified]** | MIT | Polls `/health/ready` (the model puts monitoring in P0) |

---

## 3. Compose design

**Files**
- `infra/compose/compose.yaml`: base services, profiles, networks, volumes, healthchecks, limits.
- `compose.dev.yaml`: publishes Postgres and Valkey to 127.0.0.1 for apps run on the host; Caddy upstreams point at `host.docker.internal`; adds Mailpit.
- `compose.prod.yaml`: real domains, Caddy bound to `${BIND_ADDR}` (the Tailscale IP in P0), `restart: unless-stopped`, Postal later.
- Compose project name: `bos`. Root scripts wrap the `-f` flags: `pnpm stack:up` runs `docker compose -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml --profile core up -d --wait --wait-timeout 300`.

**Networks**
- `edge`: Caddy, ZITADEL login and API, app containers.
- `backend` (internal: true): Postgres, Valkey, API, worker, ZITADEL API, Mailpit.
- Caddy carries network aliases `auth.localhost`, `app.localhost` and `api.localhost`. Containers then reach the public issuer URL through Caddy, so the token issuer string matches everywhere.

**Profiles**
- `core` (P0): postgres, valkey, zitadel-api, zitadel-login, caddy, mailpit.
- `app` (P0, prod-like run): migrate (one-shot), api, worker, workspace.
- `tools` (P0, one-shot): seed-zitadel, k6, restore-drill.
- `obs` (optional): prometheus. `ops` (optional): uptime-kuma.
- Later: `files` (P1: clamav at about 1.2 GB, a memory risk), `mail` (P1 production: Postal + MariaDB), `pdf` (P2: gotenberg), `portal` (P2), `vportal` (P4).

### Services (limits use `deploy.resources.limits.memory`)
| Service | Profile | Image | Published (dev) | Volumes | Healthcheck | Mem limit |
|---|---|---|---|---|---|---|
| postgres | core | `bos/postgres:16` (local build) | 127.0.0.1:5432 | `pgdata`, `pgbackrest-repo`, `./infra/postgres/pgbackrest.conf:/etc/pgbackrest/pgbackrest.conf:ro`, init script | `pg_isready -U postgres -d bos` | 1024M (`shared_buffers=256MB`, `max_connections=100`) |
| valkey | core | valkey 9.1-alpine | 127.0.0.1:6379 | `valkey-data` | `valkey-cli ping` | 256M (`maxmemory 192mb`, `maxmemory-policy noeviction` as BullMQ requires, `appendonly yes`) |
| zitadel-api | core | zitadel v4.20.1, `start-from-init --masterkeyFromEnv` | none | `zitadel-bootstrap` (rw) | `["/app/zitadel","ready"]`, start_period 60s, retries 20 | 1024M at first; measure, then tighten (expect 300–600 MB **[unverified]**) |
| zitadel-login | core | zitadel-login v4.20.1 | none | `zitadel-bootstrap` (ro) | `node /app/healthcheck.mjs http://localhost:3000/ui/v2/login/healthy` | 512M |
| caddy | core | caddy 2.11-alpine | 127.0.0.1:80, 127.0.0.1:443 (see risk R4) | `caddy-data`, `caddy-config`, Caddyfile ro | `wget -qO- http://127.0.0.1:2019/config/` | 128M |
| mailpit | core (dev file) | mailpit v1.33 | via Caddy `mail.localhost` | none | `["/mailpit","readyz"]` **[unverified subcommand]** | 128M |
| migrate | app | `bos/api` image, `node packages/db/dist/migrate.js` | — | — | one-shot; api depends on `service_completed_successfully` | 256M |
| api | app | `bos/api` | none (Caddy `api.localhost`); metrics port 9464 internal only | — | `node -e "fetch('http://127.0.0.1:3001/health/live').then(r=>process.exit(r.ok?0:1))"` | 512M |
| worker | app | `bos/api`, `node dist/worker.js` | metrics 9465 internal | — | same pattern on `:9465/health` | 384M |
| workspace | app | `bos/workspace` | none (Caddy `app.localhost`) | — | fetch `:3000/healthz` | 512M |
| seed-zitadel | tools | `node:24-bookworm-slim` running the built tool | — | `zitadel-bootstrap` ro, `./.dev` rw, CA cert | one-shot | 256M |
| k6 | tools | `grafana/k6:2.3.0` | — | `./perf/k6:/perf:ro`, `./.dev/k6.env` | one-shot; exit 99 when a threshold fails | 512M |
| restore-drill | tools | `bos/postgres:16` | — | `pgbackrest-repo` ro, fresh `pgdata-drill` | one-shot | 1024M (transient) |

**Budget on a 9 GB WSL**
- `core` is about 3.1 GB of limits. Typical real use is about 1.8 GB.
- `core` + `app` is about 4.7 GB of limits.
- The normal dev loop is `core` plus apps run on the host: `next dev` about 1.2–1.5 GB, `nest start --watch` about 0.4 GB, Playwright Chromium about 0.6 GB, Testcontainers Postgres about 0.3 GB. That is about 6 GB worst case.
- Rule: never run the `app` profile, the dev servers and a `docker build` of Next at the same time. A Next build spikes about 2 GB.

### ZITADEL bootstrap (`zitadel-api` environment; variable names checked in `cmd/setup/steps.yaml` and the official compose)
- **Database:** `ZITADEL_DATABASE_POSTGRES_DSN` points at the `zitadel` database on the shared cluster. `init-dbs.sh` creates the `zitadel` role and database, plus `bos`, `bos_owner` (migrations) and `bos_app` (runtime DML).
- **Domain and TLS:**
  - `ZITADEL_EXTERNALDOMAIN=auth.localhost`, `ZITADEL_EXTERNALPORT=443`, `ZITADEL_EXTERNALSECURE=true`, `ZITADEL_TLS_ENABLED=false` (Caddy terminates TLS).
  - `ZITADEL_MASTERKEY`: 32 characters from `.env`. It can never be changed after first start, and it is part of the backup runbook.
- **First-instance human admin** (the model's "Bootstrap admin", retired in P1):
  - `ZITADEL_FIRSTINSTANCE_ORG_NAME=Techrida Staff`;
  - `ZITADEL_FIRSTINSTANCE_ORG_HUMAN_USERNAME` and `..._PASSWORD`, read from `.env`.
- **Machine user for provisioning:**
  - `ZITADEL_FIRSTINSTANCE_ORG_MACHINE_MACHINE_USERNAME=bos-bootstrap-sa`;
  - `ZITADEL_FIRSTINSTANCE_ORG_MACHINE_PAT_EXPIRATIONDATE` (2099 in dev; short in prod);
  - `ZITADEL_FIRSTINSTANCE_PATPATH=/zitadel/bootstrap/admin.pat`. The account is created with IAM_OWNER.
- **Login V2:**
  - `ZITADEL_FIRSTINSTANCE_LOGINCLIENTPATPATH=/zitadel/bootstrap/login-client.pat` and the `..._ORG_LOGINCLIENT_MACHINE_*` variables;
  - `ZITADEL_DEFAULTINSTANCE_FEATURES_LOGINV2_REQUIRED=true`, with `..._LOGINV2_BASEURI`, `ZITADEL_OIDC_DEFAULTLOGINURLV2` and `..._DEFAULTLOGOUTURLV2` all built on `https://auth.localhost/ui/v2/login/`;
  - `zitadel-login` gets `ZITADEL_API_URL=http://zitadel-api:8080`, `ZITADEL_SERVICE_USER_TOKEN_FILE`, `ZITADEL_SESSION_COOKIE_SECRET` and `CUSTOM_REQUEST_HEADERS=Host:auth.localhost,X-Forwarded-Proto:https`.
- **SMTP to Mailpit:** the seed sets it through the admin API, so it is idempotent. Default-instance SMTP environment variables are an alternative **[unverified names]**.

### Seeding (`tools/seed-zitadel`, run as `pnpm seed`, which calls `docker compose ... --profile tools run --rm seed-zitadel`)
The tool is idempotent: it looks each object up by name before creating it. It authenticates with `admin.pat`, uses the v2 APIs where they are GA in v4.20 and falls back to management v1 for projects and apps **[verify which are GA]**.
1. Project `business-os`, with roles `founder`, `management`, `finance`, `sales`, `customer_user`, `vendor_user` and "assert roles on authentication" turned on.
2. Workspace OIDC app:
   - Web, code flow, auth method NONE + PKCE;
   - **access token type JWT**;
   - redirect `https://app.localhost/auth/callback`, post-logout `https://app.localhost/`.
3. Organisations: `Dev Customer Co` and `Dev Vendor Co`. The staff org is the first-instance org. Each org gets a project grant where needed.
4. Six personas:
   - Founder, Management, Finance and Sales in Staff;
   - Customer user in Dev Customer Co;
   - Vendor user in Dev Vendor Co.
   - Each is a human user with its email verified and a role grant.
   - Passwords come from `.dev/personas.json` when it exists. Otherwise they are generated (24 random characters) and written there. The file is gitignored.
   - MFA is not enforced in P0. When P1 enforces AAL2, the seed must register TOTP and Playwright must generate codes (otplib).
5. Machine user `bos-loadtest`: client credentials with the JWT access-token type and role `sales`. Its secret goes to `.dev/k6.env`.
6. Machine user `bos-provisioner` with ORG_USER_MANAGER on Staff. P1 uses it for staff invites; IAM_OWNER is not handed out.
7. Writes `.dev/zitadel.env`: `OIDC_ISSUER`, `OIDC_AUDIENCE` (project id), `OIDC_CLIENT_ID`, plus each org id. It also upserts the matching `organizations` rows through `DATABASE_MIGRATE_URL`, recording ZITADEL org id → tenant/org.

**Production note:** delete `admin.pat` and the bootstrap service account once setup is finished. The model already marks z-bootstrap as retiring at P1.

### Caddy dev hostnames (`tls internal`, upstreams from env)
| Host | Routes to |
|---|---|
| `auth.localhost` | `/ui/v2/login*` → `zitadel-login:3000`; `/` → rewrite to `/ui/v2/login/`; everything else → `reverse_proxy h2c://zitadel-api:8080` |
| `app.localhost` | `{$WORKSPACE_UPSTREAM}`: `host.docker.internal:3000` in dev, `workspace:3000` in `app` |
| `api.localhost` | `{$API_UPSTREAM}` (`host.docker.internal:3001` or `api:3001`); sets `header_up X-Request-Id {http.request.uuid}`; blocks `/metrics` |
| `mail.localhost` | `mailpit:8025` |

- Caddy sets `extra_hosts: host.docker.internal:host-gateway`.
- `infra/scripts/export-dev-ca.sh` copies Caddy's root certificate (`/data/caddy/pki/authorities/local/root.crt`) to `.dev/caddy-root.crt`.
- Node processes run with `NODE_EXTRA_CA_CERTS=.dev/caddy-root.crt`.
- `trust-dev-ca.ps1` runs `certutil -addstore -user Root` so Windows browsers trust it.

### Env contract (owned by U1 in `.env.example`; every unit uses these exact names)
`POSTGRES_PASSWORD`, `BOS_DB_OWNER_PASSWORD`, `BOS_DB_APP_PASSWORD`, `ZITADEL_DB_PASSWORD`, `DATABASE_URL` (bos_app), `DATABASE_MIGRATE_URL` (bos_owner), `VALKEY_URL`, `OIDC_ISSUER` (`https://auth.localhost`), `OIDC_AUDIENCE`, `OIDC_CLIENT_ID`, `OIDC_REDIRECT_URI`, `WORKSPACE_PUBLIC_URL`, `API_INTERNAL_URL`, `API_PORT` (3001), `METRICS_PORT` (9464 api / 9465 worker), `LOG_LEVEL`, `ZITADEL_MASTERKEY`, `ZITADEL_LOGIN_COOKIE_SECRET`, `ZITADEL_ADMIN_USERNAME`, `ZITADEL_ADMIN_PASSWORD`, `WORKSPACE_UPSTREAM`, `API_UPSTREAM`, `BIND_ADDR`, `NODE_EXTRA_CA_CERTS`, `BOS_DEV_PERSONAS_FILE` (`.dev/personas.json`).

---

## 4. API skeleton (`apps/api`)

**One image, two entry points**
- `main.ts`: HTTP on `API_PORT`, plus metrics on `METRICS_PORT`.
- `worker.ts`: a Nest application context (no HTTP router) with BullMQ processors and its own small health and metrics server.
- Both load `PlatformCoreModule`: config, obs, db and queue.

### P0 modules (file contract: path → exported symbol)
| Module | Path | Contents |
|---|---|---|
| Config | `src/platform/config/config.module.ts` → `ConfigModule`, `AppConfig` | Zod-parsed `process.env`, frozen, fails fast at boot. **Production rules:** `OIDC_ISSUER` must be `https:` and not loopback; there are no "dev" or "auth off" switches at all. No `@nestjs/config`: Zod does the work |
| Obs | `src/platform/obs/obs.module.ts` → `ObsModule`, `MetricsService` | nestjs-pino with redaction (`authorization`, `cookie`, `*.password`); a correlation middleware; the prom-client registry on the separate metrics port. Histogram `http_server_request_duration_seconds{method,route,status_class}` (route = Nest route template, never the raw URL), buckets `[0.025,0.05,0.1,0.2,0.3,0.5,0.8,1,2,5]` so the NFR edges 0.3/0.5/0.8 are bucket bounds. Plus `web_vitals_lcp_seconds{app,route}` buckets `[0.5,1,1.5,2,2.5,4,8]`, and default process metrics |
| Health | `src/platform/health/health.module.ts` → `HealthModule` | `/health/live` (process only) and `/health/ready` (db `select 1`, Valkey ping, JWKS fetched at least once). Both `@Public()` |
| Db | `src/platform/db/db.module.ts` → `DbModule`, `DB` token | `pg.Pool` from `DATABASE_URL` → `drizzle()`. Transaction helper |
| Queue | `src/platform/queue/queue.module.ts` → `QueueModule` | BullMQ connection; a repeatable `system.heartbeat` job (worker processes it and updates a gauge `worker_last_heartbeat_seconds`) |
| Auth | `src/platform/auth/auth.module.ts` → `AuthModule`, `JwtVerifier`, `AuthGuard`, `Public` | See the guard design below |
| Tenancy | `src/platform/tenancy/tenancy.module.ts` → `TenancyModule`, `RequestContext`, `ctx()` | AsyncLocalStorage context plus a resolver |
| Me | `src/modules/me/me.module.ts` → `MeModule` | `GET /v1/me` returns a `MeResponse` from `@bos/contracts` |
| Telemetry | `src/modules/telemetry/telemetry.module.ts` → `TelemetryModule` | `POST /v1/telemetry/vitals` (authenticated; body ≤ 2 KB; route label checked against an allowlist, otherwise `other`) |

### Guard design
- `AuthGuard` is registered as `APP_GUARD`, so **everything is denied by default**. `@Public()` is the only opt-out, used by the health routes. `/metrics` is not on the HTTP router at all.
- Steps:
  1. Read only `Authorization: Bearer`; anything else gets a 401.
  2. Call `jwtVerify(token, createRemoteJWKSet(jwksUri, {cooldownDuration:30_000, cacheMaxAge:600_000}), {issuer: OIDC_ISSUER, audience: OIDC_AUDIENCE, algorithms:['RS256'], clockTolerance: 30, requiredClaims:['sub','exp','iat']})`.
  3. Map the claims: `sub`, `urn:zitadel:iam:user:resourceowner:id` (org) and the roles from `urn:zitadel:iam:org:project:roles` **[verify the claim names in v4.20 and the scopes needed: `urn:zitadel:iam:org:project:id:{id}:aud`, `urn:zitadel:iam:user:resourceowner`]**.
  4. The tenancy resolver maps the ZITADEL org id to an `organizations` row: `{tenantId, organizationId, orgKind}`. This is cached in memory for 60 s. An unknown org gets a 403.
- **No bypass, by construction:**
  - The guard reads no environment flags.
  - There is no header other than `Authorization`.
  - Tests point `OIDC_ISSUER` at an in-process test JWKS: the same verification path with a different trusted key. Production config rejects such an issuer.
  - A Vitest "no-bypass" test scans `apps/api/src/**` for `x-dev`, `x-test-user`, `bypass`, `SKIP_AUTH`, `AUTH_DISABLED` and for any `process.env` read in `platform/auth`, and fails on any match.
- P0 does not check permissions; that is P1 `k-authz`. The `orgKind` and `roles` already sit in the context for P1.

### Request context (`RequestContext`)
`{ correlationId, tenantId, organizationId, orgKind: 'staff'|'customer'|'vendor', userId /* ZITADEL sub */, roles: readonly string[], tokenExp }`
- Middleware opens the AsyncLocalStorage store with `correlationId`. It takes an incoming `x-request-id` only if it matches `^[A-Za-z0-9-]{8,64}$`, otherwise it generates `randomUUID()`, and it echoes the id in the response header.
- The guard fills in the identity fields.
- pino-http's `genReqId` reads the same id.
- `ctx()` throws when it is called outside a request.

### Tenancy in the database (`packages/db`)
- Migration `0000` creates:
  - schema `app` with `tenants(id)`;
  - `organizations(id, tenant_id, organization_id /* = id, self */, kind, name, zitadel_org_id unique)`;
  - schema `ops` with `restore_canary(id, written_at)`.
- Grants: `bos_app` gets DML on `app` and SELECT/INSERT on `ops`; `bos_owner` owns everything.
- `check-tenancy.ts` queries `information_schema` after migrating. Every table in `app` must have `tenant_id uuid NOT NULL` and `organization_id uuid NOT NULL`. Allowlist: `tenants` only. It runs in the db tests and in CI.
- `scoped(db, {tenantId, organizationId})` returns `where`/`values` helpers that always add both ids. P1 repositories must use it.

---

## 5. Testing strategy

| Layer | Tool | What it proves | Command (repo root, WSL clone) |
|---|---|---|---|
| Unit | Vitest (+ `unplugin-swc` for Nest) | Config rules, verifier (bad alg, wrong issuer, wrong audience, expired, `none`), correlation id, metrics labels, scoped helper, no-bypass scan, dev-route checker on a fixture | `pnpm test` (runs `pnpm -r --if-present run test`, i.e. `vitest run` in each package) |
| DB integration | Vitest + `@testcontainers/postgresql` (`postgres:16-alpine`) | Migrations apply to an empty DB; tenancy check passes; the check fails on a fixture table without the columns | `pnpm --filter @bos/db test` |
| API e2e | Vitest + Nest `createNestApplication` + supertest + Testcontainers + in-process JWKS server (jose `generateKeyPair`) | 401 with no token, a forged token or a foreign issuer; 401 when the fake bypass headers are sent; 200 `/v1/me` for staff with tenant/org/correlation id; customer token gives `orgKind: customer`; unknown org gives 403; `/health/ready` 200; **route sweep: every non-`@Public` route found through `DiscoveryService` answers 401 without a token** (the start of the "100% deny test" NFR) | `pnpm --filter @bos/api test:e2e` |
| Web e2e (dev) | Playwright project `dev` against `next dev` + `core` stack + seed | Each of the six personas signs in through the real ZITADEL Login V2 form; staff land in the shell; customer and vendor see the "staff only" page; logout ends the session | `pnpm --filter @bos/workspace e2e` |
| Web e2e (prod) | Playwright project `prod` (`webServer`: `next build && next start -p 3100`) | `/dev/personas` returns 404; signed-in shell LCP < 1500 ms through a `PerformanceObserver` (needs the stack for login; the 404 test does not) | `pnpm --filter @bos/workspace e2e:prod` |
| Build artifact | `apps/workspace/scripts/check-no-dev-routes.mjs` | After `next build`: no `/dev/` key in `.next/server/app-paths-manifest.json`, and zero hits for `BOS_DEV_PERSONA_SWITCHER` anywhere in `.next/` | `pnpm --filter @bos/workspace build && node apps/workspace/scripts/check-no-dev-routes.mjs` |
| Load | k6 2.3.0 in the `tools` profile, through Caddy (`api.localhost`) | Thresholds come from `perf/k6/thresholds.js`: reads `p(95)<300`, `p(99)<800`; writes `p(95)<500`; `http_req_failed rate<0.01`. Scenario: 50 constant virtual users for 3 min over `GET /v1/me` (read) and `POST /v1/telemetry/vitals` (write stand-in until P1), plus a 10 req/s arrival-rate burst. The token comes from `bos-loadtest` client credentials (a real token) | `pnpm perf:load` (runs `docker compose ... --profile tools run --rm k6 run /perf/load.js`; exit 99 means a threshold failed) |
| Backup | `infra/backup/restore-drill.sh` | Restore works and is timed (RTO evidence) | `pnpm drill` |

- **LCP:** a `next/web-vitals` `useReportWebVitals` client component sends a `sendBeacon` to the Workspace route `/telemetry/vitals`. That handler requires a session, validates with Zod and forwards to the API with the bearer token, so there is no public API endpoint.
- The LAN gate is the Playwright LCP assertion.
- Lighthouse CI (Apache-2.0) is deferred to P2 for the portal's 4G target.
- Login p95 ≤ 500 ms (ZITADEL) is recorded in P1 with Playwright timing; it is not a P0 gate.

---

## 6. Work split

**Waves**
- **Wave 0:** Foundation, alone.
- **Wave 1:** six parallel units.
- **Wave 2:** two units that need wave 1's outputs.

The brief asked for 4–6 units of about 6 files. P0 is about 60 files, so it does not fit in 6 × 6. Two waves keep each unit at about 6–9 small files with one deliverable.

**Rules for every unit**
- Do not touch root files or `pnpm-lock.yaml`. If a dependency is missing, report it; the lead adds it and re-locks.
- Do not run heavy jobs: no builds, full suites, compose, Docker or Playwright. Hand back the command.
- Focused checks are allowed: lint of the named files and `vitest run <one file>`.
- Use the env names in §3 and the module paths in §4 exactly.

**Notation:** `W "<cmd>"` means `wsl -d BOS --cd ~/src/business-os-platform -e bash -lc "<cmd>"`. The lead runs each one as:
`C:/Users/kuu/.agents/bin/heavy -Kind <kind> -GB <n> -Cwd "F:\Projects\Techrida\Business-OS\business-os-platform" -Command "W ..."`

### F0: Foundation (wave 0) · impl-worker · Sonnet
- **Owns:**
  - root `package.json` (scripts: `typecheck`, `lint`, `test`, `test:e2e`, `stack:up|down|logs`, `seed`, `perf:load`, `drill`, `format`);
  - `pnpm-workspace.yaml` (with `minimumReleaseAge` and a build allowlist for `@swc/core` and `esbuild`; the pnpm 11 key name is **[unverified]**);
  - `pnpm-lock.yaml`, `tsconfig.base.json`, `eslint.config.mjs`, `.prettierrc.json`, `.editorconfig`, `.nvmrc`, `.gitignore` fix;
  - per workspace (`apps/api`, `apps/workspace`, `packages/db`, `packages/contracts`, `tools/seed-zitadel`): `package.json` with **every P0 dependency from §2**, `tsconfig.json`, a `vitest.config.ts` stub and a placeholder `src/index.ts`;
  - `packages/contracts/src/{me.ts,vitals.ts,error.ts,index.ts}`.
- **Success:** a clean install, `typecheck`, `lint` and `test` pass on the skeleton. `.env.example` is no longer ignored (`git check-ignore .env.example` exits 1).
- **Heavy check:** `-Kind install -GB 2`: `W "pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test"`.

### U1: Infra stack (wave 1) · impl-worker · Sonnet
- **Owns:** `infra/compose/{compose.yaml,compose.dev.yaml,compose.prod.yaml}`, `infra/caddy/Caddyfile`, `infra/postgres/{Dockerfile,init-dbs.sh,postgresql.conf}`, `infra/scripts/{export-dev-ca.sh,trust-dev-ca.ps1}`, `.env.example`.
- **Contract with U2:**
  - the Dockerfile installs `pgbackrest`;
  - `postgresql.conf` sets `archive_mode=on`, `archive_command='pgbackrest --stanza=bos archive-push %p'`, `archive_timeout=60`, `wal_level=replica`;
  - compose mounts `infra/postgres/pgbackrest.conf` (U2's file) and the volume `pgbackrest-repo:/var/lib/pgbackrest`.
- **Success:**
  - all `core` services are healthy within 5 minutes;
  - `https://auth.localhost/.well-known/openid-configuration` returns `"issuer":"https://auth.localhost"` both from the host and from inside a container on `edge`;
  - the sum of limits is ≤ 3.2 GB;
  - a Windows browser opens the ZITADEL login at `https://auth.localhost` with no certificate warning after `trust-dev-ca.ps1`.
- **Heavy check:** `-Kind docker -GB 4`: `W "pnpm stack:up && bash infra/scripts/export-dev-ca.sh && curl -s --cacert .dev/caddy-root.crt --resolve auth.localhost:443:127.0.0.1 https://auth.localhost/.well-known/openid-configuration | jq -r .issuer && docker run --rm --network bos_edge -v $PWD/.dev:/c curlimages/curl -s --cacert /c/caddy-root.crt https://auth.localhost/.well-known/openid-configuration && docker stats --no-stream"`.

### U2: Data and backups (wave 1) · impl-worker · Sonnet
- **Owns:** `packages/db/{drizzle.config.ts, src/schema/platform.ts, src/client.ts, src/migrate.ts, src/scoped.ts, src/check-tenancy.ts, src/*.test.ts, migrations/0000_platform.sql}`, `infra/postgres/pgbackrest.conf`, `infra/backup/{backup.sh,restore-drill.sh}`, `docs/runbooks/restore-drill.md`.
- **Drill script steps:**
  1. Write a canary row with `now()`.
  2. Take a full backup (on first run, `stanza-create` comes first).
  3. Run `pg_switch_wal()` and wait for the archive.
  4. Start a throwaway `restore-drill` container on an empty volume and run `pgbackrest --stanza=bos --delta restore --type=immediate --target-action=promote`.
  5. Start Postgres and assert the canary exists, the `zitadel` database has its eventstore tables, and `app.organizations` has a row count greater than 0.
  6. Print `{"result":"pass","rto_seconds":N}`, tear down, and exit non-zero on any failure.
- **Success:** db tests are green (migrations plus the tenancy check, including a failing fixture); the drill prints pass against the running `core` stack.
- **Heavy checks:**
  - `-Kind test -GB 2`: `W "pnpm --filter @bos/db test"`.
  - `-Kind docker -GB 2`: `W "bash infra/backup/backup.sh full && bash infra/backup/restore-drill.sh"` (needs U1 merged).

### U3: API runtime (wave 1) · impl-worker · Sonnet
- **Owns:** `apps/api/src/{main.ts, worker.ts, app.module.ts, worker.module.ts}`, `src/platform/{config,obs,health,db,queue}/**` with unit tests, `apps/api/nest-cli.json`, `apps/api/Dockerfile`.
- `app.module.ts` imports `AuthModule`, `TenancyModule`, `MeModule` and `TelemetryModule` from the §4 paths. Those files are U4's, so U3's focused checks import its own modules, not `AppModule`.
- **Success:**
  - unit tests pass for the config production rules, the correlation id and the histogram labels/buckets;
  - the image builds;
  - the container serves `/health/live` 200 and metrics on `:9464` with `http_server_request_duration_seconds_bucket`;
  - the worker logs a heartbeat.
- **Heavy check:** `-Kind build -GB 3`: `W "pnpm --filter @bos/api test -- src/platform && docker build -f apps/api/Dockerfile -t bos/api:dev ."`.

### U4: API auth, tenancy and e2e (wave 1) · impl-worker · Sonnet (auth: Opus review afterwards)
- **Owns:** `apps/api/src/platform/{auth,tenancy}/**`, `apps/api/src/modules/{me,telemetry}/**`, `apps/api/test/e2e/**` (JWKS helper, setup, `auth.e2e.test.ts`, `route-sweep.e2e.test.ts`), `apps/api/vitest.e2e.config.ts`, `apps/api/src/platform/auth/no-bypass.test.ts`.
- **Success:** all the e2e cases in §5 pass. The route sweep finds at least 2 protected routes and every one returns 401. The no-bypass scan is green.
- **Heavy check:** `-Kind test -GB 2`: `W "pnpm --filter @bos/api test:e2e"`.

### U5: Workspace shell and OIDC (wave 1) · impl-worker · Sonnet (auth: Opus review afterwards)
- **Owns:**
  - `apps/workspace/next.config.ts` (`output:'standalone'`; `pageExtensions` = `['dev.tsx','dev.ts','tsx','ts']` only when `NODE_ENV==='development'`, otherwise `['tsx','ts']`);
  - `src/lib/{oidc.ts,session.ts,api.ts}`;
  - `src/app/{layout.tsx,(app)/layout.tsx,(app)/page.tsx,staff-only/page.tsx,healthz/route.ts}`;
  - `src/app/auth/{login,callback,logout}/route.ts`;
  - `src/app/telemetry/vitals/route.ts`, `src/components/web-vitals.tsx`;
  - `apps/workspace/Dockerfile`.
- **Session design:**
  - cookie `__Host-bos_session`: Secure, HttpOnly, SameSite=Lax, Path=/;
  - value: 256-bit random id;
  - Valkey record `ws:sess:<id>` holds `{sub, orgId, orgKind, roles, accessToken, refreshToken, accessExp, createdAt, lastSeenAt}`;
  - idle timeout 1 h (sliding), absolute 24 h;
  - PKCE verifier, state and nonce stored at `ws:oidc:<state>` for 10 minutes;
  - every handler sets `runtime='nodejs'`;
  - OIDC discovery is lazy, so `next start` boots without ZITADEL;
  - `login_hint` is passed through.
- **Success:** `next build` passes. Manually, with `core` up, the seed done and `next dev` running, signing in through ZITADEL lands on the shell and shows `/v1/me` data. A customer persona lands on `/staff-only`.
- **Heavy check:** `-Kind build -GB 3`: `W "pnpm --filter @bos/workspace build && docker build -f apps/workspace/Dockerfile -t bos/workspace:dev ."`.

### U6: ZITADEL seed and k6 (wave 1) · impl-worker · Sonnet
- **Owns:** `tools/seed-zitadel/src/{index.ts,zitadel-client.ts,personas.ts,outputs.ts}`, `tools/seed-zitadel/README.md`, `perf/k6/{thresholds.js,load.js,smoke.js}`, `docs/runbooks/perf-gates.md`.
- **Success:**
  - the first run creates everything in the §3 list and writes `.dev/*`;
  - a second run reports "no changes";
  - a token from `bos-loadtest` decodes as a JWT with the project audience;
  - `load.js` exits 0 against the `app` profile;
  - with `K6_READ_P95_MS=1` it exits 99, which proves the gate can fail.
- **Heavy check:** `-Kind docker -GB 3`: `W "pnpm seed && pnpm seed && pnpm perf:load && (K6_READ_P95_MS=1 pnpm perf:load; test $? -eq 99)"` (needs U1, U3, U4 and the `app` profile up).

### U7: Persona switcher and Playwright (wave 2) · test-writer · Sonnet
- **Owns:**
  - `apps/workspace/src/app/dev/personas/page.dev.tsx`, which lists the personas from `BOS_DEV_PERSONAS_FILE`, renders the marker `data-marker="BOS_DEV_PERSONA_SWITCHER"`, links to `/auth/login?login_hint=<u>&prompt=login`, and calls `notFound()` unless `NODE_ENV==='development'`;
  - `apps/workspace/playwright.config.ts`;
  - `apps/workspace/e2e/{helpers/zitadel-login.ts, personas.spec.ts, prod-no-switcher.spec.ts, lcp.spec.ts}`;
  - `apps/workspace/scripts/check-no-dev-routes.mjs`, plus its Vitest fixture test.
- **Success:**
  - all six personas sign in through real OIDC;
  - the prod project shows 404 and LCP < 1500 ms;
  - the checker passes on a prod build;
  - **the checker fails** on a build forced to include dev pages (one-off proof) and on its fixture.
- **Heavy checks:**
  - `-Kind browser -GB 3`: `W "pnpm --filter @bos/workspace e2e && pnpm --filter @bos/workspace e2e:prod"`;
  - `-Kind build -GB 3`: `W "pnpm --filter @bos/workspace build && node apps/workspace/scripts/check-no-dev-routes.mjs"`.

### U8: CI workflow (wave 2) · impl-worker · Sonnet; ADRs · batch-editor · Haiku (parallel, `docs/adr/` only)
- **CI owns:** `.github/workflows/ci.yml`.
  - `permissions: contents: read`; concurrency group with cancel-in-progress.
  - Job `checks`: install, typecheck, lint, unit.
  - Job `e2e`: `pnpm --filter @bos/db test` and `pnpm --filter @bos/api test:e2e` (Testcontainers on `ubuntu-24.04`, Docker preinstalled).
  - Job `web`: build, checker, Playwright prod 404 test only (no ZITADEL in CI).
  - Job `docker`: buildx builds of both images, `push:false`, GHA cache.
  - No `continue-on-error`. Remove `--passWithNoTests` from the e2e configs.
- **CI success:** `actionlint` is clean. A real run is green, and a deliberately failing test turns it red.
- **CI check:** `actionlint` is light. The real proof is pushing a branch and a draft PR with a broken test, which **needs Kuu's OK to push**.
- **ADRs own:** `docs/adr/0002…0016.md` from §7.

**Security review:** after wave 1, have one reviewer agent on **Opus** read U4 + U5 (and U7 after wave 2) together for token handling, cookie flags, open redirects on `returnTo`, logging of secrets, and the no-bypass invariant.

---

## 7. ADRs P0 needs (two-line decisions)

- **0002 Monorepo tooling.** pnpm 11 workspaces with topological `-r` scripts; no Turborepo. Revisit caching when CI passes about 10 minutes.
- **0003 Runtime and language.** Node 24 LTS (maintenance until 2028-04) and TypeScript 5.9 strict. The Nest app stays CommonJS and loads ESM-only jose through Node 24's `require(esm)`.
- **0004 API shape.** NestJS 11 modular monolith on Express; the API and the BullMQ worker are two entry points of one image. Upgrade to Nest 12 alongside Next 16 at P2.
- **0005 Data access.** Drizzle 0.45 + `pg`, with raw SQL for ledger and reports. Committed SQL migrations run as a one-shot `migrate` job under a separate owner role from the runtime role.
- **0006 Tenancy columns and semantics.** Every `app.*` table has `tenant_id` + `organization_id NOT NULL` from 0000, enforced by a CI schema check. Tenant = SaaS account; organization = owning org. How customer/vendor visibility columns work is decided in P1 (open question, see R9).
- **0007 Identity provider deployment.** ZITADEL v4.20.1 (API + Login V2), unmodified, behind Caddy with h2c, using its own database on the shared cluster. JWT access tokens and roles asserted in tokens; the API verifies through JWKS with jose.
- **0008 Workspace authentication.** Backend-for-frontend with openid-client v6 (code + PKCE) and server-side sessions in Valkey behind a `__Host-` cookie. Tokens never reach the browser; Auth.js v5 beta and better-auth were rejected.
- **0009 Dev personas without bypass.** Six seeded ZITADEL users sign in through real OIDC from a dev-only `page.dev.tsx` that is excluded by `pageExtensions` in production. The API has no bypass header or flag, and a build check plus a Playwright test prove it.
- **0010 Observability.** pino logs with a correlation id, plus prom-client histograms on an internal metrics port with buckets aligned to the NFRs. Switch to OTel when tracing is needed (behind `MetricsService`).
- **0011 Performance gates.** k6 thresholds are the NFR table, in one file, and exit non-zero on a breach. LCP comes from web-vitals RUM plus a Playwright LCP assertion; Lighthouse CI waits for P2.
- **0012 Test stack.** Vitest everywhere, Testcontainers Postgres for the db and API e2e, Playwright for the web. Jest was rejected over ESM friction.
- **0013 Compose topology.** One base file plus dev/prod overrides, profiles per phase, and memory limits that fit 9 GB. Dev runs on `*.localhost` through Caddy `tls internal`, with the CA trusted by Node and Windows.
- **0014 One Postgres cluster.** Business and ZITADEL databases live in one PG16 cluster with separate roles. That saves memory and gives one consistent PITR across both.
- **0015 Backups.** pgBackRest with WAL archiving to a local repo and a scripted, timed restore drill. An S3 `repo2` (B2) is added before production; restic for files arrives in P1.
- **0016 CI gates.** GitHub Actions runs typecheck, lint, unit, db + API e2e, the web build with the no-switcher check, and the image builds; required to merge. Actions are pinned to major versions now and to SHAs by Dependabot later.

---

## 8. Risks

| # | Risk | Effect | Mitigation |
|---|---|---|---|
| R1 | **ZITADEL memory and startup.** `start-from-init` on an empty DB runs migrations and projections, so the first boot is slow (often 30–90 s, **[unverified]**). Memory is unknown (the blueprint could not confirm it). Login V2 is a second Node process | Healthcheck flapping; `--wait` timeouts; less room in 9 GB | `start_period` 60 s, retries 20, `--wait-timeout 300`. Limit 1 GB, then measure with `docker stats` during seed + k6 and record the number in ADR 0007. Use the official `prodlike` split (init / setup / start) in production. Keycloak stays the fallback |
| R2 | **The issuer URL must be identical in every view.** Browser, Next server, API and k6 must all see `https://auth.localhost` | "Instance not found", or `iss` mismatches leading to 401s | Caddy network aliases plus `NODE_EXTRA_CA_CERTS`; U1's in-container curl check. Do not use an internal `http://zitadel-api` issuer. Whether musl/glibc in containers resolves `*.localhost` through Docker DNS is **[unverified]**; U1 proves it |
| R3 | **Next.js 15 + OIDC.** openid-client v6 is ESM-only and needs the Node runtime. Next 15 `cookies()` is async; middleware defaults to edge. Next 15 is no longer the current major | Edge-runtime crashes; a backport window that may close | Every auth handler sets `runtime='nodejs'`. No auth in middleware; the check happens in the `(app)` server layout. ADR to move to Next 16 at P2 |
| R4 | **WSL networking and file watching.** Watching `/mnt/f` fails. Windows to WSL `localhost:443` depends on WSL localhost forwarding (NAT vs mirrored) | Dev servers don't reload; the browser can't reach Caddy | Work from the ext4 clone. Set `networkingMode=mirrored` in `.wslconfig` if forwarding fails **[unverified on this PC]**. Fallback: `WATCHPACK_POLLING=true` and `CHOKIDAR_USEPOLLING=1` only if needed |
| R5 | **WSL distro policy** (finding 0.1) | Kuu's hourly clean wipes the caches, or the rule is broken | A dedicated distro. Docker volumes grow the WSL virtual disk on C:, so add a `stack:nuke` script and document `docker system df` checks |
| R6 | **Caddy local CA trust** across Windows browsers, Node in containers, Node on the host and Playwright's Chromium | TLS errors in OIDC discovery or JWKS | Export script plus the `certutil -user` import. `NODE_EXTRA_CA_CERTS` everywhere; Playwright uses `ignoreHTTPSErrors:false` and the cert is imported via `--ignore-certificate-errors-spki-list` or trusted in the system store. Fallback: an HTTP issuer in dev was rejected because `__Host-` cookies need Secure |
| R7 | **ZITADEL claim names and the access-token type.** The project role claim, the resourceowner claim, JWT for machine users and v2 vs v1 APIs for project/app creation are **[unverified]** for v4.20 | The guard reads empty roles or org; seed failures | U6 prints one decoded token per persona into the handback; U4 builds its claim mapping in one function backed by test fixtures |
| R8 | **ZITADEL Login V2 selectors** used by the Playwright helper | Flaky persona tests after a ZITADEL bump | Pin the image tag. Use role/label selectors in one helper file. Re-run U7 on every ZITADEL upgrade |
| R9 | **Tenant vs organization semantics.** ZITADEL orgs are customer and vendor companies; business rows are owned by Techrida's org. P0 puts `orgKind` in the context, but which org id a customer query filters on is undecided | A wrong scoping model baked into P1 repositories | Decide in ADR 0006 before P1 starts. P0 `scoped()` takes explicit ids and does not infer them |
| R10 | **Shared files across parallel units:** the lockfile, `app.module.ts` imports, the env names | Merge conflicts; integration typecheck failures | Foundation declares all dependencies; units never edit root files. Contract tables in §3 and §4; the lead merges wave 1 in the order F0 → U1 → U2 → U3 → U4 → U5 → U6 |
| R11 | **Stale dependencies:** prom-client has had no release since 2024-06; Valkey 9 with BullMQ 5 is unproven; `pnpm-workspace` key names changed in pnpm 11 | Silent breakage | `MetricsService` seam; BullMQ heartbeat test in U3; fall back to Valkey 8.1; F0 verifies its pnpm settings with a clean install |
| R12 | **The persona switcher leaks into production** through a misconfigured `NODE_ENV` | Credentials page exposed | Three walls: `pageExtensions`, `notFound()` and the build checker in CI. Persona passwords live only in gitignored `.dev/`; the production image never copies `.dev/` (`.dockerignore` owned by F0) |
| R13 | **The k6 write stand-in.** P0 has no real write endpoint, so `/v1/telemetry/vitals` stands in. 10 approvals/s can only be tested in P1 | The P0 write gate is weaker than it looks | Say so in `perf-gates.md`; P1 replaces it with approve/reject |
| R14 | **Masterkey and backups.** pgBackRest restores the ZITADEL database, but without `ZITADEL_MASTERKEY` the encrypted data is unusable | A restore that "passes" but can't log anyone in | The restore runbook lists the masterkey and `.env` as backup items (offsite later). A full-stack drill (log in after restore) arrives in P1 |

---

## 9. Integration: what the lead runs on the combined branch, in order

| Kind / GB | Command | What it proves |
|---|---|---|
| install / 2 | `W "pnpm install --frozen-lockfile"` | The lockfile matches every package |
| typecheck / 2 | `W "pnpm typecheck && pnpm lint"` | The contracts line up (`app.module` imports, contracts types) |
| test / 2 | `W "pnpm test && pnpm --filter @bos/db test && pnpm --filter @bos/api test:e2e"` | Unit, tenancy check, auth e2e, route sweep, no-bypass |
| docker / 4 | `W "pnpm stack:up && bash infra/scripts/export-dev-ca.sh && pnpm seed && pnpm seed"` | Stack healthy; seed is idempotent; `.dev/*` written |
| docker / 4 | `W "docker compose -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml --profile core --profile app up -d --wait"` | Migrate, API, worker and workspace images run behind Caddy |
| browser / 3 | `W "pnpm --filter @bos/workspace e2e && pnpm --filter @bos/workspace e2e:prod"` | Six personas over real OIDC; prod 404; LCP < 1.5 s |
| build / 3 | `W "pnpm --filter @bos/workspace build && node apps/workspace/scripts/check-no-dev-routes.mjs"` | Production artifact has no switcher |
| docker / 3 | `W "pnpm perf:load"`, then the same with `K6_READ_P95_MS=1` | NFR gates pass, and fail when they should (exit 99) |
| docker / 2 | `W "bash infra/backup/backup.sh full && pnpm drill"` | Restore drill passes, with RTO seconds printed |
| (push) | Push a branch and a draft PR, then a commit with `expect(1).toBe(2)` | CI is green, then red. Needs Kuu's approval to push |
| docker / 1 | `W "pnpm stack:down"` | Frees RAM after QA |

**P0 exit check from `model.js`:** "Admin logs in through ZITADEL over Tailscale; /health is green; a restore drill passes."
- The dev branch covers the last two items plus the login.
- "Over Tailscale" is only true on the office server, with `compose.prod.yaml` and `BIND_ADDR` set to the Tailscale IP. Report it as not verified until that box exists.

**Files read:**
- `F:\Projects\Techrida\_analysis\business-os\BLUEPRINT.md` (§3, §5, §6, §7)
- `F:\Projects\Techrida\_analysis\business-os\REQUIREMENTS-AND-STACK.md`
- `F:\Projects\Techrida\Business-OS\business-os-platform\architecture\model.js`
- `F:\Projects\Techrida\Business-OS\business-os-platform\README.md`
- `F:\Projects\Techrida\Business-OS\business-os-platform\.gitignore`
- `F:\Projects\Techrida\Business-OS\business-os-platform\docs\adr\0001-system-map-format.md`

P-stack fits: `/pstack:poteto-mode P0 ground floor`, then `/pstack:blast-radius` before merging wave 1 (shared contracts) and `/pstack:verify-commands` to check that the CI and k6 gates really fail.