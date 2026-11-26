# syntax=docker/dockerfile:1
#
# One image, two entry points: `node dist/main.js` (API, the default) and `node dist/worker.js`
# (BullMQ worker). It also carries the migration runner for the compose `migrate` job:
# `node node_modules/@bos/db/dist/migrate.js`.
#
# Build context is the REPO ROOT (the workspace needs pnpm-lock.yaml and packages/*):
#   docker build -f apps/api/Dockerfile -t bos/api:dev .

ARG NODE_IMAGE=node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9

# ---------------------------------------------------------------- build
FROM ${NODE_IMAGE} AS build
# CI=true stops pnpm from asking questions (there is no TTY in a build).
ENV CI=true
# Corepack is gone after Node 24, so pnpm comes from npm, installed from a lockfile (`npm ci`: integrity hashes).
# infra/pnpm-bootstrap pins the version; infra/pnpm-bootstrap.test.mjs keeps it equal to the root `packageManager`.
COPY infra/pnpm-bootstrap /pnpm-bootstrap
RUN npm ci --prefix /pnpm-bootstrap --ignore-scripts && ln -s /pnpm-bootstrap/node_modules/.bin/pnpm /usr/local/bin/pnpm
WORKDIR /repo

# 1. Manifests first: this layer (and the install below) is reused until a dependency changes.
#    Every workspace manifest is copied, or the frozen lockfile would not match the workspace.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/workspace/package.json apps/workspace/package.json
COPY apps/portal/package.json apps/portal/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/locale/package.json packages/locale/package.json
COPY packages/money-rules/package.json packages/money-rules/package.json
COPY packages/pdf-viewer/package.json packages/pdf-viewer/package.json
COPY tools/seed-zitadel/package.json tools/seed-zitadel/package.json
# `@bos/api...` = the API and the workspace packages it depends on, nothing else (no Next.js).
RUN --mount=type=cache,id=bos-pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --store-dir /pnpm-store --filter "@bos/api..."

# 2. Sources, then build: the workspace packages first (tsc), then the API (SWC via nest build).
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY packages/db packages/db
COPY packages/locale packages/locale
COPY packages/money-rules packages/money-rules
COPY apps/api apps/api
RUN pnpm --filter @bos/contracts --filter @bos/db --filter @bos/locale --filter @bos/money-rules run build \
 && pnpm --filter @bos/api run build \
 # Tests are compiled too; they import vitest, which is not in the production image. The test doubles and fixtures
 # the tests share (fake virus scanner, harness, fixtures) are compiled as well and must not ship. Source maps are
 # deleted too: nothing starts Node with --enable-source-maps (Kuu, OQ-R7-10 a).
 && find apps/api/dist \( -name '*.test.js*' -o -name '*.map' \
      -o -name 'users.fakes.js*' -o -name 'harness.js*' -o -name 'quotation.fixture.js*' \
      -o -name 'invoice-test-rows.js*' -o -name 'fake-clamd.js*' -o -name 'evidence.fixture.js*' \
      -o -name 'probe-clamd.js*' \) -delete

# 3. Production dependencies only. `--legacy` because pnpm 11's default deploy needs
#    `injectWorkspacePackages: true` in pnpm-workspace.yaml (a root file this image does not own).
RUN --mount=type=cache,id=bos-pnpm-store,target=/pnpm-store \
    pnpm --filter @bos/api --prod deploy --legacy --store-dir /pnpm-store /out

# The checks below turn a wrong layout into a build failure instead of a crash at runtime.
# The first one fails the build when a test double, fixture or source map is still in dist (a new test-support
# file needs its name in the delete above).
RUN test -z "$(find apps/api/dist \( -name '*.map' -o -name '*fake*' -o -name '*fixture*' -o -name 'harness.js*' \
      -o -name '*-test-rows.js*' -o -name 'probe-clamd.js*' -o -name '*.test.js*' \))" \
 && test -f apps/api/dist/main.js \
 && test -f apps/api/dist/worker.js \
 && test -f /out/node_modules/@bos/db/dist/index.js \
 && test -f /out/node_modules/@bos/contracts/dist/index.js \
 && test -f /out/node_modules/@bos/locale/dist/index.js \
 && test -f /out/node_modules/@bos/money-rules/dist/index.js

# ---------------------------------------------------------------- runtime
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Production node_modules from `pnpm deploy`, and the compiled API (copied from the build
# tree because deploy only packs files a package.json `files` list or ignore rules allow).
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/apps/api/package.json ./package.json
COPY --from=build --chown=node:node /repo/apps/api/dist ./dist
# The compose `migrate` job runs `node node_modules/@bos/db/dist/migrate.js` from this working directory: the deployed
# @bos/db package already carries its dist, its migrations folder and its `"type": "module"` package.json, so no
# second copy of packages/db is needed.

# Document storage (P1, StorageAdapter). A named volume mounted here copies this directory's
# owner on first use, so creating it as `node` lets the non-root api and worker write to it.
RUN mkdir -p /var/lib/bos/files && chown node:node /var/lib/bos/files

# Never run as root. The `node` user (uid 1000) ships with the official image.
USER node

# 3001 = API, 9464 = API metrics (internal network only), 9465 = worker metrics and /health.
EXPOSE 3001 9464 9465

# Healthcheck for the API. The worker (`node dist/worker.js`) and migrate job get their own
# in compose: the worker's checks :9465/health, which this one does not.
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=10 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.API_PORT||3001)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "dist/main.js"]
