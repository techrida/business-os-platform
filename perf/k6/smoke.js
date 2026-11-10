// Smoke test: one user for 10 seconds, same requests and same thresholds as load.js.
// Run it before the full load test to catch a wrong URL, token or stack that is not up:
//   docker compose ... --profile tools run --rm k6 run /perf/smoke.js
import { buildThresholds } from './thresholds.js';
import { fetchToken, iteration } from './load.js';

export const options = {
  vus: 1,
  duration: '10s',
  thresholds: buildThresholds(),
};

export function setup() {
  return fetchToken();
}

export default function (data) {
  iteration(data);
}
