import { flowThresholds } from './thresholds.js';
import exec from 'k6/execution';
import { sleep, check, fail } from 'k6';
import { Trend } from 'k6/metrics';
import { manifest, request, staffToken } from './lib/staff.js';
import { arrivals, command, decide, summaryTrendStats } from './lib/workload.js';

const pdfReady = new Trend('quotation_pdf_ready_ms', true);
const flows = [
  'create-lead',
  'move-lead-stage',
  'log-activity',
  'save-quotation',
  'generate-pdf',
  'convert-quotation',
  'issue-invoice',
  'create-credit-note',
  'create-debit-note',
];
const thresholds = {
  checks: ['rate==1'],
  dropped_iterations: ['count==0'],
  quotation_pdf_ready_ms: ['p(95)<=10000'],
};
Object.assign(thresholds, flowThresholds(flows));
export const options = {
  summaryTrendStats,
  scenarios: { quotation: arrivals('quotation', 1, 12), billing: arrivals('billing', 1, 4) },
  thresholds,
};

export function setup() {
  const sales = staffToken('sales');
  const customer = manifest.customerIds[0];
  const contact = request(
    sales,
    'setup-contact',
    'POST',
    '/v1/customers/' + customer + '/contacts',
    { fullName: 'Perf recipient', email: 'recipient@perf.invalid', country: 'NP' },
    201,
    'perf-contact-' + Date.now(),
  ).json();
  return {
    sales,
    customer,
    contact: contact.id,
    accountant: staffToken('accountant'),
    management: staffToken('management'),
    finance: staffToken('finance'),
  };
}
function label() {
  return exec.scenario.iterationInTest + '-' + Date.now();
}
function line() {
  return {
    description: 'Synthetic service',
    uom: 'lot',
    quantity: '1',
    unitPrice: '1000.00',
    taxCodeId: manifest.vatId,
  };
}
function prospect(sales) {
  const suffix = label();
  const lead = command(sales, 'create-lead', 'POST', '/v1/leads', {
    title: 'Perf ' + suffix,
    companyName: 'Perf ' + suffix,
    contactName: 'Perf contact',
    source: 'referral',
    country: 'NP',
    email: 'lead-' + suffix + '@perf.invalid',
  });
  const moved = command(
    sales,
    'move-lead-stage',
    'PATCH',
    '/v1/leads/' + lead.id + '/stage',
    {
      stage: 'contacted',
      contactActivity: { kind: 'call', body: 'Perf contact' },
      expectedVersion: lead.version,
    },
    200,
  );
  command(sales, 'log-activity', 'POST', '/v1/activities', {
    kind: 'note',
    subject: 'Perf call',
    leadId: lead.id,
  });
  return command(
    sales,
    'prepare-qualify',
    'PATCH',
    '/v1/leads/' + lead.id + '/stage',
    { stage: 'qualified', expectedVersion: moved.version },
    200,
  );
}
export function quotation({ sales, customer, contact, accountant, finance }) {
  const lead = prospect(sales);
  const opp = command(sales, 'prepare-opportunity', 'POST', '/v1/leads/' + lead.id + '/convert', {
    expectedVersion: lead.version,
    customer: { mode: 'existing', customerId: customer },
    contact: { mode: 'existing', contactId: contact },
    opportunityName: 'Perf ' + label(),
  });
  const today = new Date().toISOString().slice(0, 10);
  const q = command(sales, 'save-quotation', 'POST', '/v1/quotations', {
    opportunityId: opp.opportunityId,
    contactId: contact,
    currency: 'NPR',
    issueDate: today,
    validUntil: new Date(Date.now() + 86400000 * 30).toISOString().slice(0, 10),
    lines: [line()],
    paymentSchedule: [{ label: 'Final', percent: '100' }],
  });
  const path = '/v1/quotations/' + q.id + '/versions/' + q.currentVersionId;
  const submitted = command(
    sales,
    'prepare-submit',
    'POST',
    path + '/submit',
    { expectedVersion: 1 },
    200,
  );
  const version = decide(
    accountant,
    'prepare-recommend',
    submitted.approvalRequestId,
    1,
    'pending',
  );
  decide(finance, 'generate-pdf', submitted.approvalRequestId, version, 'approved');
  const start = Date.now();
  let approved;
  do {
    approved = request(sales, 'poll-pdf', 'GET', path, null, 200).json();
    if (approved.renderedScanStatus === 'clean') break;
    sleep(0.25);
  } while (Date.now() - start < 30000);
  if (!check(approved, { 'PDF became available': (v) => v.renderedScanStatus === 'clean' }))
    fail('PDF completion timed out');
  pdfReady.add(Date.now() - start);
  const sent = command(
    sales,
    'prepare-send',
    'POST',
    path + '/send',
    { recipientContactId: contact, expectedVersion: approved.version },
    200,
  );
  command(sales, 'prepare-accept', 'POST', path + '/outcome', {
    outcome: 'accepted',
    decidedOn: today,
    evidenceKinds: ['signed_quote'],
    expectedVersion: sent.version,
  });
  command(accountant, 'convert-quotation', 'POST', '/v1/sales-orders', {
    quotationVersionId: q.currentVersionId,
  });
}
export function billing({ customer, accountant, management, finance }) {
  const { invoice } = command(accountant, 'prepare-invoice', 'POST', '/v1/invoices', {
    customerId: customer,
    currency: 'NPR',
    manualReason: 'Perf ' + label(),
    lines: [line()],
  });
  const path = '/v1/invoices/' + invoice.id;
  const submitted = command(
    accountant,
    'prepare-invoice-submit',
    'POST',
    path + '/submit',
    { expectedVersion: invoice.version },
    200,
  ).invoice;
  const version = decide(
    management,
    'prepare-invoice-check',
    submitted.approvalRequestId,
    1,
    'pending',
  );
  decide(finance, 'prepare-invoice-approve', submitted.approvalRequestId, version, 'approved');
  const approved = request(finance, 'prepare-invoice-read', 'GET', path, null, 200).json('invoice');
  command(
    finance,
    'issue-invoice',
    'POST',
    path + '/issue',
    { expectedVersion: approved.version },
    200,
  );
  for (const kind of ['credit', 'debit']) {
    command(finance, 'create-' + kind + '-note', 'POST', '/v1/' + kind + '-notes', {
      originalInvoiceId: invoice.id,
      reason: 'Synthetic adjustment',
      lines: kind === 'credit' ? [{ originalLineNo: 1, quantity: '1' }] : [line()],
    });
  }
}
