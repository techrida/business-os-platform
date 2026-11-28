// Read the selected compose API's JSON logs from stdin. Retain only flow names and elapsed times.
import { readFileSync } from 'node:fs';
import { percentile } from './percentile.cjs';
import { platformFlows } from './platform-flows.mjs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const groups = {
  platform: platformFlows,
  sales: [
    'create-lead',
    'move-lead-stage',
    'log-activity',
    'save-quotation',
    'generate-pdf',
    'convert-quotation',
    'issue-invoice',
    'create-credit-note',
    'create-debit-note',
  ],
  procurement: [
    'submit-purchase-request',
    'recommend-vendor-quotation',
    'record-receipt',
    'enter-vendor-bill',
    'approve-bill',
  ],
  money: [
    'record-payment',
    'verify-payment',
    'allocate-payment',
    'open-vat-register',
    'open-receivables',
  ],
  approvals: [
    'approve-step-1',
    'approve-final-step',
    'preview-approval',
    'create-memo',
    'submit-memo',
  ],
};

// P-10 baseline logs can still carry the original tags.
const aliases = new Map([
  ['move-lead', 'move-lead-stage'],
  ['enqueue-pdf', 'generate-pdf'],
  ['convert-order', 'convert-quotation'],
  ['credit-note', 'create-credit-note'],
  ['debit-note', 'create-debit-note'],
  ['approve', 'approve-step-1'],
  ['approve-final', 'approve-final-step'],
  ['preview', 'preview-approval'],
  ['write', 'create-memo'],
  ['submit', 'submit-memo'],
]);

export async function summarize(lines, flows) {
  const samples = new Map(flows.map((flow) => [flow, []]));
  for await (const line of lines) {
    if (!line.startsWith('{')) continue;
    const event = JSON.parse(line);
    const tag = event.req?.headers?.['x-perf-flow'];
    const group = samples.get(aliases.get(tag) ?? tag);
    if (
      group &&
      event.res?.statusCode >= 200 &&
      event.res.statusCode < 300 &&
      Number.isFinite(event.responseTime)
    )
      group.push(event.responseTime);
  }
  return [...samples].map(([flow, values]) => {
    return {
      flow,
      n: values.length,
      percentiles: values.length ? [50, 95, 99].map((p) => percentile(values, p)) : [],
    };
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const limits = JSON.parse(
    readFileSync(new URL('../../.github/qa/flow-limits.json', import.meta.url), 'utf8'),
  );
  const flows = groups[process.argv[2]];
  if (!flows) throw new Error('Unknown workload');
  console.log('Measured API request time in milliseconds: flow, count, p50, p95, p99');
  for (const { flow, n, percentiles } of await summarize(
    createInterface({ input: process.stdin }),
    flows,
  )) {
    console.log([flow, n, ...percentiles.map((p) => p.toFixed(1))].join(', '));
    if (!n || percentiles[1] > limits[flow].backend.poor) process.exitCode = 1;
  }
}
