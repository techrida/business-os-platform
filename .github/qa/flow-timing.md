# QA flow timing

`timeAction(name, button, expectResult)` in `apps/workspace/e2e/helpers/flow-timing.ts` starts a monotonic clock after a trial click, clicks the final confirmation, and stops at the visible result. The callback must wait for a new visible result, not an element already on screen. Failed assertions propagate; a callback can return `false` for a failed attempt that the spec already retries (e.g. a proof still scanning).

Each attempt appends one `{ name, pageMs, ok, requestIds }` record to `.dev/qa-flow-timings.jsonl`. The IDs are opaque Caddy request IDs, not record IDs or customer data. Caddy exposes the same ID it forwards to Workspace; Workspace forwards it to its API calls. The helper collects responses for same-origin browser requests that started during the action window. Background jobs and input preparation are not timed.

From the repository root, after the fixture and spec runs finish:

```sh
node .github/qa/flow-backend.mjs .dev/qa-flow-timings.jsonl .dev/logs/api.log
node .github/qa/flow-summary.mjs .dev/qa-flow-timings.jsonl .dev/logs/api.log
```

The backend script emits the same rows with `backendMs` added. It joins the API's request-completion records by `req.id` and uses the API's `responseTime`, in milliseconds. A flow's backend time sums its matched action POSTs (not incidental page reads, previews, or background jobs). Unmatched samples have `backendMs: null`, not zero. This measures time spent in the API action requests, not server wall-clock time across parallel requests.

The summary computes nearest-rank p50, p95, and p99 from successful attempts and reports counts of failed attempts and successful attempts with no matching API request. It lists every flow including those with no samples. On release pull requests targeting main, `--gate` requires a successful page sample and matching backend requests for every browser flow in `flow-limits.json`. Page p95 above 400 ms through 500 ms passes with the note “above the good line (400 ms): Kuu decides whether to optimise”. Above 500 ms fails, and above 1,000 ms is labelled poor. Backend p95 fails above the flow’s configured poor line.
