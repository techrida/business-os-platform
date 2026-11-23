import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { expect, it } from 'vitest';

// UIP-BUILD-002: the lint rule that keeps the browser's own `title` hover bubble out of the apps.
// It runs the real rule (tools/eslint/native-title-rule.mjs, also used by eslint.config.mjs) on the
// shapes that were in the app, and on the ones that must stay allowed.

const ruleModule = new URL('../../../../../tools/eslint/native-title-rule.mjs', import.meta.url)
  .href;

async function lint(code: string) {
  const { RESTRICTED_SYNTAX } = (await import(/* @vite-ignore */ ruleModule)) as {
    RESTRICTED_SYNTAX: Linter.RuleEntry;
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
        rules: { 'no-restricted-syntax': RESTRICTED_SYNTAX },
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
  // Both spread their props onto a DOM element (opportunities/[id]/page.tsx had a Badge title).
  expect(await lint('const a = <Badge tone="warning" title="Hold">x</Badge>;')).toHaveLength(1);
  expect(await lint('const a = <LinkButton href="/" title="Go">x</LinkButton>;')).toHaveLength(1);
});

it('names the Tooltip component in the error', async () => {
  const [message] = await lint('const a = <span title="x" />;');
  expect(message).toContain('<Tooltip content=');
});

it('allows iframe and svg titles, and a title prop on our own components', async () => {
  expect(await lint('const a = <iframe title="Document preview" src="/x" />;')).toEqual([]);
  expect(await lint('const a = <svg title="Chart"><title>Chart</title></svg>;')).toEqual([]);
  expect(await lint('const a = <Page title="Leads" />;')).toEqual([]);
  // `title` is the validation message on an input and the expansion on an abbr, not a hover hint.
  expect(await lint('const a = <input pattern="[0-9]+" title="Digits only" />;')).toEqual([]);
  expect(await lint('const a = <abbr title="Value added tax">VAT</abbr>;')).toEqual([]);
  expect(await lint('const a = <Tooltip content="x"><button type="button" /></Tooltip>;')).toEqual(
    [],
  );
});

it('UIP-FORM-011: blocks a caption in an actions slot and a blocked button wired to a caption', async () => {
  // A <p> inside the page header's actions prop.
  expect(
    await lint('const a = <Page actions={<><p>Why not</p><Button>Go</Button></>} />;'),
  ).toHaveLength(1);
  // The old shape: aria-disabled + aria-describedby pointing at text under the button.
  expect(
    await lint(
      'const a = <div><Button aria-disabled="true" aria-describedby={id}>Go</Button><p id={id}>Why</p></div>;',
    ),
  ).toHaveLength(1);
  // The new shape, and an ordinary header, are fine.
  expect(
    await lint(
      'const a = <Tooltip content="Why"><Button aria-disabled="true">Go</Button></Tooltip>;',
    ),
  ).toEqual([]);
  expect(await lint('const a = <Page actions={<Button>Go</Button>} />;')).toEqual([]);
});
