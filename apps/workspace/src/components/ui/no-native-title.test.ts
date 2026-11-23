import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { expect, it } from 'vitest';

// UIP-BUILD-002: the lint rule that keeps the browser's own `title` hover bubble out of the apps.
// It runs the real rule (tools/eslint/native-title-rule.mjs, also used by eslint.config.mjs) on the
// shapes that were in the app, and on the ones that must stay allowed.

const ruleModule = new URL('../../../../../tools/eslint/native-title-rule.mjs', import.meta.url)
  .href;

async function lint(code: string) {
  const { NATIVE_TITLE_RULE } = (await import(/* @vite-ignore */ ruleModule)) as {
    NATIVE_TITLE_RULE: Linter.RuleEntry;
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
        },
        rules: { 'no-restricted-syntax': NATIVE_TITLE_RULE },
      },
    ],
    'sample.tsx',
  );
  return messages.map((m) => m.message);
}

it('blocks the old sites: title on a DOM element, a multi-line button, and Button / Link', async () => {
  // header.tsx before the fix
  expect(
    await lint('const a = <p className="roles" title={rolesText}>{rolesText}</p>;'),
  ).toHaveLength(1);
  // memo-form.tsx before the fix (multi-line JSX)
  expect(
    await lint(`const a = (
      <button
        type="button"
        aria-label="Print preview"
        title="Print preview"
      />
    );`),
  ).toHaveLength(1);
  // picture-editor.tsx before the fix: Button forwards title to the DOM
  expect(
    await lint('const a = <Button aria-label="x" title="Change picture">x</Button>;'),
  ).toHaveLength(1);
  expect(await lint('const a = <Link href="/" title="Home">Home</Link>;')).toHaveLength(1);
});

it('names the Tooltip component in the error', async () => {
  const [message] = await lint('const a = <span title="x" />;');
  expect(message).toContain('<Tooltip content=');
});

it('allows iframe and svg titles, and a title prop on our own components', async () => {
  expect(await lint('const a = <iframe title="Document preview" src="/x" />;')).toEqual([]);
  expect(await lint('const a = <svg title="Chart"><title>Chart</title></svg>;')).toEqual([]);
  expect(await lint('const a = <Page title="Leads" />;')).toEqual([]);
  expect(await lint('const a = <Tooltip content="x"><button type="button" /></Tooltip>;')).toEqual(
    [],
  );
});
