import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fixtureKey } from './qa-fixture-key.mjs';

test('a change to fixture inputs or encryption key invalidates the exact cache key', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'qa-inputs-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd });
  const stage = (file, content) => {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), content);
    execFileSync('git', ['add', '--', file], { cwd });
  };
  stage('pnpm-lock.yaml', 'one');
  const initial = fixtureKey(cwd, 'test');
  stage('apps/workspace/src/app/page.tsx', 'new page');
  assert.equal(fixtureKey(cwd, 'test'), initial);
  for (const file of [
    'packages/db/migrations/0001.sql',
    'tools/seed-zitadel/src/index.ts',
    'apps/workspace/e2e/p4/qa-fixtures-new.spec.ts',
    'infra/compose/compose.yaml',
    'pnpm-lock.yaml',
  ]) {
    const previous = fixtureKey(cwd, 'test');
    stage(file, 'two');
    assert.notEqual(fixtureKey(cwd, 'test'), previous, file);
  }
  assert.notEqual(fixtureKey(cwd, 'test'), fixtureKey(cwd, 'rotated'));
});
