// Proves the root eslint.config.mjs fails app code that imports the raw DB driver (finding D32 / N2).
// It uses ESLint's Node API on text, linted as if it lived at a real app path, so no fixture file
// sits in the tree to trip the normal `eslint .` run. `filePath` must be an existing file because
// typed linting looks the path up in the tsconfig program.
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const APP_FILE = 'apps/api/src/app.module.ts';
const RULE = 'no-restricted-imports';

// The first typed lint builds the TypeScript program for the whole repo, which can take 20 s or more.
vi.setConfig({ testTimeout: 120_000 });

let eslint: ESLint;

async function ruleMessages(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: `${repoRoot}${filePath}` });
  return (result?.messages ?? []).filter((m) => m.ruleId === RULE).map((m) => m.message);
}

beforeAll(() => {
  // Discovers the root eslint.config.mjs, the same file `pnpm lint` uses.
  eslint = new ESLint({ cwd: repoRoot });
});

describe('driver import boundary', () => {
  it.each([
    ["import { Pool } from 'pg';", 'pg'],
    ["import postgres from 'postgres';", 'postgres'],
    ["import { drizzle } from 'drizzle-orm/node-postgres';", 'drizzle-orm/node-postgres'],
    [
      "import { migrate } from 'drizzle-orm/node-postgres/migrator';",
      'drizzle-orm/node-postgres/migrator',
    ],
    ["import { drizzle } from 'drizzle-orm/postgres-js';", 'drizzle-orm/postgres-js'],
  ])('refuses %s in app source', async (line, module) => {
    const messages = await ruleMessages(`${line}\nexport const x = 1;\n`, APP_FILE);
    expect(messages, `${module} must be refused outside packages/db`).not.toEqual([]);
    expect(messages.join(' ')).toContain('@bos/db');
  });

  it('still allows drizzle-orm operators and the pg-core schema builders', async () => {
    const code =
      "import { eq } from 'drizzle-orm';\nimport type { AnyPgColumn } from 'drizzle-orm/pg-core';\n" +
      'export const x: AnyPgColumn | typeof eq | undefined = undefined;\n';
    expect(await ruleMessages(code, APP_FILE)).toEqual([]);
  });

  it('does not apply inside packages/db, which owns the driver', async () => {
    const code = "import { Pool } from 'pg';\nexport const p = Pool;\n";
    expect(await ruleMessages(code, 'packages/db/src/client.ts')).toEqual([]);
  });

  it.each([
    'apps/api/src/platform/db/db.module.ts',
    'apps/api/src/platform/health/health.service.ts',
  ])('keeps the named exemption for %s', async (file) => {
    const code = "import { Pool } from 'pg';\nexport const p = Pool;\n";
    expect(await ruleMessages(code, file)).toEqual([]);
  });

  it('lets Testcontainers tests build their own pool', async () => {
    const code = "import { Pool } from 'pg';\nexport const p = Pool;\n";
    expect(await ruleMessages(code, 'apps/api/src/platform/audit/audit.service.test.ts')).toEqual(
      [],
    );
  });
});
