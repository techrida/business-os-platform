// With a spec filter set (workflow_dispatch input spec_filter), prints how many tests each Playwright step will run and
// fails when the filter matched no test in BOTH the workspace and the portal suite: both steps pass with no tests when a
// filter is set (a filter naming only portal specs matches nothing in the workspace, and the other way round), so a
// mistyped filter would otherwise pass silently. With no filter it does nothing: no tests is a failure of the steps
// themselves.
// Counts come from `playwright test --list`, which applies the same file filters and --grep-invert as the real run.
// Run by the qa workflow: node .github/qa/spec-counts.mjs  (env: SPEC_FILTER, SHARD, REPEAT_EACH, WS_STEP)
//
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

/** The spec files (relative to the e2e folder) named in a `playwright test --list` output. */
export function parseSpecFiles(listOutput) {
  const files = new Set();
  for (const m of listOutput.matchAll(/([\w./-]+\.spec\.ts):\d+:\d+/g)) files.add(m[1]);
  return files;
}

/** The files each list names, as e2e-relative paths (the lists hold `e2e/...`, ready to pass to playwright). */
function relative(entry) {
  return entry.trim().replace(/^e2e\//, '');
}

/**
 * Every spec file the run executes is in exactly one list, and every list entry is a spec file the run executes.
 * `lists` maps a list name to its lines (the file split on newlines).
 */
export function checkLists({ specFiles, lists }) {
  const problems = [];
  const owner = new Map();
  for (const [name, lines] of Object.entries(lists)) {
    // Each line goes to Playwright as a regex: a blank line would match every spec and a padded line would match none,
    // silently. Only the empty piece after the final newline is allowed.
    const entries = lines.at(-1) === '' ? lines.slice(0, -1) : lines;
    for (const line of entries) {
      if (line === '' || line !== line.trim()) {
        problems.push(`${name} has a blank or padded line: ${JSON.stringify(line)}`);
        continue;
      }
      const file = relative(line);
      if (owner.has(file))
        problems.push(`${file} is listed twice (${owner.get(file)} and ${name})`);
      else owner.set(file, name);
      if (!specFiles.has(file)) problems.push(`${file} (${name}) is not a spec the run executes`);
    }
  }
  for (const file of [...specFiles].sort())
    if (!owner.has(file)) problems.push(`${file} is in no shard list`);
  return { ok: problems.length === 0, problems };
}

/** The --grep-invert of the workspace step: persona sign-ins ran in the warm-up, quarantined specs stay out. */
export function skipPattern(quarantine) {
  const skip = 'persona sign-in and sign-out|qa fixtures: ';
  return quarantine.trim() ? `${skip}|${quarantine.trim()}` : skip;
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

function checkShardLists(root) {
  const ws = `${root}apps/workspace`;
  const quarantine = readFileSync(`${root}.github/qa/quarantine.txt`, 'utf8');
  const out = execFileSync(
    'pnpm',
    [
      'exec',
      'playwright',
      'test',
      '--list',
      '--project=dev',
      '--grep-invert',
      skipPattern(quarantine),
    ],
    { cwd: ws, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const lists = {};
  for (const name of Array.from(
    { length: Number(process.env.QA_SHARDS) },
    (_, i) => `shard-${i + 1}`,
  ))
    lists[name] = readFileSync(`${root}.github/qa/${name}.txt`, 'utf8').split('\n');
  const verdict = checkLists({ specFiles: parseSpecFiles(out), lists });
  for (const problem of verdict.problems) console.log(`::error::${problem}`);
  console.log(
    verdict.ok
      ? 'Every workspace spec is in exactly one shard list.'
      : 'The shard lists and the specs disagree: update .github/qa/spec-seconds.json.',
  );
  if (!verdict.ok) process.exit(1);
}

function main() {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  if (process.argv.includes('--lists')) return checkShardLists(root);
  const filter = process.env.SPEC_FILTER ?? '';
  const words = filter.split(/\s+/).filter(Boolean);
  const repeat = Number(process.env.REPEAT_EACH || '1');
  if (words.length === 0) {
    console.log(decide({ filter, wsTotal: 0, portalTotal: 0 }).message);
    return;
  }
  // The same --grep-invert as the workspace step: the persona sign-ins ran in the warm-up, quarantined specs stay out.
  const skip = skipPattern(readFileSync(`${root}.github/qa/quarantine.txt`, 'utf8'));
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
