import { dirname, resolve } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

// Walk resolved calls from each controller so a new lock in a service helper is covered too.
it('GET handlers only open unlocked transactions outside the first-use lost-reason bootstrap', () => {
  const configPath = resolve(import.meta.dirname, '../../../tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
  const controllers = parsed.fileNames.filter((file) => file.endsWith('.controller.ts'));
  const program = ts.createProgram(controllers, parsed.options);
  const checker = program.getTypeChecker();
  const visited = new Set<ts.Node>();
  const violations: string[] = [];
  const sourceRoot = ts.sys.resolvePath(resolve(dirname(configPath), 'src')) + '/';
  let routes = 0;

  function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
    visit(node);
    ts.forEachChild(node, (child) => walk(child, visit));
  }

  function follow(fn: ts.SignatureDeclaration): void {
    if (visited.has(fn) || !fn.getSourceFile().fileName.startsWith(sourceRoot)) return;
    visited.add(fn);
    if (!('body' in fn) || !fn.body) return;
    walk(fn.body, (node) => {
      if (!ts.isCallExpression(node)) return;
      const target = checker.getResolvedSignature(node)?.declaration;
      if (!ts.isFunctionLike(target)) return;
      if (
        target.name?.getText() !== 'withTx' ||
        !target.getSourceFile().fileName.endsWith('/db/tx.ts')
      ) {
        follow(target);
        return;
      }
      // A tenant created since migration 0072 needs a single audited write before its first list.
      if (
        fn.name?.getText() === 'bootstrapDefaults' &&
        fn.getSourceFile().fileName.endsWith('/leads/lost-reasons.service.ts')
      )
        return;
      const options = node.arguments[4];
      const readOnly =
        options?.getText() === 'READ_ONLY' ||
        (options &&
          ts.isObjectLiteralExpression(options) &&
          options.properties.some(
            (p) => ts.isSpreadAssignment(p) && p.expression.getText() === 'READ_ONLY',
          ) &&
          options.properties.every((p) =>
            ts.isSpreadAssignment(p)
              ? p.expression.getText() === 'READ_ONLY'
              : ts.isPropertyAssignment(p) && p.name.getText() === 'statementTimeoutMs',
          ));
      if (!readOnly) {
        const source = node.getSourceFile();
        violations.push(
          source.fileName + ':' + (source.getLineAndCharacterOfPosition(node.getStart()).line + 1),
        );
      }
    });
  }

  for (const file of program
    .getSourceFiles()
    .filter((s) => s.fileName.endsWith('.controller.ts'))) {
    walk(file, (node) => {
      if (
        ts.isMethodDeclaration(node) &&
        ts.getDecorators(node)?.some((d) => d.expression.getText().startsWith('Get('))
      ) {
        routes++;
        follow(node);
      }
    });
  }
  expect(routes).toBeGreaterThan(0);
  expect(violations).toEqual([]);
}, 60_000);
