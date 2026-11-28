/* global __ENV */
import exec from 'k6/execution';
import { check, fail } from 'k6';
import { request } from './staff.js';

export const summaryTrendStats = ['med', 'p(95)', 'p(99)', 'count'];
export function arrivals(name, rate, vus) {
  return {
    executor: 'constant-arrival-rate',
    rate: Number(__ENV.K6_PERF_RATE || rate),
    timeUnit: '1s',
    duration: __ENV.K6_PERF_DURATION || '60s',
    preAllocatedVUs: vus,
    maxVUs: vus * 3,
    exec: name,
  };
}
export function command(token, flow, method, path, body, status = 201) {
  const key = [exec.scenario.name, exec.scenario.iterationInTest, Date.now(), flow].join('-');
  return request(token, flow, method, path, body, status, key).json();
}
export function decide(token, flow, id, version, expectedStatus) {
  const result = command(
    token,
    flow,
    'POST',
    '/v1/approvals/requests/' + id + '/actions',
    { action: 'approve', expectedVersion: version },
    200,
  );
  if (!check(result, { [flow + ' status']: (r) => r.status === expectedStatus }, { flow }))
    fail(flow + ' left request ' + result.status);
  return result.version;
}
