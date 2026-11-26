// Run: node --test infra/scripts/check-image-pins.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const checker = join(dirname(fileURLToPath(import.meta.url)), 'check-image-pins.mjs');
const repoRoot = join(dirname(checker), '..', '..');
const DIGEST = `sha256:${'a'.repeat(64)}`;

/** Builds a throwaway repo root holding the given files, runs the checker on it, returns the result. */
function check(files) {
  const root = mkdtempSync(join(tmpdir(), 'pins-'));
  try {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return spawnSync(process.execPath, [checker, root], { encoding: 'utf8' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('an unpinned image in a script under infra/backup fails the check', () => {
  const r = check({
    'infra/backup/files-backup.sh':
      'docker run --rm -v "$V:/data:ro" restic/restic:0.18.1 backup /data\n',
  });
  assert.equal(r.status, 1, r.stderr);
  assert.match(
    r.stderr,
    /infra\/backup\/files-backup\.sh:1: docker run image "restic\/restic:0\.18\.1" has no @sha256 digest/,
  );
});

test('a variable image in a script under infra/backup fails the check (the pin could not be seen)', () => {
  const r = check({ 'infra/backup/files-backup.sh': 'docker run --rm "$IMAGE" check\n' });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /infra\/backup\/files-backup\.sh:1: .*variable/);
});

test('a digest-pinned image under infra/backup passes', () => {
  const r = check({
    'infra/backup/files-backup.sh': `docker run --rm \\\n  -v "$V:/data:ro" \\\n  restic/restic:0.18.1@${DIGEST} backup /data\n`,
  });
  assert.equal(r.status, 0, r.stderr);
});

test('the scan still covers infra/scripts', () => {
  const r = check({ 'infra/scripts/x.sh': 'docker run --rm node:24 true\n' });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /infra\/scripts\/x\.sh:1/);
});

test('every image this repo runs is digest-pinned, including infra/backup', () => {
  const r = spawnSync(process.execPath, [checker, repoRoot], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});
