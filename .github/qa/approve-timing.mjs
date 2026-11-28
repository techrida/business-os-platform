import { readFileSync } from 'node:fs';
import { percentile } from '../../perf/k6/percentile.cjs';
export { percentile };

const limits = JSON.parse(readFileSync(new URL('./flow-limits.json', import.meta.url), 'utf8'));
export const DEFAULT_P95_LIMIT_MS = limits['approve-step-1'].page.gate;

/** The limit from an environment value: a positive number of milliseconds, else the default. */
export function limitFrom(value) {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) && n > 0
    ? n
    : DEFAULT_P95_LIMIT_MS;
}

/** `ok: false` when samples are missing or their p95 exceeds the limit. */
export function verdict(samples, limitMs = DEFAULT_P95_LIMIT_MS) {
  const worked = samples.filter((s) => s.ok).map((s) => s.ms);
  const p95 = percentile(worked, 95);
  if (p95 === undefined) return { ok: false, p95, limitMs };
  return { ok: p95 <= limitMs, p95, limitMs };
}

/**
 * One `{ ms, ok }` per well-formed line; anything else is skipped. A line with no `ok` counts as a success (the first
 * version of the file had only `ms`).
 */
export function parseTimings(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const row = JSON.parse(line);
      const ms = row?.ms;
      if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) {
        out.push({ ms, ok: row.ok !== false });
      }
    } catch {
      // A torn line is not a sample.
    }
  }
  return out;
}

function verdictLine({ ok, p95, limitMs }) {
  if (p95 === undefined)
    return `No successful Approve to judge against the ${limitMs} ms p95 limit.`;
  const shown = `${Math.round(p95)} ms`;
  return ok
    ? `p95 ${shown} is within the limit of ${limitMs} ms.`
    : `**p95 ${shown} is over the limit of ${limitMs} ms: the job fails.**`;
}

/** p50, p95 and max are of the Approves that worked; the failures are counted on their own. */
export function summarise(samples, limitMs = DEFAULT_P95_LIMIT_MS) {
  const head = '### Approve to decided page';
  if (samples.length === 0) return `${head}\n\nNo Approve was timed in this job.\n`;
  const worked = samples.filter((s) => s.ok).map((s) => s.ms);
  const failed = samples.filter((s) => !s.ok).map((s) => s.ms);
  const p95 = percentile(worked, 95);
  const page = limits['approve-step-1'].page;
  const note =
    p95 > page.good && p95 <= page.gate
      ? ` (above the good line (${page.good} ms): Kuu decides whether to optimise)`
      : '';
  const ms = (v) => (v === undefined ? 'n/a' : `${Math.round(v)} ms`);
  return [
    head,
    '',
    '| succeeded | failed | p50 | p95 | max |',
    '|---|---|---|---|---|',
    `| ${worked.length} | ${failed.length} | ${ms(percentile(worked, 50))} | ${ms(p95)}${note} | ${ms(worked.length === 0 ? undefined : Math.max(...worked))} |`,
    '',
    ...(failed.length === 0
      ? []
      : [
          `${failed.length} failed after ${failed.map(ms).join(', ')}, not counted in the percentiles.`,
          '',
        ]),
    verdictLine(verdict(samples, limitMs)),
    '',
  ].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let text = '';
  try {
    text = readFileSync(process.argv[2] ?? '.dev/qa-approve-timings.jsonl', 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const samples = parseTimings(text);
  const limitMs = limitFrom(process.env.BOS_APPROVE_P95_LIMIT_MS);
  process.stdout.write(summarise(samples, limitMs));
  const result = verdict(samples, limitMs);
  if (!result.ok) {
    console.error(
      result.p95 === undefined
        ? '::error::No successful Approve was timed'
        : `::error::Approve p95 ${Math.round(result.p95)} ms is over the limit of ${limitMs} ms`,
    );
    process.exitCode = 1;
  }
}
