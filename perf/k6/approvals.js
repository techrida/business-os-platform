import exec from 'k6/execution';
import { staffToken } from './lib/staff.js';
import { arrivals, command, decide, summaryTrendStats } from './lib/workload.js';
import { buildApprovalsThresholds } from './thresholds.js';

export const options = {
  summaryTrendStats,
  scenarios: {
    approve: arrivals('approve', 10, 30),
    preview: arrivals('preview', 5, 15),
    write: arrivals('write', 2, 5),
  },
  thresholds: {
    ...buildApprovalsThresholds(),
    'http_req_duration{name:approve-final}': ['p(95)<80'],
    'http_reqs{name:approve-final}': ['count>0'],
    dropped_iterations: ['count==0'],
    checks: ['rate==1'],
  },
};
export function setup() {
  return {
    sales: staffToken('sales'),
    accountant: staffToken('accountant'),
    finance: staffToken('finance'),
  };
}
function memo(sales, flow) {
  return command(sales, flow, 'POST', '/v1/test-memos', {
    title: 'Perf memo ' + exec.scenario.iterationInTest,
    body: 'Synthetic perf memo',
    amount: '1000.00',
    currency: 'NPR',
  });
}
export function approve({ sales, accountant, finance }) {
  const draft = memo(sales, 'prepare-memo');
  const submitted = command(
    sales,
    'submit',
    'POST',
    '/v1/test-memos/' + draft.id + '/submit',
    { expectedVersion: draft.version },
    200,
  );
  const version = decide(accountant, 'approve', submitted.requestId, 1, 'pending');
  decide(finance, 'approve-final', submitted.requestId, version, 'approved');
}
export function preview({ sales }) {
  command(
    sales,
    'preview',
    'POST',
    '/v1/approvals/preview',
    { documentType: 'test_memo', facts: { amountNpr: '1000.00' } },
    200,
  );
}
export function write({ sales }) {
  memo(sales, 'write');
}
