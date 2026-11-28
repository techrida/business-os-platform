import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { matchBackend, parseApiLog, parseTimings, readOptional } from './flow-backend.mjs';

import { percentile } from '../../perf/k6/percentile.cjs';
export { percentile };

const shown = (value) => (value === undefined ? 'n/a' : Number(value.toFixed(2)));
const stats = (values) => [50, 95, 99].map((p) => shown(percentile(values, p)));
function verdict(values, limit) {
  const p95 = percentile(values, 95);
  if (p95 === undefined || !limit) return 'n/a';
  if (p95 > limit.poor) return 'poor';
  return p95 <= limit.good ? 'good' : 'ok';
}

/** Successful page samples only; report failed attempts and unmatched backend samples separately. */
function evaluate(samples, apiLog, limits) {
  let poor = false;
  const lines = [
    '### Flow timings (measured; ms, nearest-rank percentiles; backend = sum of matched action request times)',
    '',
    '| flow | page n | failed | page p50 | page p95 | page p99 | page good / poor | page | backend n | unmatched | backend p50 | backend p95 | backend p99 | backend good / poor | backend |',
    '|---|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---|',
  ];
  for (const name of new Set([...Object.keys(limits), ...samples.map((row) => row.name)])) {
    const all = samples.filter((row) => row.name === name);
    const successful = all.filter((row) => row.ok);
    const page = successful.map((row) => row.pageMs);
    const backend = successful.map((row) => matchBackend(row, apiLog)).filter((ms) => ms !== null);
    const limit = limits[name] ?? {};
    const pageP95 = percentile(page, 95);
    let pageGrade = verdict(page, limit.page);
    if (pageGrade === 'ok' && limit.page.gate) {
      pageGrade =
        pageP95 > limit.page.gate
          ? 'over gate (' + limit.page.gate + ' ms)'
          : 'above the good line (' + limit.page.good + ' ms): Kuu decides whether to optimise';
    }
    const backendGrade = verdict(backend, limit.backend);
    poor ||=
      limit.source === 'browser' &&
      (!page.length ||
        backend.length !== page.length ||
        pageP95 > limit.page.gate ||
        pageGrade === 'poor' ||
        backendGrade === 'poor');
    const band = (range) => (range ? `${range.good} / ${range.poor}` : 'n/a');
    lines.push(
      `| ${[name, page.length, all.length - page.length, ...stats(page), band(limit.page), pageGrade, backend.length, page.length - backend.length, ...stats(backend), band(limit.backend), backendGrade].join(' | ')} |`,
    );
  }
  return { report: lines.join('\n') + '\n', poor };
}

export function summarize(samples, apiLog, limits) {
  return evaluate(samples, apiLog, limits).report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2).filter((arg) => arg !== '--gate');
  const samples = parseTimings(readOptional(args[0] ?? '.dev/qa-flow-timings.jsonl'));
  const log = parseApiLog(readOptional(args[1] ?? '.dev/logs/api.log'));
  const limits = JSON.parse(
    readFileSync(args[2] ?? new URL('./flow-limits.json', import.meta.url), 'utf8'),
  );
  const { report, poor } = evaluate(samples, log, limits);
  process.stdout.write(report);
  if (process.argv.includes('--gate') && poor) process.exitCode = 1;
}
