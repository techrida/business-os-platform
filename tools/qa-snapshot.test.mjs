import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../.github/qa/snapshot.sh', import.meta.url));

test('the encrypted snapshot restores both databases, portal state, files and same-commit builds', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'qa-snapshot-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'producer');
  const target = join(root, 'shard');
  const bin = join(root, 'bin');
  const marker = 'synthetic fixture data';
  for (const dir of [bin, target, join(root, 'gnupg')]) mkdirSync(dir);
  chmodSync(join(root, 'gnupg'), 0o700);
  const files = [
    '.dev/personas.json',
    '.dev/files/proof',
    '.dev/login-client.pat',
    '.dev/zitadel.env',
    '.dev/zitadel-api.env',
    '.dev/zitadel-portal.env',
    '.dev/portal-customer.json',
    '.dev/portal-vendor.json',
    '.dev/portal-vendor-b.json',
    '.dev/portal-pending.json',
    '.dev/portal-proof.pdf',
    '.dev/qa-fixture-ids.json',
    'apps/api/dist/main.js',
    'packages/db/dist/index.js',
    'apps/portal/.next/BUILD_ID',
    'apps/workspace/.next-devtools/BUILD_ID',
  ];
  for (const name of [...files, '.dev/logs/api.log', 'apps/portal/.next/cache/unneeded']) {
    const path = join(source, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, marker);
  }
  writeFileSync(join(source, '.env'), 'VALKEY_PASSWORD=synthetic\n');
  writeFileSync(
    join(bin, 'docker'),
    `#!/usr/bin/env bash
case " $* " in
  *" pg_dump "*) echo "dump \${!#}" ;;
  *" valkey-cli "*) echo '[]' ;;
  *" ps "*) echo container ;;
  *" cp "*) echo synthetic > "\${!#}" ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o755 },
  );
  writeFileSync(join(bin, 'sudo'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const env = {
    ...process.env,
    RUNNER_TEMP: root,
    GNUPGHOME: join(root, 'gnupg'),
    PATH: bin + ':' + process.env.PATH,
    QA_FIXTURE_KEY: randomBytes(32).toString('hex'),
  };
  const run = (mode, cwd, key = env.QA_FIXTURE_KEY) =>
    execFileSync('bash', [script, mode], {
      cwd,
      env: { ...env, QA_FIXTURE_KEY: key },
      stdio: 'pipe',
    });
  run('save', source);
  assert.ok(!readFileSync(join(root, 'fixtures.gpg')).includes(marker));
  run('unpack', target);
  for (const name of files) assert.equal(readFileSync(join(target, name), 'utf8'), marker, name);
  for (const db of ['bos', 'zitadel'])
    assert.equal(readFileSync(join(target, '.dev', db + '.dump'), 'utf8'), 'dump ' + db + '\n');
  assert.ok(!existsSync(join(target, '.dev/logs/api.log')));
  assert.ok(!existsSync(join(target, 'apps/portal/.next/cache')));
});
