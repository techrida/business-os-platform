# Phase 0 Issues and Notes

- **Status:** Consolidated into `main`.
- **Scope:** Foundation shell, auth (ZITADEL), tenancy, database migrations, Caddy proxy, telemetry.
- **Open Issues:** None blocking.

## After P4 is merged into main

- [ ] Explore Prometheus queries and add metrics dashboards for the combined system. Cover request rates, errors, response-time percentiles, worker health and queue behavior. Start with Prometheus's built-in viewer; evaluate Grafana for reusable dashboards. Keep metrics access private and verify dashboard queries against the merged P4 behavior.

Phase-specific Prometheus study viewers can be used before that merge. The shared dashboard work above remains a post-P4 follow-up.
