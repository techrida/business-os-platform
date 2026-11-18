# syntax=docker/dockerfile:1
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS dependencies

WORKDIR /src
RUN apk add --no-cache git \
    && git clone --depth=1 --branch v4.20.1 https://github.com/zitadel/zitadel.git . \
    && test "$(git rev-parse HEAD)" = 709968cdd4257d7377bb95f22c840ee39ba951c6 \
    && corepack enable pnpm

COPY infra/login/patches/dependencies.patch /tmp/
RUN git apply --check /tmp/dependencies.patch \
    && git apply /tmp/dependencies.patch \
    && pnpm --filter @zitadel/zitadel --filter @zitadel/login... install --frozen-lockfile \
    && pnpm --filter @zitadel/proto generate \
    && pnpm --filter @zitadel/client build

FROM dependencies AS overlay
COPY infra/login/patches/login.patch infra/login/patches/otp.patch /tmp/
RUN git apply --check /tmp/login.patch /tmp/otp.patch \
    && git apply /tmp/login.patch /tmp/otp.patch
COPY infra/login/overlay/ apps/login/
COPY apps/workspace/src/styles/tokens.css apps/workspace/src/styles/token-overrides.css apps/login/src/styles/
COPY apps/workspace/src/components/shell/brand.tsx apps/workspace/src/components/shell/brand.module.css apps/login/src/components/shell/
COPY apps/workspace/src/components/ui/icon.tsx apps/login/src/components/ui/
COPY apps/workspace/src/lib/nav.ts apps/login/src/lib/

FROM overlay AS build
ENV NEXT_PUBLIC_BASE_PATH=/ui/v2/login \
    NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @zitadel/login build

# Match the upstream standalone image layout, user, environment and entrypoint.
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
WORKDIR /app
RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs \
    && mkdir -p /.env-file \
    && touch /.env-file/.env \
    && chown -R nextjs:nodejs /.env-file

COPY --from=build --chown=nextjs:nodejs /src/apps/login/.next/standalone ./
COPY --from=build /src/apps/login/LICENSE /app/LICENSE.zitadel-login

USER nextjs
ENV HOSTNAME="::" \
    PORT="3000" \
    NODE_ENV="production" \
    NODE_OPTIONS="--use-openssl-ca --require /app/load-ssl-cert-dir.cjs" \
    SSL_CERT_FILE="/etc/ssl/certs/ca-certificates.crt" \
    ZITADEL_TLS_ENABLED="false" \
    OTEL_SERVICE_NAME="zitadel-login" \
    OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD ["/usr/local/bin/node", "/app/healthcheck.mjs", "/ui/v2/login/ready"]
ENTRYPOINT ["/app/entrypoint.sh", "node", "apps/login/server.js"]
