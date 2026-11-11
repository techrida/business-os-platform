# Business OS repository working agreement

These instructions apply to every checkout and phase branch of this repository.
The user's current instructions take precedence.

## Linux-only execution and shared runtime ownership

Kuu's explicit instruction (2026-11-11): run all Business OS installs,
typechecks, lint, tests, builds, services, Docker and Playwright inside Ubuntu
WSL with Linux Node 24 and pnpm. Never use native Windows Node/pnpm or other
Windows project execution tools. Prefer the existing ext4 checkout at
`/home/kuu/src/business-os-platform`. The Windows resource queue may wrap a WSL
command; its project-command payload must execute entirely inside Linux.

- Share the checkout and containers sequentially, with one source/runtime owner.
  The current verification order is P2 -> P3 -> P4. Obtain explicit release from
  the current owner before switching source or changing containers or data.
- Preserve `.env`, `.dev`, seeded identities, volumes and existing data. Inspect
  active work and dirty changes before reuse. Do not create duplicate full
  stacks when the existing runtime can be reused safely.
- A phase handoff records exact source heads, runner/start commands, override
  locations, auth/fixture prerequisites, schema upgrades and preserved backups.
  Never print or commit credentials. A Windows test failure is not evidence of
  a Linux regression; verify with the required Linux runtime.

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
