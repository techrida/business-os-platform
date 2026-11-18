# P1 Prometheus runtime

Private viewer: https://host.example.net:8511/
Study guide: https://host.example.net:8500/bos-p1/prometheus.html

The preserved real P1 exporters are `bos-p1-api-1` and `bos-p1-worker-1`
on `bos-p1_backend`. This starts only Prometheus; never run the whole dev
overlay against P1 because it has P0 application port defaults.

From this checkout, with the existing P1 runtime env kept outside Git:

```sh
PROMETHEUS_BIND_ADDR=127.0.0.1 PROMETHEUS_PORT=19091 docker compose \
  -p bos-p1 --env-file ~/.an assistant/worktrees/bos-p1/.env \
  -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml \
  --profile obs up -d --no-deps prometheus
systemd-run --user --unit=bos-p1-prometheus-viewer \
  /usr/bin/docker wait bos-p1-prometheus-1
```

The transient unit waits for the container lifetime. It grants no boot startup.
After it exits, reset/recreate the unit before sharing a restarted container.
Register `bos-p1-prometheus` with dev-share as stateless, target
`http://127.0.0.1:19091`, HTTPS8511, unit
`bos-p1-prometheus-viewer.service`, health path `/-/ready`. Stop its dev-share
registration before deliberately stopping this container. No app restart,
seeding, migration, authentication change or Grafana installation is required.

Verified 2026-11-16: both scrape targets UP; private HTTPS instant `up` and
range query returned 1 for both jobs; selected HTML guide served. API and
worker start times remained unchanged. Production base/overlay source unchanged.
A separate physical private network device and browser interaction were not tested.
