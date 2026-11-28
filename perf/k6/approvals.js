import exec from 'k6/execution';
import { staffToken } from './lib/staff.js';
import { arrivals, command, decide, summaryTrendStats } from './lib/workload.js';
import { flowThresholds, NFR } from './thresholds.js';

export const options = {
  summaryTrendStats,
  scenarios: {
    approve: arrivals('approve', 10, 30),
    preview: arrivals('preview', 5, 15),
    write: arrivals('write', 2, 5),
  },
  thresholds: {
    ...flowThresholds(
      ['approve-step-1', 'approve-final-step', 'preview-approval', 'create-memo', 'submit-memo'],
      {
        'approve-step-1': 'K6_APPROVE_P95_MS',
        'preview-approval': 'K6_PREVIEW_P95_MS',
        'create-memo': 'K6_WRITE_P95_MS',
      },
    ),
    http_req_failed: ['rate<' + NFR.failedRate],
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
    'submit-memo',
    'POST',
    '/v1/test-memos/' + draft.id + '/submit',
    { expectedVersion: draft.version },
    200,
  );
  const version = decide(accountant, 'approve-step-1', submitted.requestId, 1, 'pending');
  decide(finance, 'approve-final-step', submitted.requestId, version, 'approved');
}
export function preview({ sales }) {
  command(
    sales,
    'preview-approval',
    'POST',
    '/v1/approvals/preview',
    { documentType: 'test_memo', facts: { amountNpr: '1000.00' } },
    200,
  );
}
export function write({ sales }) {
  memo(sales, 'create-memo');
}
