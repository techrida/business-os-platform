// Run: node --test tools/affected.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { affected, loadWorkspace, qaMatrix, withDependents } from './affected.mjs';

const packages = loadWorkspace();
const run = (...files) => affected(files, packages);

test('the workspace graph is read from package.json', () => {
  assert.ok(packages.find((p) => p.name === '@bos/api').deps.includes('@bos/money-rules'));
  assert.ok(packages.find((p) => p.name === '@bos/money-rules').deps.includes('@bos/locale'));
});

test('a docs-only diff runs nothing heavy', () => {
  const r = run('docs/adr/0016.md', 'README.md', 'apps/portal/README.md');
  assert.equal(r['docs-only'], true);
  for (const k of [
    'full',
    'api',
    'workspace',
    'portal',
    'db',
    'docker',
    'web',
    'qa-workspace',
    'qa-portal',
  ])
    assert.equal(r[k], false, k);
  assert.deepEqual(r.packages, []);
});

test('apps/portal only: portal, its build and image, and the portal specs', () => {
  const r = run('apps/portal/src/app/page.tsx');
  assert.equal(r.full, false);
  assert.deepEqual([r.portal, r.web, r.docker, r['qa-portal']], [true, true, true, true]);
  assert.deepEqual([r.api, r.workspace, r.db, r['qa-workspace']], [false, false, false, false]);
  assert.deepEqual(r.packages, ['@bos/portal']);
  assert.deepEqual(qaMatrix(r).include, [{ mode: 'specs', id: '1', shard: '1/3', ws: false }]);
});

test('apps/workspace only: workspace and its specs, not the portal or the API tests', () => {
  const r = run('apps/workspace/src/x.ts');
  assert.deepEqual(
    [r.workspace, r['qa-workspace'], r.portal, r['qa-portal'], r.api],
    [true, true, false, false, false],
  );
  assert.equal(qaMatrix(r).include.length, 4);
});

test('apps/api: both browser suites run, because both apps serve from the API', () => {
  const r = run('apps/api/src/x.ts');
  assert.deepEqual(
    [r.api, r['qa-workspace'], r['qa-portal'], r.workspace, r.portal],
    [true, true, true, false, false],
  );
});

test('a package marks its dependents (money-rules -> locale chain)', () => {
  const r = run('packages/locale/src/index.ts');
  assert.ok(
    r.packages.includes('@bos/locale') &&
      r.packages.includes('@bos/money-rules') &&
      r.packages.includes('@bos/api'),
  );
  assert.ok(r.workspace && r.portal && r.api);
  assert.equal(r.full, false);
  assert.deepEqual([...withDependents(new Set(['@bos/money-rules']), packages)].sort(), [
    '@bos/api',
    '@bos/money-rules',
  ]);
});

test('pdf-viewer reaches both apps but not the API', () => {
  const r = run('packages/pdf-viewer/src/x.ts');
  assert.deepEqual(
    [r.workspace, r.portal, r.api, r['qa-workspace'], r['qa-portal']],
    [true, true, false, true, true],
  );
});

test('@bos/contracts and @bos/db run everything', () => {
  assert.equal(run('packages/contracts/src/a.ts').full, true);
  assert.equal(run('packages/db/migrations/0200.sql').full, true);
  assert.equal(run('packages/contracts/src/a.ts')['qa-workspace'], true);
});

test('lockfile and shared roots run everything', () => {
  for (const f of [
    'pnpm-lock.yaml',
    'package.json',
    'pnpm-workspace.yaml',
    'tsconfig.base.json',
    'eslint.config.mjs',
    '.github/workflows/ci.yml',
    'infra/compose/compose.yaml',
    'tools/gate.sh',
  ]) {
    assert.equal(run(f).full, true, f);
  }
});

test('a gate input is never a doc, even when it ends in .md or .txt', () => {
  assert.equal(run('.github/qa/quarantine.txt').full, true);
  assert.equal(run('infra/README.md').full, true);
  assert.equal(run('tools/NOTES.md').full, true);
});

test('a path nobody owns runs everything', () => {
  assert.equal(run('mystery/file.ts').full, true);
  assert.equal(run('apps/portal/src/a.ts', 'something-new.json').full, true);
});

test('a doc next to code does not hide the code', () => {
  const r = run('README.md', 'apps/portal/src/a.ts');
  assert.deepEqual([r.portal, r.workspace, r.full], [true, false, false]);
});

test('an empty diff, and every event except pull_request, run everything', () => {
  assert.equal(affected([], packages).full, true);
  for (const event of ['push', 'schedule', 'workflow_dispatch'])
    assert.equal(affected(['docs/a.md'], packages, { event }).full, true, event);
});

test('the full matrix keeps the job names qa specs 1/2/3 and qa quarantined -', () => {
  assert.deepEqual(
    qaMatrix(run('pnpm-lock.yaml')).include.map((m) => `${m.mode} ${m.id}`),
    ['specs 1', 'specs 2', 'specs 3', 'quarantined -'],
  );
  assert.equal(qaMatrix(run('docs/a.md')).include.length, 0);
});
