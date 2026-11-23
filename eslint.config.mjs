// Flat ESLint config (ESLint 9): typescript-eslint typed rules everywhere, plus the
// eslint-config-next 16 rules scoped to apps/workspace and apps/portal.
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import { NATIVE_INPUT_SELECTOR, NO_NATIVE_DIALOGS } from './tools/eslint/native-controls-rule.mjs';
import { RESTRICTED_SYNTAX } from './tools/eslint/native-title-rule.mjs';

const WORKSPACE_FILES = [
  'apps/workspace/**/*.{js,jsx,mjs,ts,tsx}',
  'apps/portal/**/*.{js,jsx,mjs,ts,tsx}',
];

const DRIVER_MESSAGE =
  'Only packages/db may import the raw Postgres driver. Use @bos/db (createDb, the typed tables) and the injected DB with withTx instead.';

/**
 * eslint-config-next ships global configs. Restrict each config object to the workspace and portal apps.
 * An object that holds only `ignores` is a global ignore, and giving it `files` would turn it
 * into a per-config ignore, so those objects pass through unchanged.
 */
const nextForWorkspace = nextVitals.map((config) => {
  const onlyIgnores = Object.keys(config).every((key) => key === 'ignores' || key === 'name');
  return onlyIgnores ? config : { ...config, files: WORKSPACE_FILES };
});

export default defineConfig([
  globalIgnores([
    '**/node_modules/**',
    '**/dist/**',
    '**/.next/**',
    '**/.next-*/**',
    '**/coverage/**',
    '**/playwright-report/**',
    '**/test-results/**',
    '**/.dev/**',
    '**/next-env.d.ts',
    // Login overlay files are type-checked by the pinned upstream Next.js build.
    'infra/login/overlay/**',
  ]),

  {
    files: ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },

  {
    files: ['**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },

  // Plain JS and config files are not part of any tsconfig program.
  {
    files: ['**/*.{js,jsx,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  // Test files: mocks and expect() matchers trip the unbound-method rule.
  {
    files: ['**/*.test.{ts,tsx}', '**/test/**/*.ts', '**/e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/unbound-method': 'off',
    },
  },

  // Import boundary (review finding D32): only packages/db may touch the raw Postgres driver.
  // Everything else goes through @bos/db, so a new module cannot bypass tenancy scoping or `withTx`
  // by opening its own connection. (Test files, listed below, are the exception.) `drizzle-orm` itself (operators) and `drizzle-orm/pg-core`
  // (schema builders, column types) are not drivers and stay allowed.
  {
    files: ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    ignores: ['packages/db/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ['pg', 'pg-pool', 'postgres'].map((name) => ({ name, message: DRIVER_MESSAGE })),
          patterns: [
            {
              group: ['drizzle-orm/node-postgres', 'drizzle-orm/node-postgres/*'],
              message: DRIVER_MESSAGE,
            },
            {
              group: ['drizzle-orm/postgres-js', 'drizzle-orm/postgres-js/*'],
              message: DRIVER_MESSAGE,
            },
          ],
        },
      ],
    },
  },
  // Exemptions, each one deliberate. Keep this list short; do not add a file to dodge the rule.
  {
    files: [
      // Tests build their own pg.Pool against a Testcontainers Postgres, and the e2e global setup
      // and fixtures migrate and seed that database as a superuser.
      '**/*.test.{ts,tsx}',
      'apps/api/test/e2e/**/*.ts',
      // The one place the API opens its pool and wraps it in drizzle.
      'apps/api/src/platform/db/db.module.ts',
      // Pings Postgres through the injected PG_POOL, so it names the pg.Pool type.
      'apps/api/src/platform/health/health.service.ts',
      // The ZITADEL seed tool is a standalone script with its own connection and no API process.
      'tools/seed-zitadel/src/**/*.ts',
    ],
    rules: { 'no-restricted-imports': 'off' },
  },

  ...nextForWorkspace,
  {
    files: WORKSPACE_FILES,
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    settings: { next: { rootDir: ['apps/workspace/', 'apps/portal/'] } },
  },

  // UIP-BUILD-002: no browser-default hover tooltips (rules and reasons in tools/eslint/native-title-rule.mjs; header-action.tsx links its sr-only description on purpose).
  {
    files: WORKSPACE_FILES,
    ignores: ['**/*.test.{ts,tsx}', 'apps/workspace/src/components/ui/header-action.tsx'],
    rules: {
      // One entry: a later `no-restricted-syntax` config would replace this one, not add to it.
      'no-restricted-syntax': [...RESTRICTED_SYNTAX, NATIVE_INPUT_SELECTOR],
      'no-alert': NO_NATIVE_DIALOGS,
    },
  },

  // k6 scripts run inside k6's own JS runtime, which provides these globals.
  {
    files: ['perf/k6/**/*.js'],
    languageOptions: { globals: { __VU: 'readonly', __ITER: 'readonly', open: 'readonly' } },
  },
]);
