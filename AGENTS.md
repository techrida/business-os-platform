# Business OS repository working agreement

These instructions apply to every checkout and phase branch of this repository.
The user's current instructions take precedence.

## Git and PR attribution

Kuu's instruction (2026-11-16): commits use only Kuu's verified GitHub identity
(currently `Kuu44`) as author and committer. Do not add AI, provider, agent or
model names, `Co-Authored-By` trailers, generated-by footers or AI credits to
commit messages or pull request titles/descriptions. This applies to every
phase, merge commit, delegated session and subagent; pass it in delegation briefs
and inspect incoming commit messages before integrating their work. Provider
defaults do not override this rule. Preserve legitimate third-party history and
required license notices. Do not rewrite published history without Kuu's
explicit authorization.

## Phase changes must cascade

Kuu's standing instruction (2026-11-10): when a change lands on a lower phase,
carry it through every applicable higher phase as part of the same task. Do not
wait for Kuu to repeat the cascade request.

- Discover the current branch graph and active sessions before editing. The known
  branches are `p0/ground-floor`, `p1/platform-kernel`, `p2/crm-quotations`,
  `p3/sales-invoicing` and `p4/on-p3`. The former `p4/procurement` line was
  consolidated into `p4/on-p3` at 77a314ea and its remote branch removed. Preserve
  sales and procurement in the combined P4 line; do not recreate a retired branch.
- Use coordinated, correctly bound sessions for affected phases when supported
  by the active harness. Assign one writer per checkout and coordinate overlapping
  files. Create enough sessions to cover the affected branches; do not start
  duplicate writers or introduce another provider/model without authorization.
- Prefer normal ancestry-preserving merges from the owning lower phase. Resolve
  conflicts against each target's actual behavior. Never overwrite a higher
  phase's features with lower-phase files or rewrite published history.
- Preserve dirty changes, runtime configuration and seeded data. Commit only
  scoped work. Verify the exact source and target heads before each integration.
- Run relevant checks on each phase, including dev/production boundaries and
  browser workflows when affected. Record what passed, failed or was not run.
- When delivery is authorized, push the integrated phase branches and verify
  remote heads. Report every affected branch and any outstanding dependency.
  A local commit or a launched session is not a completed cascade.
- Scoped feature merges do not authorize merging full-phase PRs. For the instant
  development account switcher, leave PR #1 (P0 to main) and #2 (P1 to P0) open.
  Do not create repeated feature copies or independently redesign the same change.

## Development runtime and account switcher

- Keep P0 and P1 runtime addresses, containers and data isolated. The P1 checkout
  is `/home/crestia/.codex/worktrees/bos-p1`; its local workspace is
  `https://app.p1.bos.test`, with `next dev` on port 3101. P0 uses its own runtime.
  Inspect live state rather than assuming a service is running.
- Never run `next build` into `.next` while `next dev` uses it. Use an isolated
  scratch build for production checks.
- Kuu approved instant switching for seeded AND manually created development
  users (2026-11-10): one click, no password or second-factor entry. This is
  development tooling only, including configured local `*.bos.test` hosts.
  Preserve real identity roles and scopes, protect switch requests from
  cross-origin use, reject disabled users, and keep credentials server-side.
- Production must not contain the switcher UI or dev account routes, and its
  authentication must not be weakened. Verify the production exclusion checks.
- The generated `apps/workspace/AGENTS.md` contains framework guidance; preserve
  it and follow applicable Next.js documentation before changing framework code.

Attribution: Codex, following Kuu's explicit instructions on 2026-11-10.
