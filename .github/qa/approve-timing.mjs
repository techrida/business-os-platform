// Reads the Approve timings the Playwright fixtures wrote (.dev/qa-approve-timings.jsonl: one `{"ms": <number>, "ok": <boolean>}` per
// line) and prints a Markdown summary with the count of succeeded and failed Approves, and p50, p95 and max of the successes. Used by the qa workflow for the job
// summary. It exits 1 when the p95 of the successful Approves is above the limit (80 ms, Kuu 2026-11-26, OQ-R7-09 c;
// BOS_APPROVE_P95_LIMIT_MS overrides it). A failed Approve is not counted in the percentile; the spec that clicked it
// already failed.
import { readFileSync } from 'node:fs';

export const DEFAULT_P95_LIMIT_MS = 80;

/** The limit from an environment value: a positive number of milliseconds, else the default. */
export function limitFrom(value) {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) && n > 0
    ? n
    : DEFAULT_P95_LIMIT_MS;
}

/** `ok: false` only when there is a successful Approve and the p95 of the successes is above the limit. */
export function verdict(samples, limitMs = DEFAULT_P95_LIMIT_MS) {
  const worked = samples.filter((s) => s.ok).map((s) => s.ms);
  const p95 = percentile(worked, 95);
  if (p95 === undefined) return { ok: true, p95, limitMs };
  return { ok: p95 <= limitMs, p95, limitMs };
}

/** Nearest-rank percentile of a numeric list; undefined for an empty list. */
export function percentile(values, p) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
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
  const head = '### Approve timing (click Approve in the dialog to the decided inbox page)';
  if (samples.length === 0) return `${head}\n\nNo Approve was timed in this job.\n`;
  const worked = samples.filter((s) => s.ok).map((s) => s.ms);
  const failed = samples.filter((s) => !s.ok).map((s) => s.ms);
  const ms = (v) => (v === undefined ? 'n/a' : `${Math.round(v)} ms`);
  return [
    head,
    '',
    '| succeeded | failed | p50 | p95 | max |',
    '|---|---|---|---|---|',
    `| ${worked.length} | ${failed.length} | ${ms(percentile(worked, 50))} | ${ms(percentile(worked, 95))} | ${ms(worked.length === 0 ? undefined : Math.max(...worked))} |`,
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
      `::error::Approve p95 ${Math.round(result.p95)} ms is over the limit of ${limitMs} ms`,
    );
    process.exitCode = 1;
  }
}
