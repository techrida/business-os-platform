// With a spec filter set (workflow_dispatch input spec_filter), prints how many tests each Playwright step will run and
// fails when the filter matched no test in BOTH the workspace and the portal suite: both steps pass with no tests when a
// filter is set (a filter naming only portal specs matches nothing in the workspace, and the other way round), so a
// mistyped filter would otherwise pass silently. With no filter it does nothing: no tests is a failure of the steps
// themselves.
// Counts come from `playwright test --list`, which applies the same file filters and --grep-invert as the real run.
// Run by the qa workflow: node .github/qa/spec-counts.mjs  (env: SPEC_FILTER, SHARD, REPEAT_EACH, WS_STEP)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The N of playwright's "Total: N tests in M files" line (the last one), or undefined when there is none. */
export function parseTotal(listOutput) {
  const all = [...listOutput.matchAll(/^Total: (\d+) tests? in \d+ files?\s*$/gm)];
  const last = all.at(-1);
  return last ? Number(last[1]) : undefined;
}

/**
 * `ok: false` only when a filter is set and neither suite matched a test. `wsTotal` is the whole workspace suite for the
 * filter (all shards): a single shard may legitimately hold none of the matching files.
 */
export function decide({ filter, wsTotal, portalTotal }) {
  const set = filter.trim() !== '';
  if (!set) return { ok: true, message: 'No spec filter: every spec runs.' };
  const message = `Spec filter "${filter.trim()}" matches ${wsTotal} workspace and ${portalTotal} portal tests.`;
  if (wsTotal === 0 && portalTotal === 0) {
    return {
      ok: false,
      message: `${message} It matched nothing in either suite: check the spelling.`,
    };
  }
  return { ok: true, message };
}

function listTotal(cwd, args) {
  const out = execFileSync('pnpm', ['exec', 'playwright', 'test', '--list', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const n = parseTotal(out);
  if (n === undefined)
    throw new Error(`no "Total: N tests" line in the playwright --list output of ${cwd}`);
  return n;
}

function main() {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const filter = process.env.SPEC_FILTER ?? '';
  const words = filter.split(/\s+/).filter(Boolean);
  const repeat = Number(process.env.REPEAT_EACH || '1');
  if (words.length === 0) {
    console.log(decide({ filter, wsTotal: 0, portalTotal: 0 }).message);
    return;
  }
  // The same --grep-invert as the workspace step: the persona sign-ins ran in the warm-up, quarantined specs stay out.
  let skip = 'persona sign-in and sign-out|qa fixtures: ';
  const quarantine = readFileSync(`${root}.github/qa/quarantine.txt`, 'utf8').trim();
  if (quarantine) skip += `|${quarantine}`;
  const ws = `${root}apps/workspace`;
  const wsArgs = ['--project=dev', '--grep-invert', skip, ...words];
  const wsTotal = listTotal(ws, wsArgs) * repeat;
  if (process.env.SHARD) {
    const inShard = listTotal(ws, [...wsArgs, `--shard=${process.env.SHARD}`]) * repeat;
    console.log(
      `Workspace step, shard ${process.env.SHARD}: ${inShard} of ${wsTotal} matching tests.`,
    );
  }
  const portalTotal = listTotal(`${root}apps/portal`, words) * repeat;
  console.log(`Portal step: ${portalTotal} matching tests.`);
  const verdict = decide({ filter, wsTotal, portalTotal });
  console.log(verdict.message);
  if (!verdict.ok) {
    console.log(`::error::${verdict.message}`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
