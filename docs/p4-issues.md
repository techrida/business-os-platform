# P4 study issues and decisions

## Resolved policy choices; implementation review remains

- D14: Stage 1 vendors are staff-only. Internal vendor and procurement records remain in scope; no vendor portal. Review any existing portal scope without automatically deleting users or records.
- D20: Finance-only for payments entirely against matched PO bills; non-PO bills/payments retain bands. This agrees with P4 assumed decision AD5. Bill approval remains separate (Accountant → Finance).
- D21: fewer than three finance-capable users may exist. Exactly one member, who is the Founder: only that Founder may approve anything created in that organisation. This explicitly changes the planned no-self-approval behavior only for this case. It is not implemented or verified by the documentation update.

## Follow-ups at P4

- D13: preserve the current ledger implementation. Revisit only if a concrete unresolved ledger-scope question remains in P4; no rewrite or full double-entry expansion was authorized. Do not ask it again in P0/P1.
- D17: clarify future vendor identity reuse and vendor/customer relationships, respecting D14's staff-only Stage 1 scope and tenant isolation.
- D21 implementation boundaries: define exactly which membership count governs the one-member condition, treatment of inactive/invited/service accounts, transition when a second member joins, behavior of already-pending approvals and audit of the exception. These are P4 follow-ups; do not silently invent them or broaden the exception to all understaffed organisations.
- D21 verifies that an unrelated tenant/organisation cannot use the exception, the sole member must be Founder, and the exception stops when its approved condition no longer holds.

Further small-team cases are explicitly deferred to `post-p4-issues.md`. Multiple roles on one human do not satisfy a distinct-person rule by themselves. No existing database, runtime or approval engine was changed here.
