// Flat ESLint config (ESLint 9): typescript-eslint typed rules everywhere, plus the
// eslint-config-next 16 rules scoped to apps/workspace only.
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const WORKSPACE_FILES = ['apps/workspace/**/*.{js,jsx,mjs,ts,tsx}'];

/**
 * eslint-config-next ships global configs. Restrict each config object to the workspace app.
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

  ...nextForWorkspace,
  {
    files: WORKSPACE_FILES,
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    settings: { next: { rootDir: 'apps/workspace/' } },
  },

  // k6 scripts run inside k6's own JS runtime, which provides these globals.
  {
    files: ['perf/k6/**/*.js'],
    languageOptions: { globals: { __VU: 'readonly', __ITER: 'readonly', open: 'readonly' } },
  },
]);
