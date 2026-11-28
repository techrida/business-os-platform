import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseApiLog, matchBackend } from './flow-backend.mjs';

const completion = (id, url, responseTime, method = 'POST') =>
  JSON.stringify({ msg: 'request completed', req: { id, url, method }, responseTime });

test('joins request completions by correlation ID, summing relevant writes rather than page reads', () => {
  const log = parseApiLog(
    [
      completion('id-1', '/v1/approvals/requests/a/actions', 12),
      completion('id-1', '/v1/approvals/inbox', 90, 'GET'),
      completion('id-1', '/v1/approvals/requests/a/actions', 3),
      completion('id-2', '/v1/approvals/requests/b/actions', 99),
      '{broken',
      JSON.stringify({ msg: 'request started', req: { id: 'id-1' }, responseTime: 200 }),
    ].join('\n'),
  );
  assert.equal(matchBackend({ name: 'approve-step-1', requestIds: ['id-1', 'id-1'] }, log), 15);
  assert.equal(matchBackend({ name: 'approve-step-1', requestIds: ['absent'] }, log), null);
  assert.equal(matchBackend({ name: 'approve-step-1', requestIds: [] }, log), null);
});

test('all seven flows match their respective action endpoints', () => {
  const cases = [
    ['approve-step-1', '/v1/approvals/requests/a/actions'],
    ['submit-memo', '/v1/test-memos/a/submit'],
    ['save-quotation', '/v1/quotations'],
    ['issue-invoice', '/v1/invoices/a/issue'],
    ['record-payment', '/v1/payments'],
    ['submit-purchase-request', '/v1/procurement/purchase-requests/a/submit'],
    ['enter-vendor-bill', '/v1/payables/bills'],
  ];
  for (const [name, url] of cases) {
    assert.equal(
      matchBackend({ name, requestIds: ['id'] }, parseApiLog(completion('id', url, 17))),
      17,
    );
  }
});
