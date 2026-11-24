// Reads the Approve timings the Playwright fixtures wrote (.dev/qa-approve-timings.jsonl: one `{"ms": <number>}` per
// line) and prints a Markdown summary with the sample count, p50, p95 and max. Used by the qa workflow for the job
// summary. Informational only: it always exits 0, because a shared runner's speed is not something to fail a build on.
import { readFileSync } from 'node:fs';

/** Nearest-rank percentile of a numeric list; undefined for an empty list. */
export function percentile(values, p) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

/** The `ms` of every well-formed line; anything else is skipped. */
export function parseTimings(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const ms = JSON.parse(line)?.ms;
      if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) out.push(ms);
    } catch {
      // A torn line is not a sample.
    }
  }
  return out;
}

export function summarise(values) {
  const head = '### Approve timing (click Approve in the dialog to the decided inbox page)';
  if (values.length === 0) return `${head}\n\nNo Approve was timed in this job.\n`;
  const ms = (v) => `${Math.round(v)} ms`;
  return [
    head,
    '',
    '| samples | p50 | p95 | max |',
    '|---|---|---|---|',
    `| ${values.length} | ${ms(percentile(values, 50))} | ${ms(percentile(values, 95))} | ${ms(Math.max(...values))} |`,
    '',
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
