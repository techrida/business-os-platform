/* global __ENV */
// Load gate: `pnpm perf:load`. Needs the `core` + `app` profiles and a finished `pnpm seed`.
//
//  - 50 virtual users loop for 3 minutes: GET /v1/me (tagged auth_overhead: it measures token and
//    tenancy overhead, NOT database reads; see thresholds.js) and POST /v1/telemetry/vitals
//    (tagged write; a stand-in for the real approve/reject write until P1, see perf-gates.md).
//  - From minute 1, for one minute, 10 requests per second hit the write path on top of that
//    (a constant ARRIVAL rate: k6 starts a request every 100 ms no matter how slow answers are,
//    which is how real traffic behaves and the way to expose queueing).
//  - The token comes from a real client-credentials call as the `bos-loadtest` machine user.
//
// If any threshold in thresholds.js is crossed, k6 exits with code 99.
import encoding from 'k6/encoding';
import http from 'k6/http';
import { check, sleep } from 'k6';

import { buildThresholds } from './thresholds.js';

const API_BASE = (__ENV.K6_API_BASE_URL || 'https://api.localhost').replace(/\/+$/, '');
const ISSUER = (__ENV.OIDC_ISSUER || 'https://auth.localhost').replace(/\/+$/, '');
const THINK_SECONDS = Number(__ENV.K6_THINK_S || 1);

export const options = {
  scenarios: {
    steady: {
      executor: 'constant-vus',
      vus: 50,
      duration: '3m',
      exec: 'steady',
    },
    write_burst: {
      executor: 'constant-arrival-rate',
      rate: 10,
      timeUnit: '1s',
      duration: '1m',
      startTime: '1m',
      preAllocatedVUs: 20,
      maxVUs: 60,
      exec: 'burst',
    },
  },
  thresholds: buildThresholds(),
};

function requiredEnv(name) {
  const value = __ENV[name];
  if (!value) {
    throw new Error(`${name} is not set. Run \`pnpm seed\` first: it writes .dev/k6.env.`);
  }
  return value;
}

/** Same scope as tools/seed-zitadel/src/outputs.ts `loadtestScope`. Keep them in sync. */
function scopeFor(projectId) {
  return [
    'openid',
    `urn:zitadel:iam:org:project:id:${projectId}:aud`,
    'urn:zitadel:iam:org:projects:roles',
    'urn:zitadel:iam:user:resourceowner',
  ].join(' ');
}

/** One real token for the whole run (ZITADEL access tokens last 12 hours by default). */
export function fetchToken() {
  const clientId = requiredEnv('K6_CLIENT_ID');
  const clientSecret = requiredEnv('K6_CLIENT_SECRET');
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
  return { token };
}

export function setup() {
  return fetchToken();
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

/**
 * Auth-overhead probe (CR-14): /v1/me is answered from the request context, so this request exercises JWT
 * validation, the cached org lookup and the HTTP stack, not Postgres.
 * TODO(P1): add a DB-touching read scenario once an authenticated list/detail GET exists.
 */
export function readMeAuthOverhead(token) {
  const res = http.get(`${API_BASE}/v1/me`, {
    headers: authHeaders(token),
    tags: { kind: 'auth_overhead', name: 'GET /v1/me' },
  });
  check(res, {
    'auth overhead: GET /v1/me is 200': (r) => r.status === 200,
    'auth overhead: GET /v1/me has a userId': (r) => typeof r.json('userId') === 'string',
  });
}

export function postVitals(token) {
  const body = JSON.stringify({
    name: 'LCP',
    value: 1200,
    route: '/',
    id: `k6-${__VU}-${__ITER}`,
  });
  const res = http.post(`${API_BASE}/v1/telemetry/vitals`, body, {
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    tags: { kind: 'write', name: 'POST /v1/telemetry/vitals' },
  });
  check(res, { 'POST vitals is 2xx': (r) => r.status >= 200 && r.status < 300 });
}

/** One user iteration: an auth-overhead request, a write, then a pause like a person would take. */
export function iteration(data) {
  readMeAuthOverhead(data.token);
  postVitals(data.token);
  sleep(THINK_SECONDS);
}

export function steady(data) {
  iteration(data);
}

export function burst(data) {
  postVitals(data.token);
}
