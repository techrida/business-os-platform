/* global __ENV */
import exec from 'k6/execution';
import { check, fail, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { manifest, request, staffSession } from './lib/staff.js';
import { sessionTokens } from './lib/session-tokens.mjs';
import { arrivals, command, decide, summaryTrendStats } from './lib/workload.js';

const scan = new Trend('procurement_scan_observed_ms', true);
const flows = [
  'submit-purchase-request',
  'recommend-vendor-quotation',
  'record-receipt',
  'enter-vendor-bill',
  'approve-bill',
];
const seed = __ENV.K6_PROCUREMENT_SEED === '1';
const confirmedSeedReceipts = new Counter('procurement_seed_receipts');
const thresholds = { checks: ['rate==1'] };
if (seed) {
  thresholds.procurement_seed_receipts = ['count==2000'];
} else {
  thresholds.dropped_iterations = ['count==0'];
  for (const flow of flows) {
    thresholds['http_req_duration{flow:' + flow + '}'] = ['p(95)<80'];
    thresholds['http_reqs{flow:' + flow + '}'] = ['count>0'];
  }
}
export const options = {
  summaryTrendStats,
  scenarios: {
    procurement: seed
      ? {
          executor: 'shared-iterations',
          vus: 4,
          iterations: 2000,
          maxDuration: '3h',
          exec: 'procurement',
        }
      : arrivals('procurement', 1, 12),
  },
  thresholds,
};
const root = '/v1/procurement';
const prPath = root + '/purchase-requests';
const orders = root + '/purchase-orders';
const receipts = root + '/receipts';
const bills = '/v1/payables/bills';
const fixture = manifest.procurement;
export function setup() {
  if (seed && manifest.ids.vendor_bills.length !== 5000)
    fail('Load the 5,000-bill procurement fixture before seeding receipts');
  return Object.fromEntries(
    ['procurement', 'warehouse', 'founder', 'accountant', 'finance', 'management'].map((role) => [
      role,
      staffSession(role),
    ]),
  );
}
function expectState(value, name) {
  if (!check(value, { [name]: Boolean })) fail(name);
}
function proof(token, path, extra = {}) {
  const content = fixture.evidencePdf;
  const mime = 'application/pdf';
  const doc = command(token, 'prepare-proof', 'POST', path, {
    filename: 'evidence.pdf',
    declaredMime: mime,
    sizeBytes: content.length,
    ...extra,
  });
  request(token, 'prepare-upload', 'PUT', doc.uploadPath, content, 200, undefined, mime);
  const start = Date.now();
  do {
    const version = request(
      token,
      'prepare-scan',
      'GET',
      '/v1/documents/' + doc.documentId,
      null,
      200,
    ).json('versions.0');
    if (version.status === 'clean') {
      scan.add(Date.now() - start);
      return doc.documentId;
    }
    if (version.status !== 'quarantined') break;
    sleep(0.2);
  } while (Date.now() - start < 30000);
  expectState(false, 'proof scan completed');
}
// Each virtual user keeps its refreshed credentials across iterations of the long fixture seed.
let sessions;
export function procurement(initialSessions) {
  sessions ??= initialSessions;
  const {
    procurement: buyer,
    warehouse,
    founder,
    accountant,
    finance,
    management,
  } = sessionTokens(sessions, staffSession, Date.now());
  const marker = Date.now() + '-' + exec.scenario.iterationInTest;
  const today = new Date().toISOString().slice(0, 10);
  const due = new Date(Date.now() + 86400000 * 7).toISOString();
  const pr = command(buyer, 'prepare-request', 'POST', prPath, {
    requestType: 'goods',
    departmentId: fixture.departmentId,
    costCenterId: fixture.costCenterId,
    justification: 'Synthetic procurement ' + marker,
    requiredBy: due.slice(0, 10),
    budgetCode: 'PERF',
    currency: 'NPR',
    lines: [
      {
        description: 'Serialized unit',
        uom: 'unit',
        quantity: '1',
        estimatedUnitPrice: '1000.00',
        requiresSerials: true,
      },
    ],
  });
  const submitted = command(
    buyer,
    'submit-purchase-request',
    'POST',
    prPath + '/' + pr.id + '/submit',
    { expectedVersion: pr.version },
    200,
  );
  decide(founder, 'prepare-department-approval', submitted.approvalRequestId, 1, 'approved');
  const rfq = command(buyer, 'prepare-rfq', 'POST', root + '/rfqs', {
    purchaseRequestId: pr.id,
    deadline: due,
    vendorIds: [fixture.vendorId],
  });
  const path = root + '/rfqs/' + rfq.id;
  const quoted = { quantity: '1', unitPrice: '1000.00', taxCodeId: manifest.vatId };
  const quote = command(buyer, 'prepare-vendor-quotation', 'POST', path + '/quotations', {
    vendorId: fixture.vendorId,
    documentId: proof(buyer, path + '/evidence-documents'),
    currency: 'NPR',
    lines: [{ prLineId: pr.lines[0].id, ...quoted }],
  });
  command(
    buyer,
    'recommend-vendor-quotation',
    'POST',
    path + '/recommendation',
    {
      vendorQuotationId: quote.id,
      rationale: 'Meets specification',
      fewerThanThreeReason: 'Sole fixture supplier',
    },
    200,
  );
  const commitment = command(
    buyer,
    'prepare-commitment',
    'POST',
    path + '/commitment',
    {},
    200,
  ).commitmentApprovalRequestId;
  const version = decide(accountant, 'prepare-budget-check', commitment, 1, 'pending');
  decide(finance, 'prepare-budget-approval', commitment, version, 'approved');
  const draft = request(
    buyer,
    'prepare-order-list',
    'GET',
    orders + '?status=draft&limit=100',
    null,
    200,
  )
    .json()
    .find((o) => o.rfqId === rfq.id);
  expectState(draft, 'commitment produced order');
  const po = command(
    buyer,
    'prepare-order-issue',
    'POST',
    orders + '/' + draft.id + '/issue',
    {},
    200,
  );
  const line = po.lines[0];
  const receipt = command(warehouse, 'record-receipt', 'POST', receipts, {
    purchaseOrderId: po.id,
    kind: 'goods',
    receivedAt: today,
    location: 'Perf warehouse',
    lines: [{ poLineId: line.id, quantity: '1', serials: [{ serialNo: 'PERF-' + marker }] }],
  });
  const received = command(
    warehouse,
    'prepare-confirm-receipt',
    'POST',
    receipts + '/' + receipt.id + '/confirm',
    {},
    200,
  );
  expectState(
    received.status === 'confirmed' && received.lines[0].serials[0].serialNo === 'PERF-' + marker,
    'serialized receipt confirmed',
  );
  if (seed) {
    confirmedSeedReceipts.add(1);
    return;
  }
  const bill = command(accountant, 'enter-vendor-bill', 'POST', bills, {
    purchaseOrderId: po.id,
    vendorPartyId: fixture.vendorId,
    kind: 'bill',
    vendorInvoiceNo: 'PERF-' + marker,
    invoiceDate: today,
    currency: 'NPR',
    documentId: proof(accountant, '/v1/payables/bill-documents', {
      vendorPartyId: fixture.vendorId,
    }),
    lines: [
      {
        ...quoted,
        accountId: fixture.accountId,
        poLineId: line.id,
        receiptLineId: received.lines[0].id,
      },
    ],
  });
  expectState(bill.matchStatus === 'matched', 'bill passed three-way match');
  const approval = command(
    accountant,
    'prepare-bill-submit',
    'POST',
    bills + '/' + bill.id + '/submit',
    {},
    200,
  ).approvalRequestId;
  const checked = decide(management, 'prepare-bill-check', approval, 1, 'pending');
  decide(finance, 'approve-bill', approval, checked, 'approved');
  expectState(
    request(accountant, 'prepare-bill-read', 'GET', bills + '/' + bill.id, null, 200).json(
      'status',
    ) === 'approved',
    'approved bill persisted',
  );
}
