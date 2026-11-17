# Verification approval gate handoff — 2026-11-17

This handoff records the earlier case-only correction. Customer document review supersedes that readiness policy. See [Customer document review](../../customer-document-review.md).

The workspace required its own postcondition. Git -S and blame identify
ba41a0341feb9946dce1eb1ddd78e04841cb32fd (format helper and preaccepted test).
4595a574 added the page/control and misleading accepted-count helper.

VerificationService.decide checks required presence, per-required newest
non-rejected scan evidence and allClean, then calls acceptProvided.
The workspace now uses provided-or-accepted presence and scan readiness.
isChecklistComplete still describes final acceptance. No API, permissions,
identity, scope, stale-version or maker/checker behavior changed.

Current P2 reviewAction does not call canApprove: it parses the form and
forwards expectedVersion and idempotency key to the API. The disabled page
control was the circular gate on these heads.

## Evidence and limits

The producer-state regression uses real DEFAULT_CHECKLIST and attachDocument:
three required provided items, zero accepted, clean scans. Replacing canApprove
with its original implementation fails the approval assertion (1 failed,
5 passed at that revision); fixed focused workspace suite: 27 passed.
It includes rendered ReviewForm control/helper and action forwarding/refusal
checks. API verification.rules tests: 14 passed. These are local Linux Node 24
checks, not WSL or HTTPS browser acceptance. No services or containers touched.
Existing API integration tests cover clean transition, pending/infected/missing,
stale version, same submitter, foreign tenant; not run here because containers
are forbidden. Parent owns separate showcase browser acceptance.

History searched on all three linked machines (verification and KYB).
KuuPC recovered source:
[Business-OS: P0](t3-thread://v2/3a75166d-6abf-4203-8f00-153e538dff4b/import:claudeAgent:ed769e36-ac10-4bca-ab69-f6ceec7ef464),
positions 104–107. Position 105 is an assistant report of KYB UI work and
ownership/document visibility concerns, not a prior warning about this gate.
Child implementation attribution was not recovered. Searches are not exhaustive;
no claim that earlier warnings never existed. Git source establishes introduction.

## Selective runtime copy

Copy only these two runtime files from the delivered P4 head:

- apps/workspace/src/components/p2/customers/format.ts
- apps/workspace/src/app/(app)/verification/[id]/page.tsx

They use existing document GET versions (version/status) and existing contracts.
No API refresh, migration, service restart, next.config edit or .next operation
is required. Preserve local HMR edits. P4 format.ts also contains existing vendor
labels; preserve those when copying to a different phase. Lookup failure blocks
approval visibly; scans can finish after rendering, so reload updates eligibility.
The API remains authoritative for concurrent changes and any case attachments
not represented by the checklist. Do not approve the user's pending case.
