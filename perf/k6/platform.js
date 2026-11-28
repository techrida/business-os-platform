import { check, fail, sleep } from 'k6';
import { manifest, portalToken, request, staffToken } from './lib/staff.js';
import { arrivals, command, summaryTrendStats } from './lib/workload.js';
import { platformLimits } from './platform-flows.mjs';

const paths = [
  'me',
  'settings/display',
  'notifications?limit=5',
  'leads/summary',
  'quotations/summary',
  'sales-orders/summary',
  'invoices/summary',
  'payments/summary',
  'procurement/receivable-orders',
  'procurement/requested-orders',
  'test-memos',
  'approvals/inbox?limit=25',
  'customers/industries',
  'customers?limit=25',
  'leads/owners',
  'leads?limit=25',
  'opportunities',
  'opportunities/reports/lost-reasons',
  'quotations',
  'verification-cases',
  'activities',
  'sales-orders',
  'invoices',
  'invoices/vat-register?from=2026-01-01&to=2026-01-31',
  'payments',
  'receivables/aging',
  'procurement/purchase-requests',
  'procurement/rfqs',
  'procurement/purchase-orders',
  'procurement/received-orders',
  'vendors',
  'payables/bill-submissions',
  'payables/bills',
  'payables/payment-requests/items',
  'payables/payment-requests',
  'payables/vat-register?from=2026-01-01&to=2026-01-31',
];
const thresholds = { checks: ['rate==1'], dropped_iterations: ['count==0'] };
for (const [flow, limit] of Object.entries(platformLimits)) {
  thresholds['http_req_duration{flow:' + flow + '}'] = ['p(95)<' + limit];
  thresholds['http_reqs{flow:' + flow + '}'] = ['count>0'];
}
export const options = {
  scenarios: Object.fromEntries(
    ['reads', 'settings', 'verification', 'portal', 'sidebar'].map((name) => [
      name,
      name === 'verification'
        ? { ...arrivals(name, 1, 12), gracefulStop: '125s' }
        : arrivals(name, 1, 2),
    ]),
  ),
  summaryTrendStats,
  thresholds,
};
const get = (token, flow, path) => request(token, flow, 'GET', '/v1/' + path, null, 200).json();

export function setup() {
  const founder = staffToken('founder'),
    sales = staffToken('sales');
  const verification = request(
    sales,
    'setup-case',
    'POST',
    '/v1/verification-cases',
    { partyId: manifest.customerIds[0] },
    [200, 201],
    'p7-case-' + Date.now(),
  ).json();
  const workflow = get(founder, 'setup-workflows', 'admin/workflows').find(
    (w) => w.versions.length && w.documentType === 'test_memo',
  );
  if (!workflow) fail('Missing seeded memo workflow');
  return {
    founder,
    sales,
    accountant: staffToken('accountant'),
    customer: portalToken('customer_user'),
    vendor: portalToken('vendor_user'),
    caseId: verification.id,
    workflowKey: workflow.key,
    spec: workflow.versions[0].spec,
  };
}
export function reads({ accountant, founder }) {
  const page = get(accountant, 'open-inbox', 'approvals/inbox?limit=25');
  const badge = get(accountant, 'open-inbox', 'approvals/inbox/count');
  get(accountant, 'open-inbox', 'approvals/inbox/summary');
  check(badge, {
    'inbox reflects seeded waiting memos': (b) =>
      b.count >= manifest.ids.test_memos.length / 3 && page.length === Math.min(25, b.count),
  });
  const audit = get(founder, 'filter-audit-trail', 'audit?entityType=invoices&limit=50');
  check(audit, {
    'filtered audit rows returned': (r) =>
      r.items.length > 0 && r.items.every((item) => item.entityType === 'invoices'),
  });
}
export function sidebar({ founder }) {
  for (const path of paths) get(founder, 'sidebar-navigation', path);
}
export function settings({ founder, workflowKey, spec }) {
  const policy = get(founder, 'prepare-access', 'admin/access');
  const rule = policy.levelRules[0];
  command(
    founder,
    'save-access-policy',
    'POST',
    '/v1/admin/access',
    {
      expectedRevision: policy.revision,
      changes: [
        { kind: 'levelRule', area: rule.area, managersSeeDepartment: !rule.managersSeeDepartment },
      ],
    },
    200,
  );
  command(
    founder,
    'save-approval-workflow',
    'POST',
    '/v1/admin/workflows/' + workflowKey + '/versions',
    { spec },
  );
}
const bytes = open('./fixtures/verification.pdf', 'b');
function upload(token, flow, base, owner) {
  const file = command(token, flow, 'POST', base, {
    filename: 'platform.pdf',
    declaredMime: 'application/pdf',
    sizeBytes: bytes.byteLength,
    ...owner,
  });
  const path = base + '/' + file.documentId + '/versions/' + file.versionId + '/content';
  if (file.uploadPath !== path) fail('Unexpected upload path');
  request(token, flow, 'PUT', path, bytes, 200, null, 'application/pdf');
  return file;
}
export function verification({ sales, caseId }) {
  const file = upload(sales, 'upload-document', '/v1/documents', {
    ownerType: 'verification_case',
    ownerId: caseId,
  });
  const deadline = Date.now() + 120000;
  do {
    const version = get(sales, 'scan-document', 'documents/' + file.documentId).versions.find(
      (v) => v.id === file.versionId,
    );
    if (version?.status === 'clean') return;
    if (version?.status !== 'quarantined') fail('Scan did not finish cleanly');
    sleep(0.25);
  } while (Date.now() < deadline);
  check(false, { 'scan completed': Boolean });
  fail('Timed out waiting for clean scan');
}
export function portal({ customer, vendor }) {
  const invoices = get(customer, 'portal-invoices', 'portal/invoices');
  check(invoices, {
    'customer sees seeded invoices': (rows) =>
      rows.length > 0 && rows.length === manifest.ids.invoices.length / manifest.customerIds.length,
  });
  const rfq = get(vendor, 'prepare-rfq', 'portal/vendor/rfqs')[0];
  if (!check(rfq, { 'invited RFQ exists': Boolean })) fail('Missing open vendor RFQ');
  const base = '/v1/portal/vendor/quotation-submissions';
  const file = upload(vendor, 'prepare-quote-file', base + '/files', {});
  command(vendor, 'portal-submit-quotation', 'POST', base, {
    rfqId: rfq.id,
    documentId: file.documentId,
    currency: 'NPR',
    total: '10.00',
  });
}
