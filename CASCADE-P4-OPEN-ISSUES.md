# P4 cascade: open issues and verification status

Written 2026-11-10 for the agent or session that inspects this branch. State at `5cfbf5fd` (`p4/procurement`). Guide followed: `CASCADE-P0-UI-CHANGES.md` (P0 tip `2ea627cf`, merged in `822b6c3d`).

Rule behind all of this: product screens show product content only (no phase tags, roadmap copy, build status or raw IDs). Never disable a working action just to hide an ID; replace the ID with a named lookup.

## What is done and verified

- Real two-parent merge of the P0 tip. P4 destinations, role and permission filtering, notifications and later-phase tests are preserved. Pinned sidebar footer, dev-only floating menu/whoami and production-exclusion checker came in with the merge.
- Review fixes (copy only): roles page copy, raw IDs replaced on payment-request, opportunity, customer and vendor pages (including tooltips), customer roadmap copy removed, receipts `over_receipt_exception_unknown` message reworded, payment-request test asserts no raw IDs in `title`/`alt`/`aria-*`.
- Verified: typecheck, eslint, prettier, focused vitest (nav, dev-menu state, whoami route, exclusion checker, P2/P4 procurement pages).
- Verified on a real production build in a scratch worktree: `node apps/workspace/scripts/check-no-dev-routes.mjs` passed (74 manifest entries; server, static and standalone output scanned). Injecting a `/dev` manifest route, `BOS_DEV_MENU` in a static chunk and `BOS_DEV_PERSONA_SWITCHER` in standalone each made it fail (exit 1).

## Not verified

- No browser, render or hydration check. Nobody has seen the UI.
- Full test suite, Docker-image gate and end-to-end tests not run.
- The last two fix commits (`49e2c717`, `5cfbf5fd`) were checked by their implementer but not re-reviewed by a separate pass.
- Vitest prints a configuration compatibility warning.

## Open issues (tracked, not fixed)

Paths are under `apps/workspace/src/app/(app)/` unless noted.

### 1. Raw IDs still shown as visible text

- `components/p2/customers/format.ts:141` customer fallback
- `components/p2/quotations/status-history.tsx:45` actor
- `memos/[id]/page.tsx:37` actor
- `verification/[id]/page.tsx:56,217` document and reviewer
- `inbox/[id]/page.tsx:44,45,67` groups and people
- `quotations/[id]/page.tsx:154,219` owner and revision
- Purchase order vendor names (`procurement/orders/[id]/page.tsx`): fixed in U18 (the order carries `vendorName`); the list page row at `procurement/orders/page.tsx:64` was not re-checked
- `procurement/requests/page.tsx:51`, `procurement/requests/[id]/page.tsx:115,120,134` department, cost centre, project
- `procurement/rfqs/[id]/page.tsx` vendor names: fixed in U18 (`vendorLabel` from the RFQ vendor names); the request, quotation and tax-code fallbacks at `rfqs/[id]/quotations/new/page.tsx:170` and `quote-form.tsx:366` remain
- `payables/_components/bill-header-inputs.tsx:98` vendor fallback
- `admin/workflows/page.tsx:110-121` user fallbacks

Needs the loaded data to carry names, or a lookup. Do not add API calls blindly; check what the API already returns.

### 2. ID-entry controls with no name lookup

Users must know the ID. Fix by adding named lookups under existing tenant and permission checks, keeping creation working.

- Purchase request department and cost centre: `procurement/requests/_components/pr-form.tsx:145,163` (another phase hit a disabled-creation bug from the missing cost-centre lookup; on this branch creation still works because the raw input remains)
- Manual document-ID entry: `procurement/rfqs/[id]/quotations/_components/quote-form.tsx:193`
- Bill account-ID entry: `payables/_components/bill-entry-form.tsx:180`
- Also memo lookup, workflow administration, receipt filtering and RFQ document entry

### 3. Behaviour note

The opportunity detail page now links to the customer (new navigation added while replacing the raw customer ID). The target is correct; mention it if reviewing for copy-only changes.

### 4. Sidebar disabled-row copy

Disabled sidebar rows say "not available yet". The guide permits this as disabled-state copy; revisit only if product wants different wording.

## Explicitly out of scope on this branch

Instant passwordless account switcher (separate unfinished work, Q29), private-network removal, and any unrelated change.
