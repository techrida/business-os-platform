// Report only; P-9 owns the CI gate and final limits. Invoke from the repository root.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { matchBackend, parseApiLog, parseTimings, readOptional } from './flow-backend.mjs';

export function percentile(values, p) {
  if (values.length === 0) return undefined;
  return [...values].sort((a, b) => a - b)[Math.ceil((p / 100) * values.length) - 1];
}

const shown = (value) => (value === undefined ? 'n/a' : Number(value.toFixed(2)));
const stats = (values) => [50, 95, 99].map((p) => shown(percentile(values, p)));
const verdict = (values, limit) =>
  values.length === 0 || limit === undefined
    ? 'n/a'
    : percentile(values, 95) < limit
      ? 'within'
      : 'over';

/** Successful page samples only; report failed attempts and unmatched backend samples separately. */
export function summarize(samples, apiLog, limits) {
  const lines = [
    '### Flow timings (measured; ms, nearest-rank percentiles; backend = sum of matched action request times)',
    '',
    '| flow | page n | failed | page p50 | page p95 | page p99 | page p95 limit | page | backend n | unmatched | backend p50 | backend p95 | backend p99 | backend p95 limit | backend |',
    '|---|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---|',
  ];
  for (const name of new Set([...Object.keys(limits), ...samples.map((row) => row.name)])) {
    const all = samples.filter((row) => row.name === name);
    const successful = all.filter((row) => row.ok);
    const page = successful.map((row) => row.pageMs);
    const backend = successful.map((row) => matchBackend(row, apiLog)).filter((ms) => ms !== null);
    const limit = limits[name] ?? {};
    lines.push(
      `| ${[name, page.length, all.length - page.length, ...stats(page), shown(limit.page), verdict(page, limit.page), backend.length, page.length - backend.length, ...stats(backend), shown(limit.backend), verdict(backend, limit.backend)].join(' | ')} |`,
    );
  }
  return lines.join('\n') + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const samples = parseTimings(readOptional(process.argv[2] ?? '.dev/qa-flow-timings.jsonl'));
  const log = parseApiLog(readOptional(process.argv[3] ?? '.dev/logs/api.log'));
  const limits = JSON.parse(
    readFileSync(process.argv[4] ?? new URL('./flow-limits.json', import.meta.url), 'utf8'),
  );
  process.stdout.write(summarize(samples, log, limits));
}
