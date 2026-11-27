/* global __ENV */
// Database-read gate: `pnpm perf:db-reads`. Needs the `core` + `app` profiles, a finished `pnpm seed` (which writes
// .dev/k6.env) and the perf rows of perf/seed/db-reads.sql (`bash perf/seed/seed-db-reads.sh`: 5,000 quotations,
// about 50,000 approval steps, a 50 KB document style on every 10th quotation).
//
// Unlike load.js (GET /v1/me, which never touches Postgres), every request here reads real rows:
//   - inbox_count:      GET /v1/approvals/inbox/count   (the sidebar badge poll)
//   - quotation_list:   GET /v1/quotations?limit=25     (the list page)
//   - quotation_detail: GET /v1/quotations/:id          (one quotation with its versions, lines and history)
// The three run side by side, 5 requests per second each for 60 s, as `bos-loadtest-approver` (role accountant:
// it acts on approvals and reads every quotation). Thresholds (thresholds.js, ADR 0011): p95 under 300 ms and
// p99 under 800 ms per read. k6 exits with code 99 when one is crossed.
//
// At the end the summary prints p50 and p95 per read, so QA can record a before and an after number.
import encoding from 'k6/encoding';
import exec from 'k6/execution';
import http from 'k6/http';
import { check } from 'k6';

import { DB_READ_NAMES, NFR, buildDbReadsThresholds } from './thresholds.js';

const API_BASE = (__ENV.K6_API_BASE_URL || 'https://api.localhost').replace(/\/+$/, '');
const ISSUER = (__ENV.OIDC_ISSUER || 'https://auth.localhost').replace(/\/+$/, '');
const RATE = Number(__ENV.K6_DB_READ_RATE || 5);
const DURATION = __ENV.K6_DB_READ_DURATION || '60s';
/** How many quotations setup fetches ids for; detail requests cycle through them. */
const DETAIL_POOL = 200;

function arrival(execName) {
  return {
    executor: 'constant-arrival-rate',
    rate: RATE,
    timeUnit: '1s',
    duration: DURATION,
    preAllocatedVUs: 10,
    maxVUs: 50,
    exec: execName,
  };
}

export const options = {
  scenarios: {
    inbox_count: arrival('inboxCount'),
    quotation_list: arrival('quotationList'),
    quotation_detail: arrival('quotationDetail'),
  },
  thresholds: buildDbReadsThresholds(),
  // p(50) is not in k6's default summary stats.
  summaryTrendStats: ['avg', 'min', 'med', 'p(50)', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

function requiredEnv(name) {
  const value = __ENV[name];
  if (!value) {
    throw new Error(`${name} is not set. Run \`pnpm seed\` first: it writes .dev/k6.env.`);
  }
  return value;
}

/** Same scope as tools/seed-zitadel/src/outputs.ts `loadtestScope`. Keep them in sync (also in load.js). */
function scopeFor(projectId) {
  return [
    'openid',
    `urn:zitadel:iam:org:project:id:${projectId}:aud`,
    'urn:zitadel:iam:org:projects:roles',
    'urn:zitadel:iam:user:resourceowner',
  ].join(' ');
}

function approverToken() {
  const clientId = requiredEnv('K6_APPROVER_CLIENT_ID');
  const clientSecret = requiredEnv('K6_APPROVER_CLIENT_SECRET');
  const projectId = requiredEnv('K6_PROJECT_ID');
  const basic = encoding.b64encode(
    `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`,
  );
  const res = http.post(
    `${ISSUER}/oauth/v2/token`,
    { grant_type: 'client_credentials', scope: scopeFor(projectId) },
    { headers: { Authorization: `Basic ${basic}` }, tags: { kind: 'auth' } },
  );
  if (res.status !== 200) {
    // Never include the response body in the message: it could echo credentials.
    throw new Error(`Token request failed with HTTP ${res.status}`);
  }
  const token = res.json('access_token');
  if (typeof token !== 'string' || token.split('.').length !== 3) {
    throw new Error('Token response has no JWT access_token');
  }
  return token;
}

/** One token, and the ids of seeded quotations for the detail reads. A stack without perf rows stops here. */
export function setup() {
  const token = approverToken();
  const res = http.get(`${API_BASE}/v1/quotations?limit=${DETAIL_POOL}`, {
    headers: { Authorization: `Bearer ${token}` },
    tags: { name: 'setup-quotation-ids' },
  });
  if (res.status !== 200) throw new Error(`Setup: quotation list returned HTTP ${res.status}`);
  // The list answers a bare array (the total is in the X-Total-Count header).
  const ids = res.json().map((q) => q.id);
  if (ids.length < 25) {
    throw new Error(
      `Setup: only ${ids.length} quotations found. Run \`bash perf/seed/seed-db-reads.sh\` first.`,
    );
  }
  return { token, ids };
}

function get(path, token, name) {
  return http.get(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    tags: { name },
  });
}

export function inboxCount(data) {
  const res = get('/v1/approvals/inbox/count', data.token, 'inbox_count');
  check(res, {
    'inbox count is 200': (r) => r.status === 200,
    'inbox count has a number': (r) => typeof r.json('count') === 'number',
  });
}

export function quotationList(data) {
  const res = get('/v1/quotations?limit=25', data.token, 'quotation_list');
  check(res, {
    'quotation list is 200': (r) => r.status === 200,
    'quotation list has a page': (r) => Array.isArray(r.json()) && r.json().length > 0,
  });
}

export function quotationDetail(data) {
  const id = data.ids[exec.scenario.iterationInTest % data.ids.length];
  const res = get(`/v1/quotations/${id}`, data.token, 'quotation_detail');
  check(res, {
    'quotation detail is 200': (r) => r.status === 200,
    'quotation detail has versions': (r) => (r.json('versions') || []).length > 0,
  });
}

/** The numbers of one tagged metric, tolerant of k6 summary layout (`values` wrapper or flat). */
function valuesOf(data, key) {
  const metric = data.metrics[key];
  if (metric === undefined) return undefined;
  return metric.values !== undefined ? metric.values : metric;
}

function line(name, data) {
  const v = valuesOf(data, `http_req_duration{name:${name}}`);
  const count = valuesOf(data, `http_reqs{name:${name}}`);
  if (v === undefined || v['p(95)'] === undefined) {
    return `${name}: no samples (the gate cannot pass without them)`;
  }
  const n = count !== undefined && count.count !== undefined ? count.count : '?';
  return (
    `${name}: p50 ${v['p(50)'].toFixed(1)} ms, p95 ${v['p(95)'].toFixed(1)} ms, p99 ${v['p(99)'].toFixed(1)} ms ` +
    `(limit ${NFR.dbReadP95Ms} ms, ${v['p(95)'] < NFR.dbReadP95Ms ? 'ok' : 'FAIL'}), ${n} requests`
  );
}

/** One line per read, so QA can quote the numbers. The exit code (99 on a crossed threshold) is k6's. */
export function handleSummary(data) {
  const failed = valuesOf(data, 'http_req_failed');
  const checks = valuesOf(data, 'checks');
  const dropped = valuesOf(data, 'dropped_iterations');
  const lines = [
    '',
    'db-reads gate summary',
    ...DB_READ_NAMES.map((name) => line(name, data)),
    `failed: ${failed ? (failed.rate * 100).toFixed(2) : '?'} % of requests (limit ${NFR.failedRate * 100} %)`,
    `checks: ${checks ? (checks.rate * 100).toFixed(2) : '?'} % passed`,
    `dropped iterations: ${dropped && dropped.count !== undefined ? dropped.count : 0}`,
    '',
  ];
  return { stdout: lines.join('\n') };
}
