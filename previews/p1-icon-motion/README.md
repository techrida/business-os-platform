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

## Revision 2 (Claude Opus 5.5, 2026-11-12): expressive bell and menu

Kuu reviewed revision 1 and kept the press scaling and hover/press surfaces, but asked for more character, modelled on Marcel Kargul's notification micro-animation (x.com/marcelkargul/status/2119542301655806090). The earlier "reject bell ringing" and "reject hamburger morph" decisions are reversed by that instruction.

### Reference, read frame by frame (60 fps source, 6.5 s)

1. Badge grows from a dot with an overshoot to about 115%, then settles (about 200 ms).
2. A ring in the surface colour separates the badge from the bell (cut-out).
3. As the badge lands, the bell swings from a pivot at its top: about +20°, then -10°, +4°, back to rest, in about 700 ms.
4. The clapper lags the bell and swings further (follow-through).

### Bell, as built in the preview

| Event | Motion | Why |
| --- | --- | --- |
| Count rises from 0 | Badge pops (scale .35 to 1.18 to 1, 320 ms, strong ease-out); bell swing starts 110 ms later | Cause, then effect, as in the reference |
| Count rises while badge shown | Number rolls up (200 ms), badge pulses to 1.15, bell swings | Shows that something new arrived, not a repeat |
| Pointer click to open | Smaller swing (15°, 520 ms) and the bell fills in the primary colour while open | Feedback; fill means "open" |
| Keyboard open | Instant fill, no swing | Emil rule: no flourish on keyboard actions |
| Item read or Mark all read | Number rolls down, or badge shrinks out (150 ms); no swing | Opening never marks anything read |
| Page load or poll with no rise | No motion | Mirrors the real bell's `quiet` first read and announce-only-on-rise logic |
| Reduced motion | No swing, roll or pulse; badge fades | Keeps meaning without movement |

Swing: a damped sine, angle(t) = A·e^(-t/τ)·sin(2πt/P), sampled at 60 fps into Web Animations API keyframes, pivot (12, 2.5) in the 24-unit icon. Arrival A 28, P 340 ms, τ 210 ms; click A 15, P 300 ms, τ 160 ms. Clapper = 1.35 × the bell angle delayed 55 ms, relative to the bell. A new trigger starts from the current angle, so rapid arrivals or clicks never snap. Measured arrival angles in Chromium: 0, 3, 18, -1, -8, -2, 3, 1, -1, -1, 0.

Proposed change to the real bell: show the count in the badge (cap "9+") instead of the 9px dot, matching the reference. The count already exists in `notifications-bell.tsx`; this is a visual change only.

### Hamburger, three options for Kuu to choose

The real drawer's close button is in the drawer's top-right corner, not where the hamburger is, and the page behind (including the hamburger) is blocked while the drawer is open. That limits what the hamburger can usefully do.

- **A. Pull-through (recommended).** Bars slide 10px right and fade, 35 ms apart, as the drawer slides in (260 ms, iOS drawer curve). The drawer's X turns in from -90°. Reverses on close. CSS transitions, so rapid taps retarget. No layout change.
- **B. Squeeze and spring.** Pointer down gathers the bars (top down 3px, middle to 75% width, bottom up 3px, 90 ms); release springs them apart with an 18% overshoot (CSS `linear()` spring, 420 ms). No layout change.
- **C. Morph to X.** The hamburger turns into an X (240 ms strong ease-in-out) and stays above the drawer as the close control. Needs a layout change: drop the drawer's separate close button and leave the header button usable while the rest of the page is blocked.

All three keep Escape, scrim tap, focus to the close control on open (A, B) and focus back to the hamburger on close. Reduced motion keeps only opacity changes. The drawer slide itself is new (today it appears instantly).

### Verified (headless Chromium 1.65 Playwright, file opened directly)

Passed: quiet load does not animate; arrival changes the accessible name and swings; swing settles to `transform: none`; pointer open swings without marking read; Escape closes and returns focus; keyboard Enter opens with no swing; reading one item and Mark all read update the name and hide the badge; a burst of 3 arrivals plus 8 rapid clicks ends with one badge number "3" and the bell at rest; for each hamburger option, open blocks the page, focus moves correctly, Escape or the X closes, and rapid taps leave the state consistent; reduced motion removes the swing but still updates the count; no horizontal overflow at 390px; no console errors. A 4x slow-motion filmstrip was checked against the reference.

Found and fixed during testing: option C's X was painted under the drawer because the header formed its own stacking layer.

Not verified: feel on a real phone, screen readers, and the live application. Application code is unchanged; these are proposals until Kuu picks a hamburger option.
