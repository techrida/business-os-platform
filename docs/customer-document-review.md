# Customer document review

Customer cases created by this version use `document_review_v1`. A reviewer approves or rejects each supplied document before approving the customer. Rejection requires a trimmed reason of 1 to 2000 UTF-16 code units. Authorized Sales readers can read current reasons and the case review history.

A document rejection leaves the case submitted and files locked. The reviewer rejects the case separately to let Sales correct evidence. Replacement or removal returns the case to draft. Resubmission resets every supplied document to provided and binds its newest eligible immutable file version. Reattaching a rejected version or changing its expiry cannot bypass correction. Every supplied optional document needs review. An absent optional document does not block approval.

The case version serializes document and final decisions. New document decisions and detach commands require an `Idempotency-Key`. Submission carries `expectedVersion`. History uses `GET /v1/verification-cases/:id/review-history` with an opaque `before` cursor and a default page size of 20, capped at 100. Every read and retry checks current authorization. Existing entity-scoped file download permissions still apply.

Existing approved cases retain their status and an honest legacy label. Migration creates no historical document approvals. The D21 sole-member Founder exception remains a separate authorization gap. This feature retains the distinct-reviewer rule. The authorization owner must resolve creation-organization provenance separately.

## Activate on a restored copy before cutover

The parent owns rollout. Stop old writers before activation. Back up the database, file volumes, and runtime configuration. Restore them into disposable resources and rehearse the complete phase migration set there. Never point these commands at a running development instance during feature verification.

From the matching phase checkout, use Linux Node 24 and the repository's pinned pnpm. Failure is a nonzero exit for each command.

```sh
pnpm --filter @bos/db build
pnpm --filter @bos/db migrate
```

The migration command reads `DATABASE_MIGRATE_URL`. Supply the disposable database connection through the process environment. Do not print or commit its value.

Run activation with the restored tenant and acting organization UUIDs. Set `PGSERVICE` to a private PostgreSQL service entry for the restored database. Failure is a nonzero psql exit.

```sh
psql -X -v ON_ERROR_STOP=1 -v tenant_id="$TENANT_ID" -v organization_id="$ORGANIZATION_ID" -v apply=false -f tools/db/activate-customer-document-review.sql
psql -X -v ON_ERROR_STOP=1 -v tenant_id="$TENANT_ID" -v organization_id="$ORGANIZATION_ID" -v apply=true -f tools/db/activate-customer-document-review.sql
```

The first command rolls back. The second activates nonterminal customer cases in that tenant and bumps their versions. Repeating activation does not bump them again. Approved customer and vendor cases stay unchanged. Submitted cases stay submitted. Existing file bytes and real case reasons stay intact. Unavailable evidence blocks review until correction. Deploy matching backend and workspace versions together after restored-copy verification and independent review.

Before activation, an application rollback can leave additive schema in place. After activation or any document decisions, retain a compatible backend or suspend writes. Do not restore an old bulk-approval writer. Do not drop the journal or delete reasons as rollback.

## Acceptance

The independent runner is `tools/manual-acceptance/verification/verification-review-acceptance.mjs`. It requires the parent's configured real dev runtime, sibling `showcase-api.mjs`, and fixture files. It writes results under that configured runtime directory. The parent owns its execution and real-origin reviewer and Sales browser acceptance. Repository tests use disposable Testcontainers instead.
