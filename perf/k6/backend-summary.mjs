// Read the selected compose API's JSON logs from stdin. Retain only flow names and elapsed times.
import { readFileSync } from 'node:fs';
import { platformFlows } from './platform-flows.mjs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const groups = {
  platform: platformFlows,
  sales: [
    'create-lead',
    'move-lead',
    'log-activity',
    'save-quotation',
    'enqueue-pdf',
    'convert-order',
    'issue-invoice',
    'credit-note',
    'debit-note',
  ],
  money: [
    'record-payment',
    'verify-payment',
    'allocate-payment',
    'open-vat-register',
    'open-receivables',
  ],
  approvals: ['approve', 'approve-final', 'preview', 'write', 'submit'],
};

export function percentile(sorted, fraction) {
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  return sorted[lower] + (sorted[Math.ceil(index)] - sorted[lower]) * (index - lower);
}

export async function summarize(lines, flows) {
  const samples = new Map(flows.map((flow) => [flow, []]));
  for await (const line of lines) {
    if (!line.startsWith('{')) continue;
    const event = JSON.parse(line);
    const group = samples.get(event.req?.headers?.['x-perf-flow']);
    if (
      group &&
      event.res?.statusCode >= 200 &&
      event.res.statusCode < 300 &&
      Number.isFinite(event.responseTime)
    )
      group.push(event.responseTime);
  }
  return [...samples].map(([flow, values]) => {
    values.sort((a, b) => a - b);
    return {
      flow,
      n: values.length,
      percentiles: values.length ? [0.5, 0.95, 0.99].map((p) => percentile(values, p)) : [],
    };
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const platform = process.argv[2] === 'platform';
  const limits = platform
    ? JSON.parse(
        readFileSync(new URL('../../.github/qa/flow-limits.json', import.meta.url), 'utf8'),
      )
    : {};
  const flows = groups[process.argv[2]];
  if (!flows) throw new Error('Unknown workload');
  console.log('Measured API request time in milliseconds: flow, count, p50, p95, p99');
  for (const { flow, n, percentiles } of await summarize(
    createInterface({ input: process.stdin }),
    flows,
  )) {
    console.log([flow, n, ...percentiles.map((p) => p.toFixed(1))].join(', '));
    const limit = platform
      ? limits[flow].backend.poor
      : ['open-vat-register', 'open-receivables'].includes(flow)
        ? 1800
        : 80;
    if (!n || percentiles[1] >= limit) process.exitCode = 1;
  }
}
