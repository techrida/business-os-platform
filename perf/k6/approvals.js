/* global __ENV */
// Approvals gate: `pnpm perf:approvals`. Needs the `core` + `app` profiles and a finished `pnpm seed`
// (which writes .dev/k6.env with both machine users' credentials). Serves the NFR "10 approvals per
// second stay under 300 ms p95", the real write path P0's load.js could only stand in for.
//
//  - setup(): `bos-loadtest` (role sales) creates and submits 700 test memos of NPR 1,000-98,000
//    (under 1,00,000, so each request has two steps: accountant, then finance). No attachments.
//  - approve: 10 per second for 60 s. `bos-loadtest-approver` (role accountant) approves step 1 of
//    one distinct request per iteration. A different user than the submitter, because of the
//    separation-of-duties rule (risk R13): sales cannot approve its own memos.
//  - preview: 5 per second for 60 s, the route preview a submit form shows before the click.
//  - write: 2 per second for 60 s, memo creation. Audited writes take a per-tenant advisory lock
//    (risk R4), so this is the traffic that would show the lock biting next to approve.
//
// The three scenarios start together on purpose: the gate is about the mix, not each alone.
// Thresholds live in thresholds.js; k6 exits with code 99 when one is crossed.
import encoding from 'k6/encoding';
import exec from 'k6/execution';
import http from 'k6/http';
import { check } from 'k6';

import { NFR, buildApprovalsThresholds } from './thresholds.js';

const API_BASE = (__ENV.K6_API_BASE_URL || 'https://api.localhost').replace(/\/+$/, '');
const ISSUER = (__ENV.OIDC_ISSUER || 'https://auth.localhost').replace(/\/+$/, '');

/** 10/s for 60 s is 600 approvals; the extra 100 absorb arrival jitter. */
const MEMO_COUNT = 700;
/** Requests per http.batch call in setup. Small enough not to flood a laptop, big enough to be quick. */
const SETUP_BATCH = 20;

export const options = {
  // Setup makes 1,400 sequential-by-batch calls plus 2 token calls; k6's default 60 s is too short.
  setupTimeout: '10m',
  scenarios: {
    approve: {
      executor: 'constant-arrival-rate',
      rate: 10,
      timeUnit: '1s',
      duration: '60s',
      preAllocatedVUs: 30,
      maxVUs: 100,
      exec: 'approve',
    },
    preview: {
      executor: 'constant-arrival-rate',
      rate: 5,
      timeUnit: '1s',
      duration: '60s',
      preAllocatedVUs: 15,
      maxVUs: 50,
      exec: 'preview',
    },
    write: {
      executor: 'constant-arrival-rate',
      rate: 2,
      timeUnit: '1s',
      duration: '60s',
      preAllocatedVUs: 5,
      maxVUs: 20,
      exec: 'write',
    },
  },
  thresholds: buildApprovalsThresholds(),
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

/** One real client-credentials token for a machine user (12 hours, so one per run is enough). */
function tokenFor(idVar, secretVar) {
  const clientId = requiredEnv(idVar);
  const clientSecret = requiredEnv(secretVar);
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
    throw new Error(`Token request for ${idVar} failed with HTTP ${res.status}`);
  }
  const token = res.json('access_token');
  if (typeof token !== 'string' || token.split('.').length !== 3) {
    throw new Error(`Token response for ${idVar} has no JWT access_token`);
  }
  return token;
}

function jsonHeaders(token, extra) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extra };
}

/** A memo body under NPR 1,00,000 (the first approval threshold): 1,000.00 to 98,000.00. */
function memoBody(title, n) {
  return JSON.stringify({
    title,
    body: 'k6 approvals load test',
    amount: `${1000 + (n % 98) * 1000}.00`,
    currency: 'NPR',
  });
}

/**
 * Creates and submits MEMO_COUNT memos as sales, SETUP_BATCH at a time, and returns the approval
 * request ids. Setup requests carry their own `name` tags (setup-create, setup-submit), not
 * approve/write, so 700 bulk creates cannot skew the write gate. They still count in
 * http_req_failed, and any non-2xx here aborts the run: a half-built fixture would make the
 * approve scenario fail for the wrong reason.
 */
export function setup() {
  const sales = tokenFor('K6_CLIENT_ID', 'K6_CLIENT_SECRET');
  const approver = tokenFor('K6_APPROVER_CLIENT_ID', 'K6_APPROVER_CLIENT_SECRET');
  const requestIds = [];

  for (let start = 0; start < MEMO_COUNT; start += SETUP_BATCH) {
    const size = Math.min(SETUP_BATCH, MEMO_COUNT - start);

    const created = http.batch(
      Array.from({ length: size }, (_, i) => ({
        method: 'POST',
        url: `${API_BASE}/v1/test-memos`,
        body: memoBody(`k6 setup ${start + i}`, start + i),
        params: { headers: jsonHeaders(sales), tags: { name: 'setup-create' } },
      })),
    );
    const memoIds = created.map((res, i) => {
      if (res.status !== 201) {
        throw new Error(`Setup: memo ${start + i} create returned HTTP ${res.status}`);
      }
      return res.json('id');
    });

    const submitted = http.batch(
      memoIds.map((id) => ({
        method: 'POST',
        url: `${API_BASE}/v1/test-memos/${id}/submit`,
        params: { headers: jsonHeaders(sales), tags: { name: 'setup-submit' } },
      })),
    );
    submitted.forEach((res, i) => {
      if (res.status !== 200 || res.json('status') !== 'pending') {
        // `blocked` would mean the submitter's role cannot be routed: not a load problem.
        throw new Error(
          `Setup: memo ${start + i} submit returned HTTP ${res.status}, status ${res.json('status')}`,
        );
      }
      requestIds.push(res.json('requestId'));
    });
  }

  // Submit sets request.version to 1 (ApprovalsService.submit) and nothing touches it until the
  // first decision, so every approve can send expectedVersion 1 without a GET first.
  return { sales, approver, requestIds, version: 1 };
}

export function approve(data) {
  const index = exec.scenario.iterationInTest;
  // The arrival rate can start a few more iterations than 60 s x 10/s; never reuse a request.
  if (index >= data.requestIds.length) return;

  const res = http.post(
    `${API_BASE}/v1/approvals/requests/${data.requestIds[index]}/actions`,
    JSON.stringify({ action: 'approve', expectedVersion: data.version }),
    {
      // A fresh key per call: replaying one key would measure the cheap idempotent-replay path.
      headers: jsonHeaders(data.approver, {
        'Idempotency-Key': `k6-${exec.vu.idInTest}-${index}-${Date.now()}`,
      }),
      tags: { name: 'approve' },
    },
  );
  check(res, {
    'approve is 200': (r) => r.status === 200,
    // Step 1 of 2 done: still pending (waiting for finance). `approved` would mean a one-step route.
    'approve left a decided step': (r) => ['pending', 'approved'].includes(r.json('status')),
  });
}

export function preview(data) {
  const res = http.post(
    `${API_BASE}/v1/approvals/preview`,
    JSON.stringify({ documentType: 'test_memo', facts: { amountNpr: '50000.00' } }),
    { headers: jsonHeaders(data.sales), tags: { name: 'preview' } },
  );
  check(res, {
    'preview is 200': (r) => r.status === 200,
    'preview has steps': (r) => Array.isArray(r.json('steps')) && r.json('steps').length >= 1,
  });
}

/** Memo creation: the audited write that replaces P0's web-vitals stand-in (risk R13). */
export function write(data) {
  const n = exec.scenario.iterationInTest;
  const res = http.post(`${API_BASE}/v1/test-memos`, memoBody(`k6 write ${n}`, n), {
    headers: jsonHeaders(data.sales),
    tags: { name: 'write' },
  });
  check(res, { 'memo create is 201': (r) => r.status === 201 });
}

/** The numbers of one tagged metric, tolerant of k6 summary layout (`values` wrapper or flat). */
function valuesOf(data, key) {
  const metric = data.metrics[key];
  if (metric === undefined) return undefined;
  return metric.values !== undefined ? metric.values : metric;
}

function line(label, key, limitMs, data) {
  const v = valuesOf(data, key);
  const count = valuesOf(data, key.replace('http_req_duration', 'http_reqs'));
  if (v === undefined || v['p(95)'] === undefined) {
    return `${label}: no samples (the gate cannot pass without them)`;
  }
  const p95 = v['p(95)'];
  const n = count !== undefined && count.count !== undefined ? count.count : '?';
  return `${label}: p95 ${p95.toFixed(1)} ms (limit ${limitMs} ms, ${p95 < limitMs ? 'ok' : 'FAIL'}), ${n} requests`;
}

/**
 * One line per gate, so the lead can quote the numbers. Returning `stdout` replaces k6's default
 * end-of-test summary; the exit code (99 on a crossed threshold) is decided by k6, not by this.
 */
export function handleSummary(data) {
  const failed = valuesOf(data, 'http_req_failed');
  const checks = valuesOf(data, 'checks');
  const dropped = valuesOf(data, 'dropped_iterations');
  const lines = [
    '',
    'approvals gate summary',
    line('approve', 'http_req_duration{name:approve}', NFR.approveP95Ms, data),
    line('preview', 'http_req_duration{name:preview}', NFR.previewP95Ms, data),
    line('write', 'http_req_duration{name:write}', NFR.writeP95Ms, data),
    `failed: ${failed ? (failed.rate * 100).toFixed(2) : '?'} % of requests (limit ${NFR.failedRate * 100} %)`,
    `checks: ${checks ? (checks.rate * 100).toFixed(2) : '?'} % passed`,
    `dropped iterations: ${dropped && dropped.count !== undefined ? dropped.count : 0} (not zero means k6 could not start requests fast enough)`,
    '',
  ];
  return { stdout: lines.join('\n') };
}
