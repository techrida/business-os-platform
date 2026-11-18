# Internal memo delivery record

Implementation owner: an assistant. Starting P1 head: ee22fd34542e8345e4b19758774535d6baf999c9.

Status: P1 delivered, refreshed and browser-verified, including the human-only directory and frozen approval-page preview. Higher-phase cascades are in progress. Canonical heads are recorded in the shared KB and coordinator handoff.

## Migration cascade

`0037_internal_memos.sql` adds nullable membership `job_title` and nullable memo `template` snapshots. Existing memos keep null; there are no invented historical signers or job titles. No real logo source exists in P1; omit the logo cleanly.

Existing phase migration SQL, ledger hashes and timestamps must stay unchanged. The migration runner now serializes with a PostgreSQL advisory transaction lock and applies journal entries whose SQL hashes are absent from the existing Drizzle ledger. This handles a P1 database with memo timestamp 37 subsequently gaining CRM timestamps 15–18, without skipping CRM or rerunning already recorded SQL. The transaction rolls back both schema and ledger on error.

On each normal phase merge, retain the target journal entries in existing order, append the new memo entry, and give its journal `idx` the next target index. Preserve tag/hash/timestamp. Do not copy lower-phase schema files over higher-phase features. The new runner is mandatory for all phases before migration.

Runtime owner must back up P1, preserve prior API image, build only P1 API/migrate images, briefly stop P1 API/worker, run migrations on existing P1 volumes, inspect ledger/columns, recreate only P1 API/worker and restart the P1 development server. Never build into its active `.next`.

## Verification so far

- Final API and workspace typechecks passed.
- Real Postgres memo integration: 35 tests passed with the final hash-aware runner and migration tag.
- Real Postgres phase-upgrade migration regression passed: missing older migration applies once, original ledger rows and seeded data stay intact, failure rolls schema and ledger back.
- Browser save/reopen/preview/submit, runtime refresh, runtime refresh remain pending. Isolated feature-worktree production build and dev exclusion checker passed.
- P2, P3, combined P4 memo cascade sessions remain pending P1 completion.

Follow-up verification: runner rejects unknown applied hashes before applying pending migrations. Real Postgres regression passed for changed historical SQL and rollback. Memo decision authorization now requires the selected staff member (or an existing authorized delegate), in addition to all normal live role and separation-of-duties checks. The real memo integration regression proves another eligible role holder cannot approve under the selected person's printed name and the selected people can complete approval. All 35 memo tests pass with this guard.

Browser acceptance (2026-11-10): live P1 created MEMO-2083/84-00004, reopened it with persisted letterhead/people/date/department/closing/body, and submitted to internal approval request 06ae6b0e-c6b2-4427-acc1-0e04ae0b8c33. No external correspondence action used. Preview preserves single newlines, paragraph gap, app font and no subject divider; 390px layout has no horizontal overflow. Keyboard search, ArrowDown/Enter selection, Escape focus restoration, empty-result announcement and one closed popup after selection verified. Full assistive-technology screen-reader testing remains unrun. Missing departments initially showed the honest empty state; runtime owner added an actual Operations directory department for the test, without fabricated staff/titles.

Human-only eligibility uses nonempty mirrored human email: the existing ZITADEL mapper reads email only from `human.email`, never machine profiles. The upstream CreateUserRequest.Human and AddHumanUserRequest both require SetHumanEmail (https://github.com/zitadel/zitadel/blob/main/proto/zitadel/user/v2/user_service.proto). No email is returned to the client or printed as a title. Focused integration proves service-account exclusion; human records with incomplete synchronization remain unavailable until synchronized.

Final P1 acceptance: the refreshed directory contains six real human staff and omits all service accounts. The submitted approval route renders the frozen memo as a document and names the selected accountant and finance approver. Source and type checks passed after this consumer fix. Browser form submissions use CRLF line endings; normalize those in presentation before paragraph splitting so paragraph ends do not introduce extra visual blank lines. Stored snapshots and single newlines remain intact. No real job titles were invented; null titles omit cleanly. Full screen-reader testing remains outstanding.

## P2 cascade, 2026-11-10 (an assistant)

Integrated exact final P1 `41f664a816ae721c998c0d99c8ed88e73bb2fa6f` by normal merges onto canonical P2 baseline `8baff62238e9e80a970f9a09a94263b3561788e4`. CRM, quotation workflows and inbox behavior retained. The only conflict was the journal: existing P2 entries remain unchanged; memo migration appended at idx 19 with original timestamp 1783000000037. No prior SQL changed.

Passed on P2: database 300 tests/17 files, contracts 231/8, API 1856/133 (including memo, approvals, CRM/quotations), workspace 851/66; all eight package typechecks; zero-warning lint; isolated production webpack build and check-no-dev-routes. Real Postgres tests used the private ephemeral Docker proxy. The initial root typecheck wrapper could not find bare pnpm; its recursive command passed through Corepack. Scratch build's pnpm dependency preflight refused the external node_modules symlink; Next itself completed successfully and exclusion inspection passed. No runtime data migrated or deployment performed.

P1 live browser acceptance is inherited evidence from the source owner, not repeated on a P2 runtime: human directory, save/reopen/preview/submit, frozen approval paper/named route, mobile and keyboard passed. Full screen-reader testing and P2 live browser workflows remain unrun. P3 and combined P4 delivery remain downstream until their verified remote heads are recorded by their owners. Central KB reconciliation belongs to the primary coordinator.

## Memo workflow refinement (2026-11-12)

Source: branch `t3/7725dac5`, on top of `origin/p1-main` `49ba4896` and the Phase 1 issues document `53462ca6` (both preserved by an ancestry-preserving merge). Browser acceptance against a running P1 stack has not been run for this refinement; see "Browser acceptance points" below.

### What changed

- **Memos list.** `/memos` lists the memos the caller may open (newest first, status filter, "Older memos" pager) with links to each memo and to New memo, and loading, empty, filtered-empty, error, forbidden and expired-link states. The paste-a-UUID form and `openMemoAction` are removed; there is no arbitrary-id entry point. The list comes from the new `GET /v1/test-memos` (`memo.read`): visibility is `AuthzService.scopeWhere(testMemos, 'memo.read')`, the SQL twin of the record check, so `own`, `department`, entity (`all`) and portal-party scope behave exactly like opening one memo, and another tenant's memo never appears. Pagination is keyset on `(created_at, id)` with an opaque cursor, `limit` 1-50 (default 20), unknown parameters and forged cursors are `400`. Rows carry id, number, title, status, amount, currency, owner name, department name and times; never a body or signers.
- **Staff fields.** The button plus separate search popup is replaced by one reusable inline editable combobox (`components/ui/combobox.tsx`, pure rules in `combobox-model.ts`) behind `StaffPicker`. The box you click is the box you type in; the list opens directly below. Up to 20 staff are listed flat; more than 20 are grouped by the real directory department (`user_entities.department_id` joined to `departments.name`, "Unassigned" last). Keyboard: ArrowDown/ArrowUp (wrapping, skipping options already chosen elsewhere), Enter chooses and never submits the form, Escape closes and restores the chosen name, Tab leaves; clearing the text clears the signer. Empty directory, no match, one list open at a time, and focus after add/remove are handled.
- **Signers.** Prepared by, Recommended by and Approved by share one label style and one row layout. Recommended starts with two blank rows (an edit keeps exactly the stored rows), each row reads `1. Enter Name` with a red delete button, at most 20 (`MEMO_MAX_RECOMMENDERS`, also the API limit). Blank rows are dropped before the preview and the API call, so one real signer works. Prepared by can only search and choose the signed-in author; the server rule (`Prepared by must be the signed-in staff member`) is unchanged, and the form now always sends the signed-in user as preparer.
- **Preview.** On wide screens the paper stays under the app header while the editor scrolls; it is capped to the space below the header and scrolls inside itself when taller. On phones it stacks under the form. Icon-only buttons download the real PDF and print only the paper.
- **PDF.** `src/lib/memo-pdf.ts` draws the paper with pdfkit (a real PDF, not HTML renamed). Routes: `GET /api/memos/[id]/pdf` renders the persisted, frozen values of a saved memo through the caller's own API session (a memo they cannot open is a 404); `POST /api/memos/pdf` renders the current unsaved form values (same-origin, staff session, 256 KB cap, zod-bounded). Everything is drawn as text, so markup and scripts in a name or body appear as characters; the file has no scripts or links and nothing is sent anywhere. Print clones only the paper node, with the page's stylesheets, into a hidden same-origin frame and prints that frame.
- **Upload from the create flow.** "Save and add attachments" saves the draft and lands on the memo's Attachments panel (`#attachments`) with a confirmation. A note under the form explains that files are attached after the first save (the document owner must exist). Real quarantine, scan polling and clean-only download are untouched.

### Dependency and fonts

`pdfkit` ^0.20.2 (and `@types/pdfkit`), added to the pnpm catalog and the workspace. It stays an external server package (`serverExternalPackages`) because it reads its own data files; its 16 new transitive packages are in the lockfile only. Fonts are Noto Sans (latin, latin-ext, vietnamese, greek, cyrillic) and Noto Sans Devanagari, weights 400 and 700, copied unmodified from `@fontsource/noto-sans` and `@fontsource/noto-sans-devanagari` 5.3.0 into `apps/workspace/assets/fonts` (SIL OFL 1.1, license and provenance in that folder). `next.config.ts` lists the folder for standalone tracing; a production build was verified to carry both the fonts and pdfkit. Devanagari shapes correctly (conjuncts, vowel signs) and was checked visually. Scripts outside these subsets (CJK, Arabic, emoji) print as `?` and the download says how many characters were replaced; nothing fails.

### P1 boundary and P2 removal map

P1 keeps the amount and currency fields and the PDF upload controls so the whole kernel workflow (FX freeze, amount-based approval routing, quarantine, scan polling, clean-only download, frozen attachment snapshot) can be exercised. They are test controls of the P1 test memo, not product fields. From P2 the internal memo UI removes them and keeps the memo, the list, the PDF export and print, and the signers. Remove, in the P2 root:

| Where                                                                           | Remove                                                                                                                       | Keep                                                                                    |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `memos/memo-form.tsx`                                                           | the `amountRow` block (Amount, Currency), `CURRENCY_OPTIONS`, the attachments note and the "Save and add attachments" button | everything else                                                                         |
| `memos/actions.ts`                                                              | `amount` and `currency` in `MemoValues`, `FIELD_MESSAGE`, `readValues`; the `intent === 'attach'` redirect                   | `template`, title, body, create/update/submit                                           |
| `memos/[id]/page.tsx`                                                           | the amount and "In NPR" facts, the Attachments panel, the `attach` banner, `submitBlocker` and its scan wording              | paper, edit panel, approval route, audit                                                |
| `memos/[id]/attachments.tsx`, `app/api/memos/[id]/attachments/route.ts`         | both files                                                                                                                   | the document platform itself (`/api/documents/...` stays for other owners)              |
| `memos/memo-list.tsx`                                                           | the Amount column                                                                                                            | title, number, status, department, owner, created                                       |
| `lib/kernel-ui.ts` upload helpers, `kit.module.css` attachment and upload rules | if no other screen uses them                                                                                                 | -                                                                                       |
| API `test-memo` module                                                          | `amount`, `currency`, FX freeze and `amountNpr` routing facts are replaced by the quotation model                            | `list`, `directory`, template snapshot, `MemoListSchema`, selected-signer authorization |

`MemoPdf` input has no money fields, so the PDF export needs no change.

Nov16 follow-up: the P1 attachment panel now uploads directly after a picker
selection or one-file drop and exposes audited removal for editable memos. The
P2 removal map also covers `memos/[id]/attachment-actions.ts` and its focused
tests, and the P1 attachment-specific scenario in `e2e/exit.spec.ts`. Keep the
generic `app/api/documents/[documentId]/route.ts` DELETE BFF for other document
owners when applicable. Do not reintroduce the memo attachment panel or finance
test fields into P2+ while carrying this source ancestry forward.

### Real directory support

The picker reads the real directory only: active human staff of the acting company (service accounts and unsynchronized identities excluded), their membership job title, and the department from the membership. No staff or titles are invented. A company with 21 or more staff is grouped by those real departments; people without a department sit under "Unassigned". A company with no staff shows an honest empty message. A department must exist in the company directory before a memo can be created.

### Verification

Run on this branch: API integration (real Postgres, 44 memo tests including nine new list tests for own, department, entity, portal-party and cross-tenant scope, stable paging across tied timestamps, status filter and forged cursors); contracts tests; workspace unit tests (446); typechecks of contracts, API and workspace; eslint with zero warnings on the touched source; an isolated production `next build` plus the dev-route exclusion check; the PDF checked as a real PDF with embedded fonts, ToUnicode coverage of Devanagari and extended Latin names, absence of script and link objects, and a visual render; combobox, signer rows, sticky preview, tall preview, mobile stacking and print isolation driven in Chromium against a scratch harness of the real components and real design tokens. Not run: the authenticated browser flow against a running P1 stack, the Playwright e2e suite, screen-reader testing, and a PDF download from the production image.

### Browser acceptance points (for the runtime owner)

1. `/memos` shows only memos you can open, with a status filter and an "Older memos" link after 20; an empty account shows the empty state; the old id box is gone.
2. `/memos/new`: two blank recommender rows; click a box and type; list opens below; one list at a time; arrows, Enter, Escape; trash is red; Add recommender stops at 20; with 21 or more staff the list is grouped by department; saving with one real recommender and blank rows works.
3. Prepared by offers only you; Approved by and each recommender cannot reuse a person already chosen.
4. Scroll the form on a wide screen: the paper stays put; a long body scrolls inside the paper block; at 390 px the paper sits under the form with no horizontal scroll.
5. Download PDF from the unsaved form and from a saved memo (open the file: letterhead, signers, Devanagari names); Print shows only the paper in the browser's print preview.
6. "Save and add attachments" lands on Attachments; upload a PDF; see quarantined, polling, clean, download; Submit unlocks only when clean.

## P2 removal (2026-11-12)

The P1 test controls are gone from the internal memo; the correspondence feature stays. Branch `p2-main` (P2 plus P1 release `731907f4`).

### What was removed, and why

Amount, currency, the PDF upload panel (with scan polling and the "Save and add attachments" step), the Amount column of the list, and the scan-based submit blocker. They existed to exercise the kernel (FX freeze, amount thresholds, quarantine). A memo is correspondence: it has no money and no files. The `/api/memos/[id]/attachments` route and `attachments.tsx` are deleted; `/api/documents/...` and the documents service are untouched. The Memos list, inline signer comboboxes, sticky preview, PDF download, print, save/edit/submit, approval route and audit stay.

### Explicit signer route

A template memo (`row.template` set) no longer routes through the seeded `test_memo` workflow's accountant, finance and amount-threshold steps. On submit the author's selections become the route: each recommender in order, then the approver, as `user` steps with the reasons "Selected recommender N" and "Selected approver". Any count from 1 to 21 signers works, whatever roles they hold as long as each can decide approvals (see "Signer eligibility"), and no management or founder step is ever added.

- `ApprovalsService.submit` takes an optional `explicitSteps`. The published `test_memo` definition and version are still recorded (so are its SLA and `distinctApprovers`), but the planner runs a synthetic spec with those steps and no rules, so separation of duties, the active-staff check and blocked handling are the engine's. If the plan is blocked (the owner, an editor, the person pressing submit or an uploader is a signer, or a signer is inactive) submit answers 409 and creates nothing. `proposedApproverIds` still applies to other callers.
- The request's `facts` carry `routing: "explicit"` and no `amountNpr`; the snapshot has no amount, currency or FX fields. Attachments are still frozen and `allClean` still applies, so a legacy memo with files behaves as before.
- Decision time (`act`, `inbox`, `reroute`) rebuilds the spec from the stored user steps when that marker is present and every step is a user step. Requests submitted before this change, and every non-template memo, route from the frozen spec exactly as before. `loadDirectory` now omits `activeUserIds` when no user is named (an empty set would have blocked a user step nobody listed).
- The selected-signer guard in `act` (`documentType === 'test_memo'` with a template snapshot) is unchanged.
- `GET /v1/test-memos/:id/route` (`memo.update`) previews the route from the same people and the same separation-of-duties list as submit: the selected people for a template memo, the role steps for a legacy memo.

### NPR 0 compatibility value

`test_memos.amount/currency/amount_npr/fx_*` are NOT NULL with CHECKs and no migration was added (it would cascade journal indexes into P3 and P4). A template memo created without money stores NPR 0.00 at the identity rate through the normal `MoneyService` snapshot; nothing routes on it and no screen shows it as a figure. `CreateMemoBodySchema` makes amount and currency optional only when a template is present; a memo without a template still requires them. Update re-freezes money only when amount or currency is sent.

### Historical records

Existing memos keep their stored values. The detail page shows a nonzero stored amount read-only as "Recorded P1 test amount", and lists existing attachments read-only (clean files get a download link; there is no upload and no polling). The list shows no amount.

### Corrections to the map above

- Money is not "replaced by the quotation model". Quotations have their own money model; memos simply have none.
- The memo's selected people are the route. The map said to keep "selected-signer authorization" only; the route itself also had to change, because the old plan dictated signer count and roles from the amount.
- `lib/kernel-ui.ts` upload helpers stay: verification uses them. Only the memo-only rules of `kit.module.css` (amount row, upload and dropzone) were removed; the `.file*` rules remain for the read-only list.
- Decision time needed the explicit-route rebuild above; the map did not mention it.

### Signer eligibility (follow-up, 2026-11-12)

A named signer must be able to decide, and no role grant was widened to make that so. Default roles such as sales, operations_head, procurement and receiver hold `approvals.requests.read: own` but not `approvals.requests.act`, so the decide and inbox routes (`@Can('approvals.requests.act')`) would refuse them.

- **Rule.** A recommender or approver must hold a live `approvals.requests.act` grant. "Live" means: the person's roles in the acting entity (the `user_roles` mirror, narrowed by the membership's `role_keys`, as the tenancy interceptor narrows a token's roles) looked up in the tenant's `role_permissions` rows through `RoleCache`, the same table the route check reads. Nothing is hard-coded by role name, and an administrator who removes the grant from a role changes the answer at the next cache reload.
- **Directory.** `GET /v1/test-memos/directory` marks each person `canApprove`. The Recommended and Approved comboboxes list only people with it (a person already saved in a field stays listed so a saved memo shows its names). Prepared by stays the signed-in author. With no approver at all the fields say so and point to an administrator. `canApprove` is a directory fact, never stored in the memo's template snapshot.
- **Preview.** `GET :id/route` marks a signer without the right as a blocked step, with the reason "<name> cannot decide approvals; choose someone with approval rights.", and names the person (not an id) when separation of duties blocks a step.
- **Submit.** A signer without the right is refused with 409 and that same message, before the engine plans the route. Nothing is created.
- **Step-up.** A user step is not a founder role step, so a named founder decides without the recent-sign-in step-up that a founder role step requires. Acceptable for correspondence with no financial threshold; say so if it should change.

### Open items for the lead

- `sla.processor.ts` now loads the named user of an explicit step (so the reminder goes to that person, and not to one who left); a test in `approvals.integration.test.ts` covers it. Escalation still notifies the escalation role (founder) by role, as for any request.
- The Playwright specs `exit.spec.ts` and `inbox.spec.ts` and `helpers/memo-flow.ts` were rewritten to the new flow (named signers, no amount, no upload) and have not been run against a live stack. The upload and scan path stays covered at the API layer (`apps/api/test/e2e`), which still drives a legacy memo as owner; no upload UI was added.
