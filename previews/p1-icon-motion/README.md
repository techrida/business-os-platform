# P1 icon interaction review

Codex, 2026-11-10. Base: `055a150f` on `kuu/p1-icon-motion` (includes P1 merge `a533cb89`). Clean checkout at start. Open `deliverable.html` directly; no server, packages or external requests required. User requested this review documentation in scope; KB and memo prototype are untouched.

## Installed Emil rundown (17 skills, grouped by purpose)

Inventory: installed `emil/0.2.0/skills` directories, including skills omitted from the session catalog. This is a rundown, not a claim that every skill was executed.

| Purpose                 | Skills and use                                                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discover and specify    | `find-animation-opportunities`: find justified additions; `animation-vocabulary`: name effects; `prototype`: explore an interaction                                                                     |
| Implement motion        | `animate`: web motion; `apple-design`: physical gestures and sheets; `animate-expo`: native Expo motion                                                                                                 |
| Component craft         | `emil-design-eng`: component engineering; `make-interfaces-feel-better`: spacing and interaction polish; `pick-ui-library`: choose accessible component foundations; `ask-sonner`: toast implementation |
| Audit and simplify      | `review-animations`: review a motion change; `improve-animations`: codebase audit; `remove-animations`: subtract unhelpful movement; `animation-performance`: frame-budget work                         |
| Platform and resilience | `mobile-native`: mobile web behavior; `write-swift`: Swift implementation; `break-ui`: worst-case content checks                                                                                        |

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

| Event                          | Motion                                                                                       | Why                                                                        |
| ------------------------------ | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Count rises from 0             | Badge pops (scale .35 to 1.18 to 1, 320 ms, strong ease-out); bell swing starts 110 ms later | Cause, then effect, as in the reference                                    |
| Count rises while badge shown  | Number rolls up (200 ms), badge pulses to 1.15, bell swings                                  | Shows that something new arrived, not a repeat                             |
| Pointer click to open          | Smaller swing (15°, 520 ms) and the bell fills in the primary colour while open              | Feedback; fill means "open"                                                |
| Keyboard open                  | Instant fill, no swing                                                                       | Emil rule: no flourish on keyboard actions                                 |
| Item read or Mark all read     | Number rolls down, or badge shrinks out (150 ms); no swing                                   | Opening never marks anything read                                          |
| Page load or poll with no rise | No motion                                                                                    | Mirrors the real bell's `quiet` first read and announce-only-on-rise logic |
| Reduced motion                 | No swing, roll or pulse; badge fades                                                         | Keeps meaning without movement                                             |

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

## Revision 3 (Claude Opus 5.5, 2026-11-12): bell measured from the reference; hamburger A plus B

This supersedes the revision 2 bell values and the three hamburger options. Kuu said the revision 2 bell did not match the reference. Kuu chose the squeeze (B) together with pull-through (A), and asked for an Emil refinement pass.

### How the bell was measured

The 60 fps source (2160×1440, 6.5 s) was downloaded with yt-dlp, the bell region was cropped, and every frame was analysed (numpy/scipy, scratch only):

- **Bell:** the resting bell is a template. In each frame it was fitted for rotation and translation, masking the badge and its cut-out ring. A least-squares solve over the fitted translations puts the pivot 3 px below the top of an 84 px tall bell, which is (12, 2.5) in the 24-unit icon. The motion is pure rotation (translation stays under 1 px apart from what the rotation causes).
- **Clapper:** tracked as its own blob, then converted to an angle about the same pivot.
- **Badge:** size from its filled area, opacity from its colour strength.

| Part          | Model                                                         | Fitted values                                                                                                        | Fit error |
| ------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------- |
| Bell          | Damped spring kicked from rest: θ(t) = A·e^(−ζω₀t)·sin(ω_d t) | ζ 0.1279, ω₀ 15.486 rad/s (stiffness 239.8, damping 3.96, mass 1), kick 212 °/s, A 13.8°                             | RMS 0.37° |
| Clapper       | Same pivot, φ(t) = 1.257·θ(t − 49.7 ms)                       | gain 1.257, lag 49.7 ms                                                                                              | RMS 0.40° |
| Badge scale   | Spring from scale 0                                           | ζ 0.492, ω₀ 16.85 (stiffness 283.8, damping 16.56), v₀ 8.33/s; peak 1.198 at 176 ms, dip 0.963, settles about 0.75 s | RMS 0.006 |
| Badge opacity | Linear                                                        | 0 → 1 over 173 ms                                                                                                    |           |
| Sequence      | Bell kicked 215 ms after the badge starts                     |                                                                                                                      |           |

Measured bell peaks: +11.6°, −7.8°, +5.1°, −3.7°, +2.3°, −1.5° at about 205 ms intervals, with visible motion ending about 1.6 s after the kick. Positive means clockwise (the bottom swings away from the badge).

The preview samples these closed-form springs at 60 fps into Web Animations API keyframes. Recorded in Chromium against the video frames, aligned at the start of the badge: bell RMS 0.40° (worst 1.9°, at the instant of the kick), clapper RMS 0.43°, badge peak 1.197 at 180 ms, dip 0.967. A new kick, such as a second notification or a click while ringing, adds the measured impulse to the current motion, capped at the reference's 13.8° envelope, so there is never a snap. Clicking with a pointer gives the same kick; keyboard and assistive-technology activation (`click.detail === 0`) give none. Reduced motion: no swing; the badge fades.

Deliberate departures from Emil's rules, at Kuu's request to mirror the reference: the ring runs about 1.8 s (the rule is under 300 ms), and the badge grows from scale 0 (the rule is never from 0).

### Hamburger: squeeze plus pull-through

Pressing gathers the bars (top down 4 units, middle to 75% width, bottom up 4 units, 90 ms). Release springs them apart (CSS `linear()` spring, damping 0.45, 420 ms, middle bar 30 ms later). At the same time, outer wrappers pull each bar 10 px right and fade it (200 ms, 35 ms stagger) as the drawer opens. Closing reverses. Keyboard activation skips the squeeze.

### Emil review applied (Opus reviewer: review-animations, make-interfaces-feel-better, animate)

1. **The drawer covered the hamburger** about 17 ms into opening, so the spring and the pull-through were never visible in the phone frame. Revision 3 moved the drawer below the 56 px header. **Kuu declined that layout change (revision 4)**: the drawer keeps covering the full height, so the pull-through plays under it and is seen as the bars slide back on close. If the layout changes later, the motion shows without further work.
2. A badge arriving in the middle of a spring snapped from 1.2 to 1.0, and an arrival during the read-exit restarted from 0. Fix: retarget from the current scale, velocity and opacity.
3. Swing and clapper moved from SVG `<g>` transforms to stacked HTML wrappers (`transform-origin: 50% 10.4167%`), so the browser can run them off the main thread during hydration or polling.
4. The scrim uses the drawer's curve and timing (enter 260 ms, exit 200 ms).
5. Exits are shorter than entries: drawer 200 ms out / 260 ms in, notification panel 120 ms out / 160 ms in.
6. The drawer's X appears with scale .25 → 1, blur 4px → 0 and a fade (220 ms, 60 ms delay), with no rotation.
7. Keyboard detection uses `event.detail` instead of a global pointer flag.
8. The badge exit holds its final frame (`fill: forwards`).
9. The hamburger drops the .97 press scale; the squeeze is its press feedback.
10. Squeeze distance raised from 3 to 4 units so the release overshoot can be seen.
11. Panel row hover is gated to fine pointers.

### Verified, revision 3 (headless Chromium, Playwright 1.65, file opened directly)

All revision 2 behaviour checks pass again, with timings updated for the longer ring. New checks:

- The press adds the squeeze; opening pulls out the bars and moves focus to the close X.
- Escape brings the bars back and returns focus.
- Keyboard Enter gives no squeeze.
- Nine rapid taps leave a consistent state.
- In a 3-notification burst the badge changes smoothly (largest per-frame change 0.177, which is the normal pop growth).
- An arrival during the read-exit continues from scale 0.709.
- A mid-open screenshot shows the staggered bars above the drawer.
- No console errors.

Not verified: feel on a real phone (including iOS `:active` on touch), a performance trace under load, and screen readers. Application code is unchanged.

## Revision 4: ported into the app

Kuu approved the motion and declined the layout change. The preview drawer covers the full height again, and the motion is in the app on `p1-main`:

- `apps/workspace/src/components/ui/bell-ring.ts`: the fitted bell, clapper and dot springs (the same constants as the preview), sampled into Web Animations keyframes.
- `apps/workspace/src/app/(app)/notifications-bell.tsx` and its CSS: the bell is drawn in two layers. When a poll finds the unread count rising, the dot pops in and the bell rings 215 ms later (100 ms when the dot was already showing). Opening the panel with a pointer rings it. Page load, polls with no rise and keyboard opening stay still, and opening never marks anything read.
- `apps/workspace/src/components/shell/shell-state.tsx`, `shell.module.css`, `sidebar.module.css`: the hamburger squeeze and pull-through, the close X blur-in, and drawer and scrim timing of 260 ms in and 200 ms out on the drawer curve.

Not ported, still proposals: the count badge (the app keeps its unread dot; the dot uses the badge's pop spring), the number roll and the badge exit.
