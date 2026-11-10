# Phase chain: limitations and open issues (2026-11-10)

Consolidated for whoever continues (possibly on another machine). Detail for P4 screens: `CASCADE-P4-OPEN-ISSUES.md`. Guide: `CASCADE-P0-UI-CHANGES.md`. Written at `p4/on-p3` 86e46a86.

## Branch state
- Origin has `main` and one branch per phase: p0/ground-floor, p1/platform-kernel, p2/crm-quotations, p3/sales-invoicing, p4/on-p3. `p4/procurement` was merged into `p4/on-p3` and deleted.
- Merges were real merges, ordinary fast-forward pushes, no force, no PRs, nothing merged to main.
- **The chain is not current.** Other sessions kept pushing: P0 gained 939a6d2a (private network removal, not part of the UI cascade), P1 gained about 7 newer commits. P0 is not in P1 and P1 is not in P2 until the forward merge P0→P1→P2→P3→P4 is repeated (one fresh worktree per phase, merge previous phase, check, refetch, fast-forward push). Do this when other sessions have stopped pushing.

## Not verified (never run)
- Browser, render and hydration checks: nobody has seen the UI.
- Docker-backed API and database integration suites (4 API suites on P4 failed to start: Docker socket permission denied on the build machine).
- Docker image builds and the Docker-image exclusion gate.
- End-to-end and live-stack login tests.
- Full test suites on every phase (only typecheck, lint, Prettier, focused and package tests, production builds and the dev-exclusion checker were run).
- The last cascade fix commits on P4 had no separate re-review.

## Known limitations of the checks
- The production dev-exclusion checker uses workspace-shaped fixtures; the portal has no dedicated fixture and no Docker-image inspection. It was run against real workspace and portal production builds.
- Sales-order evidence-label change (`sales-orders/[id]/page.tsx`) has no regression assertion.
- Vitest prints a configuration compatibility warning.

## Product gaps
- Raw IDs and lookup fallbacks remain as visible text in older P1/P2/P4 screens (customers, workflows, inbox, memos, quotations, verification, opportunities, procurement). The "no raw IDs anywhere in product UI" criterion is not met. Fix by carrying names in loaded data or adding a lookup; never disable an action only to hide an ID. Full list in `CASCADE-P4-OPEN-ISSUES.md`.
- The instant passwordless account switcher (Q29) is not built and needs Kuu's decision first. Do not add it as part of the cascade.

## Machine / process notes
- Other sessions' uncommitted or unpushed work exists in local worktrees (`kuu-cascade-ui-p2`, `-p3`, `-p4-on-p3`, `kuu-p1-icon-motion`). Do not delete them blindly; push or discard first.
- Daily session-retire prune (Linux) is written but not installed; its dry run found 0 eligible worktrees (blocked by dirty trees and processes it could not inspect). Chat deletion stays manual and approved.
- Handoff notes with the same content live in life-kb: Techrida/projects/business-os/docs/platform/cascade/PHASE-CHAIN-HANDOFF-2026-11-10.md.
