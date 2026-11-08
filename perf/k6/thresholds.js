/* global __ENV */
// The performance gates (NFR numbers) in one place. Plain k6 JavaScript, not Node.
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
  readP95Ms: numberFromEnv('K6_READ_P95_MS', 300),
  readP99Ms: numberFromEnv('K6_READ_P99_MS', 800),
  writeP95Ms: numberFromEnv('K6_WRITE_P95_MS', 500),
  failedRate: numberFromEnv('K6_FAILED_RATE', 0.01),
};

/**
 * k6 thresholds. `{kind:read}` selects only requests tagged kind=read, so the slow-ish token
 * request (tagged kind=auth) and writes cannot hide behind fast reads, or the other way round.
 */
export function buildThresholds() {
  return {
    'http_req_duration{kind:read}': [`p(95)<${NFR.readP95Ms}`, `p(99)<${NFR.readP99Ms}`],
    'http_req_duration{kind:write}': [`p(95)<${NFR.writeP95Ms}`],
    // Overall error rate across every request, and checks (status codes, JSON shape).
    http_req_failed: [`rate<${NFR.failedRate}`],
    checks: ['rate>0.99'],
  };
}
