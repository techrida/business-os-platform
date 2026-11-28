import encoding from 'k6/encoding';
import exec from 'k6/execution';
import { check, fail, sleep } from 'k6';
import { Trend } from 'k6/metrics';
import { manifest, request, staffToken } from './lib/staff.js';
import { arrivals, command, summaryTrendStats } from './lib/workload.js';

// Synthetic one-pixel image, sent through the same upload and scan path as a bank slip.
const proof = encoding.b64decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFEkAAAAASUVORK5CYII=',
);
const scan = new Trend('payment_proof_scan_observed_ms', true);
const limits = {
  'record-payment': 80,
  'verify-payment': 80,
  'open-vat-register': 1800,
  'open-receivables': 1800,
};
const thresholds = { checks: ['rate==1'], dropped_iterations: ['count==0'] };
for (const [flow, ms] of Object.entries(limits)) {
  thresholds['http_req_duration{flow:' + flow + '}'] = ['p(95)<' + ms];
  thresholds['http_reqs{flow:' + flow + '}'] = ['count>0'];
}
export const options = {
  summaryTrendStats,
  thresholds,
  scenarios: { payment: arrivals('payment', 1, 4), reports: arrivals('reports', 1, 2) },
};

export function setup() {
  if (!manifest.ids.invoices.length) fail('Load issued invoices before running money');
  return { accountant: staffToken('accountant'), finance: staffToken('finance') };
}

export function payment({ accountant, finance }) {
  const index = exec.scenario.iterationInTest;
  const invoiceId = manifest.ids.invoices[index];
  if (!check(invoiceId, { 'seeded invoice available': Boolean }))
    fail('Each payment iteration needs its own seeded invoice');
  const invoice = request(
    finance,
    'prepare-invoice',
    'GET',
    '/v1/invoices/' + invoiceId,
    null,
    200,
  ).json('invoice');
  const doc = command(accountant, 'prepare-proof', 'POST', '/v1/payment-proofs', {
    customerId: invoice.customerId,
    filename: 'perf-slip.png',
    declaredMime: 'image/png',
    sizeBytes: proof.byteLength,
  });
  request(accountant, 'upload-proof', 'PUT', doc.uploadPath, proof, 200, undefined, 'image/png');
  const start = Date.now();
  for (;;) {
    const version = request(
      accountant,
      'poll-proof',
      'GET',
      '/v1/documents/' + doc.documentId,
      null,
      200,
    )
      .json('versions')
      .find((v) => v.id === doc.versionId);
    if (version?.status === 'clean') break;
    if (Date.now() - start > 30000 || ['infected', 'scan_failed'].includes(version?.status)) {
      check(version, { 'proof scan completed': () => false });
      fail('Proof scan failed or timed out');
    }
    sleep(0.25);
  }
  scan.add(Date.now() - start);
  const recorded = command(accountant, 'record-payment', 'POST', '/v1/payments', {
    customerId: invoice.customerId,
    method: 'bank_transfer',
    currency: invoice.currency,
    amount: invoice.totals.total,
    tdsWithheld: '0.00',
    receivedOn: new Date().toISOString().slice(0, 10),
    bankReference: 'PERF-' + Date.now() + '-' + index,
    proofDocumentIds: [doc.documentId],
  });
  const path = '/v1/payments/' + recorded.id;
  const verified = command(
    finance,
    'verify-payment',
    'POST',
    path + '/verify',
    { expectedVersion: recorded.version },
    200,
  );
  const rows = command(finance, 'allocate-payment', 'POST', path + '/allocations', {
    lines: [{ invoiceId, amount: invoice.totals.total }],
  });
  if (
    !check(rows, {
      'verified and allocated in full': (a) =>
        verified.status === 'verified' &&
        a.length === 1 &&
        a[0].invoiceId === invoiceId &&
        a[0].amount === invoice.totals.total,
    })
  )
    fail('Unexpected payment allocation');
  const detail = request(
    finance,
    'confirm-settlement',
    'GET',
    '/v1/invoices/' + invoiceId,
    null,
    200,
  ).json();
  if (!check(detail, { 'invoice settled': (d) => d.settlement === 'paid' }))
    fail('Invoice still open');
}

export function reports({ finance }) {
  const today = new Date();
  const from = today.toISOString().slice(0, 7) + '-01';
  const to = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0))
    .toISOString()
    .slice(0, 10);
  request(
    finance,
    'open-vat-register',
    'GET',
    '/v1/invoices/vat-register?from=' + from + '&to=' + to,
    null,
    200,
  );
  request(finance, 'open-receivables', 'GET', '/v1/receivables/aging', null, 200);
}
