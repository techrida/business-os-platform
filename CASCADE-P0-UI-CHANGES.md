# Cascade: the P0 UI changes, to carry into P1 to P4

For whoever rebases P1 to P4. Written 2026-11-09 by Claude Code for Kuu, after the UI work on P0 (branch `p0/ground-floor`). The 12 commits are on this branch, on top of `1af8297`. The same changes also exist as email-free patch files in life-kb (`Techrida/projects/business-os/docs/platform/cascade/p0-ui-changes/`); applying those to `1af8297` gives a tree identical to this branch (verified: empty diff).

Why this exists: P1 to P4 still carry what P0 just lost. They show phase tags on unbuilt nav rows, the "P0: platform ready" card with raw ids, "Search (coming soon)", and a sidebar that scrolls as one column. They have no dev menu. Rule behind it: **a product shows the product only** (life-kb: `Techrida/conventions.md`, `Techrida/decisions-log.md`; UI log with before/after screenshots: `Techrida/projects/business-os/docs/platform/figma/UI-CHANGES.md`).

## 1. What is in the series

The 12 commits, oldest first (the number is the order to apply them in):

1.  `6ef4bae` fix(workspace): the sidebar scrolls only its nav, so the user card stays visible
2.  `2d2b2e7` feat(workspace): unbuilt nav items are plain disabled rows, no phase tags
3.  `1747f03` fix(workspace): header search placeholder no longer says coming soon
4.  `8e238ab` feat(workspace): overview drops the P0 status card and the raw ids
5.  `f1c24e1` test(workspace-e2e): assert the new overview heading
6.  `d587ec3` feat(workspace): dev-only /dev/api/whoami route for the dev menu
7.  `4dc3bcc` test(workspace): whoami route is 404 in production, allow-lists its body, never leaks tokens
8.  `0744528` feat(workspace): pure state and whoami formatting for the dev menu
9.  `8f9d4fc` test(workspace): dev menu state parsing and whoami formatting
10. `b983223` ci(workspace): the dev-route check also fails on the dev menu marker
11. `14904da` test(workspace): the dev-route check catches the dev menu and the whoami route
12. `bea11f3` feat(workspace): floating dev menu with a who-am-I panel

The table says what each one does.

| NN  | Change                                                                                                     | Files                                                        | Tests          | Why                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------- |
| 01  | Sidebar scrolls only its nav; the user card stays pinned                                                   | `sidebar.module.css`                                         | none (CSS)     | At 1440 by 900 the card and the last rows were below the fold; the whole column scrolled, brand included.         |
| 02  | Unbuilt nav rows are plain disabled rows, no P1/P2/Later pills                                             | `nav.ts`, `nav.test.ts`, `sidebar.tsx`, `sidebar.module.css` | `nav.test.ts`  | Build status is not product content. Screen readers hear "not available yet". `phase` stays as internal data.     |
| 03  | Header search placeholder "Search", not "Search (coming soon)"                                             | `header.tsx`                                                 | none           | Roadmap text.                                                                                                     |
| 04  | Overview drops the P0 card and the ids; reads "Welcome back" and "Nothing needs your attention right now." | `(app)/page.tsx`, `(app)/shell.module.css`                   | e2e (05)       | The card was the P0 exit proof. No time-of-day greeting: the server cannot know the user's time zone.             |
| 05  | e2e asserts the new heading                                                                                | `e2e/personas.spec.ts`, `e2e/lcp.spec.ts`                    | itself         | Five assertions named "P0: platform ready".                                                                       |
| 06  | Dev-only `/dev/api/whoami` route                                                                           | `src/app/dev/api/whoami/route.dev.ts`                        | 07             | Calls the production `getSession()` and `getMe()`. 404 outside development. Allow-listed body, never a token.     |
| 07  | Test for 06                                                                                                | `route.dev.test.ts`                                          | itself         | 404 in production, six keys only, no token in the body, 502 when the API fails.                                   |
| 08  | Pure state and whoami formatting for the dev menu                                                          | `src/dev/dev-menu-state.ts`                                  | 09             | DOM-free so it tests in plain node.                                                                               |
| 09  | Test for 08                                                                                                | `dev-menu-state.test.ts`                                     | itself         | Garbage JSON, wrong types, signed-out, no extra keys.                                                             |
| 10  | Build check also fails on the dev menu marker                                                              | `scripts/check-no-dev-routes.mjs`                            | 11             | A production build must not contain `BOS_DEV_MENU`.                                                               |
| 11  | Test for 10                                                                                                | `scripts/check-no-dev-routes.test.ts`                        | itself         | Marker in a client chunk, in `standalone/`, ignored under `cache/` and `dev/`, `/dev/api/whoami` in the manifest. |
| 12  | Floating dev menu with a who-am-I panel                                                                    | `src/dev/dev-menu.ts`, `src/instrumentation-client.ts`       | manual (below) | Shadow DOM widget behind a `NODE_ENV` check. A Dev pill above the user card; Ctrl+Shift+D hides it.               |

## 2. How to apply

Do it on P1 only, then move the rest with rebases. Stacking on the remote today: P1 to P2 is a straight line (P2 contains P1). **P4 is built on P2's tip**, and **P3 forks from inside P2's history** (it does not contain all of P2). None of them contains P0's last commits: all fork from P0's commit just before its tip.

```bash
git fetch origin
git switch p1/platform-kernel
git cherry-pick 6ef4bae 2d2b2e7 1747f03 8e238ab f1c24e1 d587ec3 4dc3bcc 0744528 8f9d4fc b983223 14904da bea11f3
# it stops at 2d2b2e7 (nav tags) and 1747f03 (header): expected, resolve as in section 3, then
#   git add <files> && git cherry-pick --continue
```

Then carry the result up (this rewrites those branches, so each needs a force-push with lease and Kuu's say-so for the open PRs):

```bash
git rebase --onto p1/platform-kernel <old-p1-tip> p2/crm-quotations   # old tips: p1 292c03f, p2 e7edc72
git rebase --onto p2/crm-quotations  <old-p2-tip> p4/procurement
# P3: rebase it onto the new P2 too (git merge-base shows where it forked)
```

Do not cherry-pick onto P2, P3 and P4 separately: the rebases carry the commits, and doing both duplicates them.

## 3. Conflicts (tested 2026-11-09: each commit checked alone against P1, P2, P3 and P4)

Same result on all four branches: **commits 01, 04 to 12 apply as they are. 02 and 03 conflict.** Resolve by meaning, not by text.

- **02, nav tags** (`2d2b2e7`). P1 to P4 import `visibleGroups` next to `phaseTag` and `phaseDescription` in `sidebar.tsx`, and keep `SHIPPED_PHASES` in `nav.ts` (P4: `['P0','P1','P2','P4']`) instead of P0's `BUILT_PHASE`. Intent to keep: (a) `PlannedItem` renders no tag and its title and screen-reader text say "not available yet"; (b) delete `phaseTag()` and `phaseDescription()`, their imports and their `describe('phase text')` test; (c) delete the `.tag` rule in `sidebar.module.css` (it is in the rail query too); (d) keep `phase`, `SHIPPED_PHASES`, `audience` and `visibleGroups` as they are, rewrite their comments to say the phase is internal and never shown. Keep everything P1 to P4 added (admin audience, permission filtering, the extra nav tests).
- **03, header** (`1747f03`). Change only the placeholder string to `Search`. P1 also edited this file for the notifications bell; keep that.
- **Overview page.** P1 to P4 never touched `(app)/page.tsx`, so 04 applies. Confirm that no later phase added content to the page that still depends on `getMe`.
- **e2e.** P1 added TOTP to the persona login and a staff-only heading assertion. 05 only replaces the heading name `P0: platform ready` (P1 has two such assertions, one meant to be absent for non-staff). Keep the absence assertion.
- **`check-no-dev-routes.test.ts`.** P3 and P4 edited it as well; 11 applies alone, but re-run it.
- **Dev menu (06 to 12).** `getMe` and the six whoami fields exist on all branches (checked P1 and P4). P1 and later add fields to `/v1/me`: the route copies six fields by name, so do not widen it.

## 4. Check each branch before moving on

Use a scratch copy for the production build: a build overwrites `.next`, which a running `next dev` is using.

1. `pnpm --filter @bos/workspace typecheck`, `pnpm --filter @bos/workspace test`, `pnpm exec eslint apps/workspace --max-warnings 0`, `pnpm exec prettier --check apps/workspace`.
2. Production build in a scratch copy, then `node apps/workspace/scripts/check-no-dev-routes.mjs` must print OK, and `grep -r BOS_DEV_MENU .next` (outside `cache/`) must find nothing.
3. e2e: `pnpm --filter @bos/workspace e2e` with the stack up and `BOS_E2E_NEXT_DEV=1` against `next dev`.
4. In a real browser as the Founder: the sidebar at a window 520 px high still shows the user card and the brand while the list scrolls; no pill text in the nav; "Welcome back"; the Dev pill opens and shows the session facts; **the browser console has no hydration warning and Next shows no "1 Issue" badge**.
5. Add a dated entry to life-kb `UI-CHANGES.md` only if the branch changes the look differently from P0.

## 5. Things learned the hard way

- **Hydration.** The dev menu first appended its host to `<body>` before React hydrated, and React reported a mismatch (Next's "1 Issue"). Neither agent that wrote it saw this because they never opened a browser. Commit 12 already mounts after `load` and an idle callback. Keep that if you edit the widget.
- **Shadow DOM text.** A host element's `innerText` is empty; read `host.shadowRoot` in tests, or take a screenshot.
- **KB images.** The KB's `.gitattributes` forces text line endings under `docs/`, which corrupts PNGs. `*.png binary` is now at the end of that file. Check images are byte-identical after a commit.
- **Next generates `apps/workspace/AGENTS.md`** every time `next dev` runs. Do not commit it by accident. (Open: set `agentRules: false` in `next.config.ts`, or commit it once.)
- **Docker on Linux.** Not in the `docker` group means no socket. `docker compose run` without `-T` and `</dev/null` swallows the rest of a script.
- **`next build` and `next dev` share `.next`.**

## 6. Instant development account switcher

Implemented following Kuu's 2026-11-10 approval for seeded and manually created
local development users. The Dev menu and `/dev/personas` list active human users
from ZITADEL on every refresh. A POST revalidates the account, creates a real
ZITADEL user-only session with a dedicated local `IAM_LOGIN_CLIENT`, completes a
real authorization request, and redirects through the existing PKCE/browser-bound
callback. The API remains authoritative for roles and organization access. Users
without application roles follow the normal no-access behavior. No passwords,
OTP seeds or identity/session tokens are returned to the browser.

Provision each disposable local stack independently:

1. Copy `/zitadel/bootstrap/admin.pat` from that stack's zitadel-api container to
   an ignored owner-only local file. Do not print it or reuse a different stack's token.
2. Run `infra/scripts/dev-login-client.mjs` with `NODE_ENV=development`,
   `NODE_EXTRA_CA_CERTS` pointing at the local CA,
   `BOS_DEV_BOOTSTRAP_TOKEN_FILE` pointing at the copied bootstrap token and
   `BOS_DEV_LOGIN_CLIENT_TOKEN_FILE` pointing at a new ignored output file.
   Load the matching `.dev/zitadel.env` with Node's `--env-file` option. The script
   grants only `IAM_LOGIN_CLIENT` and writes a 30-day token with mode 0600.
   An existing output file is never overwritten. Remove the temporary bootstrap copy.
3. Set `BOS_DEV_LOGIN_CLIENT_TOKEN_FILE` in the `next dev` process and restart it.
   Existing `OIDC_ISSUER`, client/audience/redirect and `WORKSPACE_PUBLIC_URL`
   must describe the same local stack. No seed rerun or data reset is required.
4. Open `/dev/personas` while signed out, or Accounts in the Dev menu. Refresh
   Accounts to discover newly created users. Rotate the dev token when it expires.

Local configured `*.bos.test` and `*.localhost` hosts are supported. Switching
requires a same-origin POST and is rate limited. Production route discovery omits
all `.dev` routes; the post-build checker also scans for the server service/token
configuration markers. Missing dev token setup fails closed with a helpful message.
Never configure this client or token on a production identity instance.

## 7. Other open items from the same session (not started)

- `/staff-only` and `/no-access` have only "Sign out". Add "Use a different account" (starts `/auth/login?prompt=login`). "Overview" would loop: `/` sends non-staff back to `/staff-only`.
- Restyle the ZITADEL login: set ZITADEL's branding policy (colours, logo, font) from the seed so it looks like the product. Verified: the policy is readable on the stack and still on defaults. Which layout and copy it can change in v4.20.1 is untested. Later option: our own login screens over ZITADEL's Session API.
- Critique items in life-kb `UI-CHANGES.md`: header shows a lowercase role instead of the page title; the user-card chevron does nothing; no `:active` press feedback on nav rows; hover not gated by `@media (hover: hover)`; the drawer curve; Next's dev indicator versus the dev pill.

## 8. This Linux PC (what was set up, for reference)

Docker Compose runs on the host (decision D5). Done on this machine: `systemctl enable --now docker`; user added to the `docker` group (a shell started earlier needs `newgrp docker`); Caddy's root certificate imported into `~/.pki/nssdb` for Chromium; a `ufw` rule `allow from 172.16.0.0/12 to any port 3000 proto tcp` so Caddy can reach `next dev`; Node 24 and pnpm 11 through mise; Playwright's browser installed. The Workspace runs as `next dev` on port 3000 (not the container) because the persona page and the dev menu only exist in development. It needs these environment values, read from `.env` and `.dev/zitadel.env` (never print them): `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_AUDIENCE`, `OIDC_REDIRECT_URI=https://app.localhost/auth/callback`, `WORKSPACE_PUBLIC_URL=https://app.localhost`, `API_INTERNAL_URL=https://api.localhost`, `VALKEY_URL`, `OIDC_STATE_VALKEY_URL` (the same Valkey is fine in dev), `SESSION_ENC_KEY`, `SESSION_ENC_KEY_ID=k1`, `BOS_DEV_LOGIN_RATE_LIMIT=200`, `BOS_DEV_PERSONAS_FILE=<repo>/.dev/personas.json`, `NODE_EXTRA_CA_CERTS=<repo>/.dev/caddy-root.crt`, started with `next dev -H 0.0.0.0 -p 3000` and Caddy recreated with `WORKSPACE_UPSTREAM=host.docker.internal:3000`. The start script used lived in a temporary folder and is gone; a proper `infra/scripts/dev-workspace.sh` in the repo is a good small follow-up.
