// git ls-files includes names, executable bits and blob IDs; deletions and renames invalidate too.
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const inputs = [
  '.env.example',
  '.dockerignore',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'patches',
  'packages/db',
  'tools/seed-zitadel',
  'infra/compose',
  'infra/postgres',
  'infra/login',
  'infra/caddy',
  'infra/zitadel',
  'infra/scripts/dev-login-client.mjs',
  'infra/scripts/make-dev-env.sh',
  'infra/scripts/migrate-dev.sh',
  'infra/scripts/export-dev-ca.sh',
  'apps/workspace/src/styles/tokens.css',
  'apps/workspace/src/styles/token-overrides.css',
  'packages/locale/src/theme-mode.ts',
  'apps/workspace/playwright.config.ts',
  'apps/workspace/e2e/helpers',
  'apps/workspace/e2e/personas.spec.ts',
  'apps/workspace/e2e/p4/qa-fixtures*.spec.ts',
  '.github/actions/qa-fixtures',
  '.github/qa/compose.qa.yaml',
  '.github/qa/demo-data.sql',
  '.github/qa/up.sh',
  '.github/qa/export-ids.sh',
  '.github/qa/snapshot.sh',
  '.github/qa/registry.sh',
  '.github/actions/qa-cache',
  'tools/qa-fixture-key.mjs',
];

export function fixtureKey(cwd, key) {
  const index = execFileSync('git', ['ls-files', '--stage', '-z', '--', ...inputs], { cwd });
  return 'qa-fixture-v2-' + createHmac('sha256', key).update(index).digest('hex');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log('key=' + fixtureKey(process.cwd(), process.env.QA_FIXTURE_KEY));
