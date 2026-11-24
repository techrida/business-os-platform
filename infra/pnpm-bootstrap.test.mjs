// The pnpm that Dockerfiles and dev-machine-setup.sh install comes from infra/pnpm-bootstrap's lockfile.
// Run: node --test infra/pnpm-bootstrap.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const rootPnpm = JSON.parse(read('package.json')).packageManager.replace(/^pnpm@/, '');

test('bootstrap pnpm version equals the root packageManager', () => {
  const pkg = JSON.parse(read('infra/pnpm-bootstrap/package.json'));
  assert.equal(pkg.dependencies.pnpm, rootPnpm);
  const lock = JSON.parse(read('infra/pnpm-bootstrap/package-lock.json'));
  assert.equal(lock.packages['node_modules/pnpm'].version, rootPnpm);
  assert.match(lock.packages['node_modules/pnpm'].integrity, /^sha512-/);
});

test('no Dockerfile or setup script installs pnpm with an unpinned `npm install -g`', () => {
  for (const file of [
    'apps/api/Dockerfile',
    'apps/portal/Dockerfile',
    'apps/workspace/Dockerfile',
    'infra/scripts/dev-machine-setup.sh',
  ]) {
    const text = read(file);
    assert.doesNotMatch(text, /npm (i|install)\b[^\n]*-g[^\n]*pnpm|npm (i|install) --global pnpm/, file);
    assert.match(text, /npm ci --prefix [^\n]*pnpm-bootstrap/, file);
  }
});

test('dev-machine-setup.sh does not pipe curl into a shell', () => {
  assert.doesNotMatch(read('infra/scripts/dev-machine-setup.sh'), /curl[^\n]*\|\s*(bash|sh)\b/);
});
