/* global __ENV */
// The performance gates (NFR numbers) in one place. Plain k6 JavaScript, not Node.
//
// WHAT THE "READ" GATE MEASURES (finding CR-14): it is an AUTH-OVERHEAD gate, not a database-read gate.
// Its request is GET /v1/me, which answers from the request context (JWT check plus a cached org
// lookup) and never queries Postgres. So a pass proves token validation, tenancy context and the HTTP
// stack are fast; it says nothing about database read latency.
// The database-read gate is db-reads.js (`pnpm perf:db-reads`, buildDbReadsThresholds below): the approvals
// inbox count and the quotation list and detail, on seeded data (perf/seed/).
// The environment variable names below keep their old K6_READ_* spelling because compose, package.json
// and .env.example set them; renaming those is a separate change.
//
// Every number can be overridden by an environment variable, which is how we prove the gate can
// fail: `K6_READ_P95_MS=1 pnpm perf:load` must exit 99 (k6's "a threshold was crossed" code).
//
// Compose passes unset variables through as an empty string, so "" counts as "not set".

/** Reads a positive number from the environment; "" or undefined means "use the default". */
function numberFromEnv(name, fallback) {
  const raw = __ENV[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  // A typo such as K6_READ_P95_MS=3oo must stop the run, not quietly use the default and
  // let a gate pass that the operator believed they had tightened.
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}"`);
  }
  return value;
}

export const NFR = {
  authOverheadP95Ms: numberFromEnv('K6_READ_P95_MS', 300),
  authOverheadP99Ms: numberFromEnv('K6_READ_P99_MS', 800),
  writeP95Ms: numberFromEnv('K6_WRITE_P95_MS', 500),
  failedRate: numberFromEnv('K6_FAILED_RATE', 0.01),
  // P1 (approvals.js): the real approve action and the route preview.
  approveP95Ms: numberFromEnv('K6_APPROVE_P95_MS', 300),
  previewP95Ms: numberFromEnv('K6_PREVIEW_P95_MS', 200),
  // Database reads (db-reads.js), ADR 0011: reads p95 under 300 ms and p99 under 800 ms.
  dbReadP95Ms: numberFromEnv('K6_DB_READ_P95_MS', 300),
  dbReadP99Ms: numberFromEnv('K6_DB_READ_P99_MS', 800),
};

/** The `name` tags of the reads db-reads.js measures, one per endpoint. */
export const DB_READ_NAMES = ['inbox_count', 'quotation_list', 'quotation_detail'];

/**
 * k6 thresholds. `{kind:auth_overhead}` selects only the GET /v1/me requests (see the note at the top:
 * auth overhead, no database read), so the slow-ish token request (tagged kind=auth) and writes cannot hide
 * behind fast requests, or the other way round.
 */
export function buildThresholds() {
  return {
    'http_req_duration{kind:auth_overhead}': [
      `p(95)<${NFR.authOverheadP95Ms}`,
      `p(99)<${NFR.authOverheadP99Ms}`,
    ],
    'http_req_duration{kind:write}': [`p(95)<${NFR.writeP95Ms}`],
    // Overall error rate across every request, and checks (status codes, JSON shape).
    http_req_failed: [`rate<${NFR.failedRate}`],
    checks: ['rate>0.99'],
  };
}

/**
 * P1 gates for `pnpm perf:approvals`, selected by the `name` tag that approvals.js puts on every
 * measured request. A threshold can only fail the run if some request carries its tag, and a typo
 * in a tag would leave an empty metric whose p(95) is 0 and passes forever. So each name also has
 * a `count>0` threshold: no samples means a failed gate, not a green one.
 *
 * abortOnFail stays off (k6's default) so the run finishes and the summary prints. k6 still exits
 * with code 99 when any threshold is crossed.
 */
export function buildApprovalsThresholds() {
  return {
    'http_req_duration{name:approve}': [`p(95)<${NFR.approveP95Ms}`],
    'http_req_duration{name:preview}': [`p(95)<${NFR.previewP95Ms}`],
    'http_req_duration{name:write}': [`p(95)<${NFR.writeP95Ms}`],
    'http_reqs{name:approve}': ['count>0'],
    'http_reqs{name:preview}': ['count>0'],
    'http_reqs{name:write}': ['count>0'],
    http_req_failed: [`rate<${NFR.failedRate}`],
    checks: ['rate>0.99'],
  };
}

/**
 * Gates for `pnpm perf:db-reads`, selected by the `name` tag db-reads.js puts on each read (DB_READ_NAMES). As in
 * buildApprovalsThresholds, each name also has a `count>0` threshold so a mistyped tag fails the gate instead of
 * leaving an empty metric that passes.
 */
export function buildDbReadsThresholds() {
  const thresholds = {};
  for (const name of DB_READ_NAMES) {
    thresholds[`http_req_duration{name:${name}}`] = [
      `p(95)<${NFR.dbReadP95Ms}`,
      `p(99)<${NFR.dbReadP99Ms}`,
    ];
    thresholds[`http_reqs{name:${name}}`] = ['count>0'];
  }
  thresholds.http_req_failed = [`rate<${NFR.failedRate}`];
  thresholds.checks = ['rate>0.99'];
  return thresholds;
}

// life-kb: Agents/shared/ui-product-preferences/speed-and-responsiveness.md, Business OS limits.
// Background-job request thresholds measure enqueue latency.
export const FLOW_THRESHOLDS = {
  'http_req_duration{flow:approve-step-1}': ['p(95)<80'],
  'http_req_duration{flow:approve-final-step}': ['p(95)<80'],
  'http_req_duration{flow:open-inbox}': ['p(95)<600'],
  'http_req_duration{flow:submit-memo}': ['p(95)<80'],
  'http_req_duration{flow:create-lead}': ['p(95)<80'],
  'http_req_duration{flow:move-lead-stage}': ['p(95)<80'],
  'http_req_duration{flow:log-activity}': ['p(95)<80'],
  'http_req_duration{flow:save-quotation}': ['p(95)<80'],
  'http_req_duration{flow:generate-pdf}': ['p(95)<600'],
  'http_req_duration{flow:convert-quotation}': ['p(95)<80'],
  'http_req_duration{flow:issue-invoice}': ['p(95)<80'],
  'http_req_duration{flow:create-credit-note}': ['p(95)<80'],
  'http_req_duration{flow:create-debit-note}': ['p(95)<80'],
  'http_req_duration{flow:record-payment}': ['p(95)<80'],
  'http_req_duration{flow:verify-payment}': ['p(95)<80'],
  'http_req_duration{flow:open-vat-register}': ['p(95)<1800'],
  'http_req_duration{flow:open-receivables}': ['p(95)<1800'],
  'http_req_duration{flow:upload-document}': ['p(95)<80'],
  'http_req_duration{flow:scan-document}': ['p(95)<600'],
  'http_req_duration{flow:submit-purchase-request}': ['p(95)<80'],
  'http_req_duration{flow:recommend-vendor-quotation}': ['p(95)<80'],
  'http_req_duration{flow:record-receipt}': ['p(95)<80'],
  'http_req_duration{flow:enter-vendor-bill}': ['p(95)<80'],
  'http_req_duration{flow:approve-bill}': ['p(95)<80'],
  'http_req_duration{flow:save-access-policy}': ['p(95)<80'],
  'http_req_duration{flow:save-approval-workflow}': ['p(95)<80'],
  'http_req_duration{flow:filter-audit-trail}': ['p(95)<600'],
  'http_req_duration{flow:global-search}': ['p(95)<600'],
  'http_req_duration{flow:portal-invoices}': ['p(95)<600'],
  'http_req_duration{flow:portal-submit-quotation}': ['p(95)<80'],
  'http_req_duration{flow:sidebar-navigation}': ['p(95)<600'],
};
