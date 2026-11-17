# Customer verification ownership regression (2026-11-17)

New customers with omitted optional owner default to the acting user. Explicit
owners remain authoritative. Starting/reopening a case requires both the party's
write permission and verification read access before any insert or reopen. This
prevents a successful redirect to an unreadable record without expanding Sales
read scope or claiming unowned legacy customers. Existing data requires explicit,
audited repair; this change performs no backfill.

Prevention: pass the normal customer form payload (owner omitted) through the real
customer service, start verification and follow the returned ID and list as the
same Sales principal. Another salesperson must still get 404. Cover unowned and
differently owned customers on initial and repeat start. Keep foreign tenant and
vendor policy tests. Denied/missing details need an actionable page.

The regression failed on unchanged P2 (GET 404 instead of 200; 21 other tests
passed). Existing verification tests inserted customers directly and used Founder
for creation, or supplied ownership for Sales visibility tests. They did not join
the normal customer producer to the verification consumer as Sales.

Original introductions, found with git log -S (blame alone points at later moves):
- e8f089605c341251fd1d86ac241987ddffa62b2f: customer create stored omitted owner as null.
- d68c826eec4b652a859c635e3599fac685e55ada: Sales verification.read own.
- ee1f13880d93232d6dbf4a4071f33b240c60a2ce: verification integration tests with
  direct customer fixtures; no normal Sales customer-create -> case-read coverage.
  c8838a74 later moved the customer default into createInTx.

T3 searches covered linked KuuPC, Omarchy and crestiaOS. Search excludes child
threads and is not exhaustive. KuuPC consolidation and imported Build P1 messages
were read; neither inspected excerpt proves an original user instruction to leave
owners unset. Imported Build P1 contains later P3/P4 summaries despite its title.
Original implementation child/session attribution remains unproven; assistant
summaries and model labels must not be treated as user policy.

Framework: installed Next.js dist/docs/01-app/03-api-reference/03-file-conventions/
not-found.md says segment not-found renders when notFound() is thrown, including
after streaming starts (then response status may stay 200). The new segment uses
the existing accessible EmptyState and navigation components.

Acceptance excludes live rollout: no live services, data, .next, credentials or
served guide touched. Browser-facing origin acceptance remains for the runtime
owner after source refresh. No production build was run.

Additional provenance found during P4 integration:
[Business-OS: P0](t3-thread://v2/3a75166d-6abf-4203-8f00-153e538dff4b/import:claudeAgent:ed769e36-ac10-4bca-ab69-f6ceec7ef464),
message position 105, explicitly recorded the Sales start-any/read-own mismatch
while integrating p2/kyb-ui (before 253fa28). It described another owner's customer,
not the omitted-owner normal form failure. This is an assistant report of an open
question, not proof that Kuu accepted the behavior. Position 108 records typechecks
and 105 UI tests passing despite the known mismatch.
