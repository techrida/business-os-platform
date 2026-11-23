# syntax=docker/dockerfile:1
FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS dependencies

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
COPY infra/login/patches/login.patch infra/login/patches/otp.patch infra/login/patches/design.patch infra/login/patches/footer.patch infra/login/patches/theme.patch infra/login/patches/reset.patch /tmp/
RUN git apply --check /tmp/login.patch /tmp/otp.patch \
    && git apply /tmp/login.patch /tmp/otp.patch \
    && git apply --check /tmp/design.patch \
    && git apply /tmp/design.patch \
    && git apply /tmp/footer.patch \
    && git apply /tmp/theme.patch \
    && git apply /tmp/reset.patch
COPY infra/login/overlay/ apps/login/
COPY packages/locale/src/theme-mode.ts apps/login/src/lib/
COPY apps/workspace/src/styles/tokens.css apps/workspace/src/styles/token-overrides.css apps/login/src/styles/

FROM overlay AS test
# The upstream API tests generate a temporary RSA fixture using the OpenSSL CLI.
RUN apk add --no-cache openssl
COPY infra/login/patches/otp-tests.patch infra/login/patches/reset-tests.patch /tmp/
RUN git apply --check /tmp/otp-tests.patch /tmp/reset-tests.patch \
    && git apply /tmp/otp-tests.patch /tmp/reset-tests.patch
RUN pnpm --filter @zitadel/login test-unit --maxWorkers=4

FROM overlay AS build
ENV NEXT_PUBLIC_BASE_PATH=/ui/v2/login \
    NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @zitadel/login build

# Match the upstream standalone image layout, user, environment and entrypoint.
FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5
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
