// Run: node --test tools/qa-workflow.test.mjs
// The required `qa required` check must report on every pull request, so the pull_request trigger has no filter.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const text = readFileSync(new URL('../.github/workflows/qa.yml', import.meta.url), 'utf8');
const on = text.slice(text.indexOf('\non:'), text.indexOf('\npermissions:'));

test('qa runs on every pull request: no paths or paths-ignore filter on pull_request', () => {
  assert.match(on, /\n {2}pull_request:\s*\n/);
  const afterPr = on.slice(on.indexOf('pull_request:'));
  assert.doesNotMatch(afterPr, /paths(-ignore)?:/);
});

test('the quarantined job stays non-blocking', () => {
  assert.match(text, /continue-on-error: \$\{\{ matrix\.mode == 'quarantined' \}\}/);
});

test('qa required always reports and needs every job; the matrix comes from the change detection', () => {
  assert.match(
    text,
    /qa-required:\n {4}name: qa required\n {4}if: \$\{\{ always\(\) \}\}\n {4}needs: \[changes, fixtures, workspace\]/,
  );
  assert.match(text, /matrix: \$\{\{ fromJSON\(needs\.changes\.outputs\.qa-matrix\) \}\}/);
});

test('ci required always reports and needs every ci job', () => {
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(
    ci,
    /ci-required:\n {4}name: ci required\n {4}if: \$\{\{ always\(\) \}\}\n {4}needs: \[changes, checks, secrets, e2e, web, docker\]/,
  );
});

test('the tools tests run from a glob that includes tools/policy, in ci.yml and in tools/gate.sh', () => {
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const gate = readFileSync(new URL('./gate.sh', import.meta.url), 'utf8');
  for (const [name, source] of [
    ['ci.yml', ci],
    ['tools/gate.sh', gate],
  ]) {
    const line = source.split('\n').find((l) => l.includes('node --test'));
    assert.ok(line, `${name} has a node --test line`);
    // Quoted, so node (not the shell) expands them: an unmatched pattern is then ignored instead of passed on literally.
    assert.match(line, /"tools\/\*\.test\.mjs"/, name);
    assert.match(line, /"tools\/policy\/\*\.test\.mjs"/, name);
    assert.match(line, /"infra\/\*\.test\.mjs"/, name);
    assert.match(line, /"infra\/scripts\/\*\.test\.mjs"/, name);
    assert.doesNotMatch(line, /tools\/(affected|qa-[a-z-]+|check-public-repo)\.test\.mjs/, name);
  }
});

test('the workspace step runs its shard from a file list; a spec filter falls back to Playwright --shard', () => {
  const step = text.slice(text.indexOf('- name: Playwright (workspace, dev project)'));
  const run = step.slice(0, step.indexOf('\n      - name:', 10));
  assert.match(run, /LIST: \$\{\{ matrix\.list \}\}/);
  assert.match(run, /mapfile -t targets < "\.\.\/\.\.\/\.github\/qa\/\$LIST\.txt"/);
  assert.match(run, /--shard="\$SHARD"/);
});

test('the portal specs run on the job the matrix marks (or shard 1 of an older base selector)', () => {
  assert.match(
    text,
    /- name: Portal specs[^\n]*\n(?: {8}#[^\n]*\n)* {8}if: \$\{\{ !cancelled\(\) && matrix\.mode == 'specs' && \(matrix\.portal \|\| \(!matrix\.list && matrix\.id == '1'\)\) \}\}/,
  );
});

test('the shard lists are checked after the stack is up (Playwright reads .dev files when it lists) and before any spec', () => {
  const up = text.indexOf('- name: Start shard stack');
  const assign = text.indexOf('- name: Assign the current workspace specs');
  const check = text.indexOf('node .github/qa/spec-counts.mjs --lists');
  assert.ok(up > 0 && up < assign && assign < check);
  assert.match(
    text,
    /if: matrix.mode == 'specs' && matrix.id == '1'\n {8}run: node .github\/qa\/spec-counts.mjs --lists/,
  );
  assert.ok(check < text.indexOf('- name: Playwright (workspace, dev project)'));
});

test('no workflow still talks about three shards', () => {
  assert.doesNotMatch(text, /specs 1\/2\/3|Three shards|1\/3/);
});

test('every image build step in ci.yml is gated on its own image output (or a full run)', () => {
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const docker = ci.slice(ci.indexOf('\n  docker:'), ci.indexOf('\n  ci-required:'));
  const steps = docker.split('\n      - ').slice(1);
  const gated = (name, image) => {
    const step = steps.find((s) => s.startsWith(`name: ${name}`));
    assert.ok(step, name);
    assert.match(
      step,
      new RegExp(
        `if: \\$\\{\\{ needs\\.changes\\.outputs\\.full == 'true' \\|\\| needs\\.changes\\.outputs\\.docker-${image} == 'true' \\}\\}`,
      ),
      name,
    );
  };
  gated('Build api image', 'api');
  gated('Build workspace image', 'workspace');
  gated('Check no dev routes in the workspace image', 'workspace');
  gated('Build portal image', 'portal');
  gated('Test Login V2 forms', 'login');
  gated('Build Login V2 image', 'login');
  for (const image of ['api', 'workspace', 'portal', 'login'])
    assert.match(
      ci,
      new RegExp(`docker-${image}: \\$\\{\\{ steps\\.affected\\.outputs\\.docker-${image} \\}\\}`),
    );
});

test('both workflows ask the selector for the same-commit skip, with actions: read on the changes job only', () => {
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  for (const [file, source] of [
    ['ci.yml', ci],
    ['qa.yml', text],
  ]) {
    const changes = source.slice(
      source.indexOf('\n  changes:'),
      source.indexOf('\n  workspace:') > 0
        ? source.indexOf('\n  workspace:')
        : source.indexOf('\n  checks:'),
    );
    assert.match(changes, /permissions:\n {6}contents: read\n {6}actions: read/, file);
    assert.match(
      changes,
      /BOS_SKIP_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/,
      file,
    );
    assert.match(changes, new RegExp(`BOS_SKIP_WORKFLOW: ${file.replace('.', '\\.')}`), file);
    assert.equal(
      source.split(/^\s+actions: read$/m).length - 1,
      1,
      `${file}: actions: read only on changes`,
    );
  }
});

test('ci.yml: checks and secrets do not run when the same-commit skip applies', () => {
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const job = (name, next) => ci.slice(ci.indexOf(`\n  ${name}:`), ci.indexOf(`\n  ${next}:`));
  for (const section of [job('checks', 'secrets'), job('secrets', 'e2e')]) {
    assert.match(
      section,
      /needs: changes\n {4}if: \$\{\{ needs\.changes\.outputs\.skip != 'true' \}\}/,
    );
  }
});

test('a pull request runs the selector from its base commit, never its own copy', () => {
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  for (const [file, source] of [
    ['ci.yml', ci],
    ['qa.yml', text],
  ]) {
    const use = source.indexOf('- name: Use the selector from the base commit');
    const map = source.indexOf('- name: Map the diff to areas');
    assert.ok(
      use > 0 && use < map,
      `${file}: the base copy is put in place before the selector runs`,
    );
    const step = source.slice(use, map);
    assert.match(step, /if: \$\{\{ github\.event_name == 'pull_request' \}\}/, file);
    assert.match(step, /git show "\$BASE_SHA:tools\/affected\.mjs" > tools\/affected\.mjs/, file);
    assert.match(step, /BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/, file);
  }
});

test('every checkout in the four workflows drops its token, and dependabot watches the compose images', () => {
  for (const file of ['ci', 'qa', 'codeql', 'dependency-review']) {
    const source = readFileSync(
      new URL(`../.github/workflows/${file}.yml`, import.meta.url),
      'utf8',
    );
    const checkouts = source.split('- uses: actions/checkout@').slice(1);
    assert.ok(checkouts.length > 0, file);
    for (const rest of checkouts) {
      const step = rest.slice(0, rest.search(/\n\s*\n|\n {6}- /));
      assert.match(step, /persist-credentials: false/, `${file}.yml: ${step.slice(0, 40)}`);
    }
  }
  const dependabot = readFileSync(new URL('../.github/dependabot.yml', import.meta.url), 'utf8');
  assert.match(dependabot, /package-ecosystem: docker-compose\n {4}directory: \/infra\/compose/);
});

test('ci.yml checks: format runs first after the install, and a docs-only change skips typecheck and lint only', () => {
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const checks = ci.slice(ci.indexOf('\n  checks:'), ci.indexOf('\n  secrets:'));
  const names = [...checks.matchAll(/\n {6}- (?:name|uses): ([^\n]+)/g)].map((m) => m[1]);
  const install = names.findIndex((n) => n.startsWith('Install'));
  assert.equal(names[install + 1], 'Format check');
  const step = (name) => {
    const at = checks.indexOf(`- name: ${name}`);
    return checks.slice(at, checks.indexOf('\n\n', at));
  };
  const docsOnly = /if: \$\{\{ needs\.changes\.outputs\.docs-only != 'true' \}\}/;
  assert.match(step('Typecheck'), docsOnly);
  assert.match(step('Lint (zero warnings allowed)'), docsOnly);
  assert.doesNotMatch(step('Format check'), /\n\s+if:/);
});

test('release and main pull requests run CI, QA and security checks', () => {
  for (const name of ['ci', 'qa', 'codeql', 'dependency-review']) {
    const workflow = readFileSync(
      new URL(`../.github/workflows/${name}.yml`, import.meta.url),
      'utf8',
    );
    assert.match(workflow, /\n {2}pull_request:\n {4}branches: \[main, 'kuu\/release-\*'\]/, name);
  }
});
