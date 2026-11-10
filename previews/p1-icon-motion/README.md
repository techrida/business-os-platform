# P1 icon interaction review

Codex, 2026-11-10. Base: `055a150f` on `kuu/p1-icon-motion` (includes P1 merge `a533cb89`). Clean checkout at start. Open `deliverable.html` directly; no server, packages or external requests required. User requested this review documentation in scope; KB and memo prototype are untouched.

## Installed Emil rundown (17 skills, grouped by purpose)

Inventory: installed `emil/0.2.0/skills` directories, including skills omitted from the session catalog. This is a rundown, not a claim that every skill was executed.

| Purpose | Skills and use |
| --- | --- |
| Discover and specify | `find-animation-opportunities`: find justified additions; `animation-vocabulary`: name effects; `prototype`: explore an interaction |
| Implement motion | `animate`: web motion; `apple-design`: physical gestures and sheets; `animate-expo`: native Expo motion |
| Component craft | `emil-design-eng`: component engineering; `make-interfaces-feel-better`: spacing and interaction polish; `pick-ui-library`: choose accessible component foundations; `ask-sonner`: toast implementation |
| Audit and simplify | `review-animations`: review a motion change; `improve-animations`: codebase audit; `remove-animations`: subtract unhelpful movement; `animation-performance`: frame-budget work |
| Platform and resilience | `mobile-native`: mobile web behavior; `write-swift`: Swift implementation; `break-ui`: worst-case content checks |

Passes applied: `find-animation-opportunities` → Disney `micro-interactions` (advisory principles) → Emil `animate` (implementation) → standalone preview checks. No downstream agents.

## Observed application behavior

- `apps/workspace/src/components/shell/shell-state.tsx:137`: mobile hamburger opens, rather than toggles, a drawer. Separate close control, Escape, scrim and breakpoint changes close it. Main content becomes inert and focus moves to drawer close, returning to hamburger on close.
- Same file, `CollapseToggle`: desktop uses directional chevrons, not hamburger. Keep these semantics; expansion label currently always says “Collapse sidebar” and should become “Expand sidebar” when collapsed in a future application pass.
- `apps/workspace/src/components/shell/shell.module.css:38`: 36px shell buttons already have hover/pressed surfaces and 120ms background transition.
- `apps/workspace/src/app/(app)/notifications-bell.tsx:124`: opening fetches the list; it does not mark read. Item activation or explicit Mark all read makes optimistic read requests. Existing polling, errors, authorization and persistence are outside this preview.
- Bell stylesheet: hover and expanded currently share a surface, with outline bell in both; unread dot is independent. Escape restores focus; outside pointer and focus departure dismiss the disclosure.
- Icons use inline 24-unit stroke drawings; no icon library or motion dependency is needed. Existing semantic tokens include `--icon-default`, `--interactive-hover`, `--interactive-pressed`, `--action-primary`, `--radius-lg`. Preview uses isolated light fallbacks; application integration must use the actual token sheet, including dark overrides.

## Opportunities (bounded to these controls)

| # | Location | Today | Purpose | Frequency assumption | Recommendation |
| --- | --- | --- | --- | --- | --- |
| 1 | bell button and shell iconButton | Surface feedback only | Feedback | Tens/day | Pointer press scale .97, 120ms cubic-bezier(.23,1,.32,1); transition transform only. Keyboard and reduced motion instant. Preview proposes this ease locally; app has no shared ease-out token yet. |
| 2 | bell expanded state | Same outline as closed | State indication | Tens/day | Instant solid bell body only while expanded; static unread dot retained. Hamburger gets open surface fill, never a filled path (open strokes have no meaningful fill). |

Highest leverage is distinguishing bell open state without changing read semantics. Hover is gated to fine hover pointers and changes surface instantly; press surface is distinct. Preview targets are 44px, a proposed improvement over current 36px buttons.

Rejected candidates:
- Bell ringing and unread dot pulse: distraction on repeated polling; no comprehension benefit.
- Hamburger-to-X morph: real hamburger is behind an inert main area during drawer open; the separate close control already supplies the action.
- Panel slide/scale and row stagger: delays repeated keyboard access and moves functional reading content. Preview panels open instantly.
- Sidebar width animation: layout work on a frequent control; outside the bounded icon review.
- Destructive hold and gesture spring: no destructive or drag action exists here.

## Principles and implementation decisions

Disney staging: open fill, unread dot and focus ring carry separate meanings. Timing: brief press feedback; no anticipation delay. Pose-to-pose state change: instant outline/solid switch. Solid drawing: preserve original bell silhouette; only close the bell body path to make fill valid. Reject bounce, squash, ringing and overshoot for this daily business interface.

Emil implementation: CSS transition retargets rapid presses without timers or queued keyframes. No movement on keyboard interaction; native buttons provide Enter/Space activation and focus-visible rings. Reduced motion removes transforms and transitions without losing state. Touch does not acquire sticky hover styling. No external library needed for this isolated inline disclosure demonstration; it is not a production drawer implementation.

Supported in preview: toggle disclosures, Escape/focus return, outside pointer dismissal, focus departure dismissal, explicit sample read/reset, accessible unread name, static dot, open-only bell fill, pointer press feedback. Proposed for application: all new visual treatments and 44px targets. Existing application behavior was inspected in source, not exercised against a running service. Preview does not model auth, polling, notification navigation, mark-all failures, desktop rail, modal drawer or production focus trapping.

Verification results are recorded with the delivery. Application source is unchanged; no application build is needed for this isolated HTML artifact. Before app integration, verify real drawer inertness and focus return, unread persistence across reload, read-request failure behavior, dark tokens, and touch layout against live application tests.

Verified locally: headless Chromium loaded the file directly. Assertions passed for opening without read, explicit read/reset, Escape returning focus, Enter/Space, ten rapid toggles, outside click, reduced-motion transition removal, and no horizontal overflow at 390px. Initial reset check found an inline-layout shift when pointerdown dismissal hid the panel before click; preview now dismisses on outside click after target activation. This differs from the real absolutely positioned panel's pointerdown dismissal. Render inspected at 728px, no console messages. Manual touch hardware, assistive technology and live application workflows remain unverified. `git diff --check` passed.
