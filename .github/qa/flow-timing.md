# QA flow timing (report only)

`timeAction(name, button, expectResult)` in `apps/workspace/e2e/helpers/flow-timing.ts` starts a monotonic clock after a trial click, clicks the final confirmation, and stops at the visible result. The callback must wait for a new visible result, not an element already on screen. Failed assertions propagate; a callback can return `false` for a failed attempt that the spec already retries (e.g. a proof still scanning).

Each attempt appends one `{ name, pageMs, ok, requestIds }` record to `.dev/qa-flow-timings.jsonl`. The IDs are opaque Caddy request IDs, not record IDs or customer data. Caddy exposes the same ID it forwards to Workspace; Workspace forwards it to its API calls. The helper collects responses for same-origin browser requests that started during the action window. Background jobs and input preparation are not timed.

From the repository root, after the fixture and spec runs finish:

```sh
node .github/qa/flow-backend.mjs .dev/qa-flow-timings.jsonl .dev/logs/api.log
node .github/qa/flow-summary.mjs .dev/qa-flow-timings.jsonl .dev/logs/api.log
```

The backend script emits the same rows with `backendMs` added. It joins the API's request-completion records by `req.id` and uses the API's `responseTime`, in milliseconds. A flow's backend time sums its matched action POSTs (not incidental page reads, previews, or background jobs). Unmatched samples have `backendMs: null`, not zero. This measures time spent in the API action requests, not server wall-clock time across parallel requests.

The summary computes nearest-rank p50, p95, and p99 from successful attempts and reports counts of failed attempts and successful attempts with no matching API request. It lists every flow including those with no samples. The limits file (`flow-limits.json`) contains placeholder p95 limits; a breach is reported, not a failing exit status. P-9 owns the real limits and the main-only gate.

CI integration (P-1/P-9): start each QA run with a fresh timing file and append the fixture and spec timings to it; for separate jobs/shards use `BOS_QA_FLOW_TIMINGS_FILE` to set the output path and collect each shard's timing and API log together. Run the summary against the paired files before deleting the logs. P-1 owns the existing `approve-timing.mjs` and fixture approval timer; to add step-one fixture samples use `timeAction('approve-step-1', confirm, visibleResult)` around the confirmation click for first-step approvals only. The memo exit test already does this. The old approval report is not changed here.
