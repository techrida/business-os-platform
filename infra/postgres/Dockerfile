# Postgres 16 + pgBackRest (from the PGDG apt repository that the official image already configures).
# Build context is infra/postgres. U2 owns pgbackrest.conf (mounted at run time, not baked in).
FROM postgres:16-bookworm@sha256:ce3efec6bc404f6b15ebf5d9bed6b45a9d4655aea238d7dacc3467ccb05a1175

# Debian's own pgbackrest is old (2.44); PGDG carries 2.60. The glob pins the minor version.
ARG PGBACKREST_VERSION=2.60
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends "pgbackrest=${PGBACKREST_VERSION}.*"; \
    rm -rf /var/lib/apt/lists/*; \
    install -d -o postgres -g postgres -m 0750 /var/lib/pgbackrest /var/log/pgbackrest /var/spool/pgbackrest; \
    install -d -o postgres -g postgres -m 0755 /etc/pgbackrest; \
    pgbackrest version

# Baked in (not bind-mounted) so the script is executable: a non-executable .sh in initdb.d is *sourced*,
# which would leak `set -u` into the image's entrypoint.
COPY --chmod=0644 postgresql.conf /etc/postgresql/postgresql.conf
COPY --chmod=0755 init-dbs.sh /docker-entrypoint-initdb.d/10-init-dbs.sh
