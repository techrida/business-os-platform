# Phase 3 Linux runtime handoff

Run all project commands in Ubuntu WSL at
`/home/kuu/src/business-os-platform`, after `source infra/scripts/env.sh`.
Use Linux Node 24 and pnpm. The Windows host resource queue may wrap a WSL
payload; native Windows project execution is not supported.

## Ownership and preserved data

The shared verification order is P2 -> P3 -> P4. Obtain explicit release before
switching source or changing containers/data. Inspect the current head, dirty
files and exact process ownership. Preserve the existing environment, identities,
volumes and demo records. Do not use the force-reset branch option of
`infra/scripts/w.sh`.

P3 reuses the existing `bos-qa-p2-4` project and protected configuration described
in [p2-linux-runtime.md](p2-linux-runtime.md). The incompatible legacy `bos`
database remains preserved and stopped. No duplicate full stack was created.

The compatible QA migration ledger advanced from 20 to 26 using existing P3
migrations 0019 through 0024. Previous hashes and entries were retained and the
tenancy check passed. The protected pre-P3 dump is
`/var/tmp/agents-bosqa-p3/p3-before-upgrade.dump`.

P3 seeding checked that every existing grant remained unchanged. It added the
P3 grants, workflows and zero-rate demo withholding codes. Master-data preparation
reused the seeded customer portal party, added its missing customer master only
if needed, and created a unique foreign QA customer. It did not seed invoices,
payments or ledger rows. Financial fixtures use real application commands and
independent approvals. Repeating preparation creates new consumable demo records.

## Safe service startup

Keep a foreground WSL session active. Docker's systemd services alone did not
prevent this machine's idle shutdown. The task-owned keepalive uses a foreground
`tail -f /dev/null`; app terminals also keep WSL active. Do not stop unrelated
processes.

The following private scripts enter the ext4 checkout and load existing
protected runtime configuration. Run each heavy job through the shared host
resource queue with a WSL payload:

```bash
bash /var/tmp/agents-bosqa-p3/core-start.sh
bash /var/tmp/agents-bosqa-p3/api-serve.sh
bash /var/tmp/agents-bosqa-p3/workspace-serve.sh
bash /var/tmp/agents-bosqa-p3/portal-serve.sh
```

The core script starts the same core/files/PDF services and preserves volumes.
It does not repeat migrations or seeding. API and worker use metrics ports 9464
and 9465. Both workspace (port 3000) and portal (port 3002) serve checked production
builds for this acceptance run. The portal uses its dedicated OIDC client,
callback and session-key ID. Credentials stay in protected files and server
processes; never print or commit them. The API runner uses the P3 loader
`/var/tmp/agents-bosqa-p3/env.sh`, which retains the P2 loader and explicitly
adds the registered portal client to `OIDC_ALLOWED_AZP`. Without that entry
portal authentication reaches the API but receives 401. This adds no wildcard
and does not relax token signature, issuer, audience or client checks.

Browser origins are `https://app.localhost`, `https://portal.localhost`,
`https://auth.localhost` and `https://api.localhost`. Stop only recorded task-owned
app processes before changing phase source or production-building either app.
Never production-build into an output directory used by active development.
Build the complete higher-phase source before applying further migrations;
never relabel an applied hash.

## Checks and browser fixtures

The Linux runners are `/var/tmp/agents-bosqa-p3/checks.sh` and
`/var/tmp/agents-bosqa-p3/builds.sh`. Tested heads, results and caveats are recorded
in [p3-issues.md](p3-issues.md); detailed logs stay with the task handoff.

Staff browser checks use
`/var/tmp/agents-bosqa-p3/browser-run.sh`, the existing protected P2 personas and
P3 fixture inputs from protected `/var/tmp/agents-bosqa-p3/fixtures.env`.
The P3 suite does not use the development account switcher and was run against
production-mode Next servers. P0 shell switcher coverage needs a separate
development-mode server and is not part of these P3 commands. Run the staff suite with:

```bash
bash /var/tmp/agents-bosqa-p3/browser-run.sh p3 --max-failures=1
bash /var/tmp/agents-bosqa-p3/portal-run.sh p3/billing.spec.ts --max-failures=1
```

These browser commands create disposable payment submissions. The allocation
tests require the explicit `BOS_E2E_PAYMENT_VERIFIED` and
`BOS_E2E_INVOICE_ISSUED` pair, allocate NPR 1.00 and append a reasoned reversal;
they never choose an arbitrary payment for financial writes. They can be
repeated while that fixture pair is still open. Portal storage state expires:
renew it through the real customer login using
`browser-run.sh --config=/var/tmp/agents-bosqa-p3/fixture.config.ts portal-fixture.spec.ts`.
That login helper reads existing invoice identifiers; it does not issue invoices.
The protected `invoice-fixtures.json` and `payment-fixtures.json` retain the
record identifiers. Do not run the full invoice preparation blindly: the
existing real financial records are intentionally retained.

The portal Playwright config reuses the local-CA verification
helper, keeps HTTPS validation enabled and disables traces/videos. Customer
storage state and all persona credentials remain outside Git.

The T3 browser rejected the local certificate with
`ERR_CERT_AUTHORITY_INVALID`. Linux Playwright uses the explicit trusted CA;
no blanket certificate-error bypass or Windows trust-store change was made.

Current plans and assumed defaults:

```text
/mnt/f/Projects/Life/life-kb/Techrida/projects/business-os/docs/platform/P3-BUILD-PLAN.md
/mnt/f/Projects/Life/life-kb/Techrida/projects/business-os/docs/platform/OPEN-DECISIONS.md
```

Kuu authorized recommended defaults for unanswered blocking decisions. Retain the
existing subledger, VAT-slice reconciliation, permission-gated Finance drafts,
portal visibility, evidence requirements and distinct approvers. Local demo
configuration does not establish accountant certification or authorize payouts.
