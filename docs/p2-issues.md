# P2 study issues and decisions

## Resolved policy choices, verify implementation in P2

- D18: a signed quotation is the default evidence for marking a deal Won. Reconcile the evidence setting and its P3 reuse. Policy confirmed 2026-11-17; code conformity not audited here.

## Follow-ups when studying P2

- D17: explain Tenant (hosted customer account), Organization (legal entity) and Party (customer/vendor company). ADR 0027 currently shares parties across legal entities in the same tenant; it does not deduplicate unrelated tenants globally. A vendor who is also a customer currently has separate party/identity-org records. Discuss single human/company login across relationships and consent before treating this as approved architecture. Ask Rajendra if multiple legal entities, user memberships or contractual sharing requirements need business confirmation.
- Reconcile D17's future vendor login idea with D14: Stage 1 vendors are staff-managed, with no vendor portal. The login idea remains later scope, not an override of staff-only.
