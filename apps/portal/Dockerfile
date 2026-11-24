# syntax=docker/dockerfile:1
#
# Customer portal (Next.js standalone output; copied from apps/workspace/Dockerfile). Build context is the monorepo root:
#   docker build -f apps/portal/Dockerfile -t bos/portal:dev .
#
# Stage 1 installs and builds inside the monorepo. Stage 2 copies only Next's traced output,
# so the runtime image has no pnpm, no source and no dev dependencies.

FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS build
# Corepack is deprecated, so pnpm comes from npm, installed from a lockfile (`npm ci`: integrity hashes).
# infra/pnpm-bootstrap pins the version; infra/pnpm-bootstrap.test.mjs keeps it equal to the root `packageManager`.
COPY infra/pnpm-bootstrap /pnpm-bootstrap
RUN npm ci --prefix /pnpm-bootstrap --ignore-scripts && ln -s /pnpm-bootstrap/node_modules/.bin/pnpm /usr/local/bin/pnpm
WORKDIR /repo
ENV NEXT_TELEMETRY_DISABLED=1 CI=1

# The whole context is copied (see .dockerignore) instead of only the package.json files:
# a partial copy makes the frozen lockfile disagree with the workspaces that are present.
COPY . .

# `portal...` means the portal app and everything it depends on (@bos/contracts).
# The cache mount keeps downloaded packages between builds; it is not part of the image.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store --filter "@bos/portal..."

# Builds @bos/contracts first (its dist is what Next resolves), then `next build`.
RUN pnpm --filter "@bos/portal..." build

# The app has no public/ yet, and COPY fails on a missing path. Creating it here keeps the
# runtime stage the same whether or not public/ exists.
RUN mkdir -p apps/portal/public


FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    # Docker sets HOSTNAME to the container id, and the standalone server binds to it.
    # Without this override it would not listen on the container's network interface.
    HOSTNAME=0.0.0.0
WORKDIR /app

# With outputFileTracingRoot at the monorepo root, the standalone folder mirrors the repo:
# server.js sits at apps/portal/server.js. Static files and public/ are not traced, so
# they are copied into the same app folder.
COPY --from=build --chown=node:node /repo/apps/portal/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/portal/.next/static ./apps/portal/.next/static
COPY --from=build --chown=node:node /repo/apps/portal/public ./apps/portal/public

USER node
EXPOSE 3000

# The slim image has no curl or wget, so use Node's own fetch. 127.0.0.1 (not localhost):
# localhost may resolve to ::1 while the server listens on IPv4.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# Path not yet confirmed by a build: check `ls apps/portal/.next/standalone/apps/portal`.
CMD ["node", "apps/portal/server.js"]
