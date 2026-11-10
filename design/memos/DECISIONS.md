# Memo template decisions and critique

Source: Kuu's memo design discussion, 2026-11-10. Recorded by Codex.

## Scope and evidence

P1's original `test_memo` is a throwaway kernel exercise, not a defined internal correspondence product. It has money fields and a customer reference (`packages/db/src/schema/memo.ts`, KB P1-decisions-vs-spec section J). The new internal memo template is an explicit extension. Preserve existing test-memo behavior until the app contract and workflow changes are designed and implemented.

This HTML is a standalone proposal, not the implemented `/memos/new` route. Its company, staff, titles and department options illustrate intended defaults; they are not a live directory export. Actual organization identity must come from the active legal entity, never a hardcoded company or editable free text. Do not send these internal memos to clients/vendors. External correspondence needs a separate document type.

## Decisions

- One font family across the app mockup and document: Arial, with generic sans-serif fallback. Production should use the existing application font token consistently; no separate serif document face.
- Omit the editable organization input. Show the active legal entity as read-only context. Validate tenant/entity server-side.
- Department: fixed-choice dropdown of the active company's departments; default from the current person's membership. Never hardcode the options in production. Missing membership requires an explicit department choice; an empty directory explains how to resolve it without inventing a department.
- Prepared by: default to the signed-in staff member. Searchable staff selection may be offered subject to permission; attribution/audit actor remains the authenticated user. Selection does not impersonate staff or bypass approval separation of duties.
- Recommended by: zero or more eligible staff; add/remove in explicit order. Approved by: eligible approver selection must agree with the real workflow. A printed name is not an approval or signature.
- Directory scope: active staff memberships in the active legal entity, excluding portal users and inactive staff. Search display name, department and job title. Use stable user IDs, distinguish duplicate names with department/title and an authorized secondary identifier; never silently choose the first match.
- `STAFF_GROUPING_THRESHOLD = 20`: above 20 eligible staff, group unfiltered results by department with an Unassigned group; alphabetical within groups. Search remains available at every size; filtered results preserve group context. This is an initial product heuristic, not an accessibility standard. Keep it in code-owned internal UI policy, without a DB/admin/super-admin setting or write API. The prototype declares it; grouped production combobox behavior is still to build.
- Display-name and department models exist in P1 (`identity.ts`). Job title is absent: add a proper staff profile/job-title source later; permission roles are not job titles. Do not pretend a profile title is available today. Snapshot selected IDs/names/titles/entity/department into a finalized memo so profile edits do not rewrite signed history.
- Signatures remain disabled. Snapshot and signing/approval lifecycle need a later design; no fake signature uploads or completion marks.

## Critique and applied refinements

The first version mixed Arial-like form text with Georgia in the memo, used tiny signature metadata, repeated a heavy title/rule and added a redundant internal-memorandum footer. This weakened consistency and made the preview harder to read.

Applied one sans-serif family, larger document body/sign-off text, lighter divider, more breathing room after the subject, removed redundant footer, and replaced repeated free-entry company/staff/title fields with contextual company, department choice and searchable staff names with read-only titles. Maintain restrained hierarchy with weight and spacing. Long names/titles wrap in the output. The preview is not a guaranteed one-page PDF; longer content may need pagination during production export.

Prototype uses the browser's native datalist for searchable people. It validates exact directory choices on change; it is not a final production combobox. Build a tested keyboard/screen-reader combobox for grouped results with Arrow keys, Enter, Escape, focus restoration, loading, empty and error states. Prevent duplicate sign-off selections and invalid user IDs in the real contract. Do not infer accessibility compliance from a screenshot.

## Emil skills: applicability

- `emil-design-eng`: component craft, forms, focus, typography and interaction details.
- `make-interfaces-feel-better`: final spacing, hierarchy, hit targets and visual polish.
- `find-animation-opportunities`: read-only filter for useful new motion; reject routine decorative motion.
- `improve-animations`: audit existing motion and plan corrections; `remove-animations`: subtract unnecessary motion.
- `animate`: new web animation implementation; `animation-performance`: composite-only properties and frame budget; `animation-vocabulary`: identify effects by name.
- `apple-design`: physical/gesture-oriented web interfaces; `mobile-native`: mobile web behavior; `animate-expo`: React Native/Expo motion; `write-swift`: native Swift, not this web form.
- `ask-sonner`: Sonner toast integration when that library is actually used.
- `break-ui`: long/empty/duplicate data and dense layouts. `a11y-audit` is the separate UI verification skill, not an Emil skill.

Memo motion: no animated document text, no live-preview crossfades per keystroke, no staggered directory results. Optional added-row fade, 140ms opacity ease-out, must preserve focus and become instant with reduced motion. Icon-specific opportunities and previews are owned by the separate P1 icon session.

## Verification and remaining work

Desktop/mobile HTML render and JS parse checks only; no application server, database integration, production save or signature collection. Native datalist grouping and full keyboard/screen-reader checks remain for production implementation. This changes the approved design direction; it does not claim the P1 application now implements these fields.
