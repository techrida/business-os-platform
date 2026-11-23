import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { expect, it } from 'vitest';

// UIP-BUILD-002: the lint rules that keep the browser's own tick box, radio dot and confirm / alert /
// prompt dialogs out of the apps. They run the real rule (tools/eslint/native-controls-rule.mjs, also
// used by eslint.config.mjs) on the shapes that were in the app, and on the ones that must stay allowed.

const ruleModule = new URL('../../../../../tools/eslint/native-controls-rule.mjs', import.meta.url)
  .href;

async function lint(code: string) {
  const { NATIVE_INPUT_SELECTOR, NO_NATIVE_DIALOGS } = (await import(
    /* @vite-ignore */ ruleModule
  )) as {
    NATIVE_INPUT_SELECTOR: { selector: string; message: string };
    NO_NATIVE_DIALOGS: Linter.RuleEntry;
  };
  const linter = new Linter({ configType: 'flat' });
  const messages = linter.verify(
    code,
    [
      {
        files: ['**/*.tsx'],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: { ecmaFeatures: { jsx: true } },
          globals: { window: 'readonly' },
        },
        rules: {
          'no-restricted-syntax': ['error', NATIVE_INPUT_SELECTOR],
          'no-alert': NO_NATIVE_DIALOGS,
        },
      },
    ],
    'sample.tsx',
  );
  return messages.map((m) => m.message);
}

it('blocks the old sites: a bare checkbox or radio input, in either attribute spelling', async () => {
  // vendor-form.tsx before the fix
  expect(
    await lint(
      'const a = <input type="checkbox" name="vatRegistered" checked={on} onChange={f} />;',
    ),
  ).toHaveLength(1);
  // convert-dialog.tsx before the fix (multi-line JSX, radio)
  expect(
    await lint(`const a = (
      <input
        type="radio"
        name="customerMode"
        value="existing"
      />
    );`),
  ).toHaveLength(1);
  expect(await lint(`const a = <input type={'checkbox'} />;`)).toHaveLength(1);
});

it('names the design-system component in the input error', async () => {
  const [message] = await lint('const a = <input type="checkbox" />;');
  expect(message).toContain('<Checkbox>');
  expect(message).toContain('@/components/ui/checkbox');
});

it('blocks window.confirm, alert and prompt, and the bare globals', async () => {
  // quote-builder.tsx before the fix
  expect(
    await lint(`function f() { return window.confirm('Leave without saving?'); }`),
  ).toHaveLength(1);
  expect(await lint(`window.alert('Saved');`)).toHaveLength(1);
  expect(await lint(`const name = window.prompt('Name?');`)).toHaveLength(1);
  expect(await lint(`if (!confirm('Sure?')) return;`)).toHaveLength(1);
});

it('allows other inputs, our own components, and a local function named confirm', async () => {
  expect(await lint('const a = <input type="text" />;')).toEqual([]);
  expect(await lint('const a = <input type="hidden" name="x" />;')).toEqual([]);
  expect(await lint('const a = <input type="file" />;')).toEqual([]);
  expect(await lint('const a = <Checkbox name="x" />;')).toEqual([]);
  expect(await lint('const a = <Radio value="x" />;')).toEqual([]);
  // dialog.tsx and stage-confirm-dialog.tsx have an async `confirm` of their own.
  expect(await lint('async function confirm() {}\nvoid confirm();')).toEqual([]);
});
