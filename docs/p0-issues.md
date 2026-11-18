# Phase 0 Issues and Notes

- **Status:** Consolidated into `main`.
- **Scope:** Foundation shell, auth (ZITADEL), tenancy, database migrations, Caddy proxy, telemetry.
- **Open Issues:** None blocking.

## After P4 is merged into main

- [ ] Explore Prometheus queries and add metrics dashboards for the combined system. Cover request rates, errors, response-time percentiles, worker health and queue behavior. Start with Prometheus's built-in viewer; evaluate Grafana for reusable dashboards. Keep metrics access private and verify dashboard queries against the merged P4 behavior.

Phase-specific Prometheus study viewers can be used before that merge. The shared dashboard work above remains a post-P4 follow-up.

## Study completed, 2026-11-17

Kuu marked P0 study complete and moved to P1. No new P0 study-blocking follow-up was found in the submitted D13-D21 answers; their owners are P2-P4 or post-P4. This is study completion, not evidence that every deployment decision is settled, a full phase PR merged, or production is ready. Domains, key custody and office-network access remain deployment questions for the deployment stage.

D16's old proposed 12-week build schedule is retired as historical, not silently re-approved as a new timeline. Original questions and provenance stay in the decision register.
