// Reads the Approve timings the Playwright fixtures wrote (.dev/qa-approve-timings.jsonl: one `{"ms": <number>, "ok": <boolean>}` per
// line) and prints a Markdown summary with the count of succeeded and failed Approves, and p50, p95 and max of the successes. Used by the qa workflow for the job
// summary. Informational only: it always exits 0, because a shared runner's speed is not something to fail a build on.
import { readFileSync } from 'node:fs';

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

/** p50, p95 and max are of the Approves that worked; the failures are counted on their own. */
export function summarise(samples) {
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
    'Informational: a shared runner is slow and noisy, so this never fails the job.',
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
  process.stdout.write(summarise(parseTimings(text)));
}
