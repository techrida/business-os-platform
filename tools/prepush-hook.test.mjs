// Run: node --test tools/prepush-hook.test.mjs
// Runs the real .githooks/pre-push through `git push` from a throwaway repository to a bare remote.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const hooks = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.githooks');
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));

let dir;
let work;
const git = (args, cwd = work) =>
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    env,
    encoding: 'utf8',
  });
const must = (args, cwd = work) => {
  const r = git(args, cwd);
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r;
};
const commitFile = (file, text) => {
  mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
  writeFileSync(path.join(work, file), text);
  must(['add', '-A']);
  must(['commit', '-m', `change ${file}`]);
};
const push = (...refspecs) => git(['push', 'origin', ...refspecs]);

before(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'prepush-'));
  const remote = path.join(dir, 'remote.git');
  work = path.join(dir, 'work');
  execFileSync('git', ['init', '--bare', '-q', remote], { env });
  execFileSync('git', ['init', '-q', '-b', 'main', work], { env });
  must(['remote', 'add', 'origin', remote]);
  must(['config', 'core.hooksPath', hooks]);
  commitFile('README.md', 'hello\n');
});

after(() => rmSync(dir, { recursive: true, force: true }));

test('a clean push is allowed', () => {
  const r = push('main:refs/heads/main');
  assert.equal(r.status, 0, r.stderr);
});

test('a commit adding an AGENTS.md is refused with the check message', () => {
  commitFile('docs/AGENTS.md', 'notes\n');
  const r = push('main:refs/heads/main');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /docs\/AGENTS\.md: internal file is tracked/);
  assert.match(r.stderr, /push refused/);
});

test('an added file is refused even when a later commit removes it again', () => {
  must(['rm', '-q', 'docs/AGENTS.md']);
  must(['commit', '-q', '-m', 'remove it']);
  const r = push('main:refs/heads/main');
  assert.notEqual(r.status, 0);
  assert.match(
    r.stderr,
    /docs\/AGENTS\.md: internal file is tracked \(added in commit [0-9a-f]+\)/,
  );
  must(['reset', '-q', '--hard', 'origin/main']);
});

test('a commit adding a private network hostname is refused', () => {
  commitFile('notes.txt', ['see https://box.', 'tail', '1c04d9', '.ts', '.net/x\n'].join(''));
  const r = push('main:refs/heads/main');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /notes\.txt: contains a private network host/);
  must(['reset', '-q', '--hard', 'origin/main']);
});

test('a clean follow-up push is allowed after a refused one', () => {
  commitFile('src/a.ts', 'export const a = 1;\n');
  const r = push('main:refs/heads/main');
  assert.equal(r.status, 0, r.stderr);
});

test('a branch named *wip-t3-* is refused before any content is checked', () => {
  const r = push('main:refs/heads/kuu/wip-t3-scratch');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /refs\/heads\/kuu\/wip-t3-scratch: branches named \*wip-t3-\*/);
});

test('deleting a *wip-t3-* branch is not blocked', () => {
  const r = push('--delete', 'refs/heads/kuu/wip-t3-scratch');
  assert.ok(!/never pushed/.test(r.stderr), r.stderr);
});

const prepareCommand = JSON.parse(
  readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'),
    'utf8',
  ),
).scripts.prepare;
const runPrepare = (cwd) => spawnSync(prepareCommand, { cwd, env, encoding: 'utf8', shell: true });
const installer = fileURLToPath(new URL('./prepush-install.mjs', import.meta.url));
const withInstaller = (root) => {
  mkdirSync(path.join(root, 'tools'), { recursive: true });
  copyFileSync(installer, path.join(root, 'tools', 'prepush-install.mjs'));
  return root;
};

test('the prepare script installs the hooks path at a repository root', () => {
  const repo = withInstaller(path.join(dir, 'fresh'));
  execFileSync('git', ['init', '-q', repo], { env });
  const r = runPrepare(repo);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(must(['config', '--local', 'core.hooksPath'], repo).stdout.trim(), '.githooks');
  assert.equal(runPrepare(repo).status, 0);
});

test('the prepare script is a no-op outside a git work tree', () => {
  const plain = withInstaller(path.join(dir, 'tarball'));
  const r = runPrepare(plain);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout + r.stderr, '');
  assert.equal(existsSync(path.join(plain, '.git')), false);
});

test('the prepare script does not touch a repository it is only nested inside', () => {
  const before = must(['config', '--local', '--list']).stdout;
  assert.equal(runPrepare(withInstaller(path.join(work, 'sub'))).status, 0);
  assert.equal(must(['config', '--local', '--list']).stdout, before);
});

test('the prepare script never fails the install when tools/ is missing', () => {
  const bare = path.join(dir, 'docker');
  mkdirSync(bare);
  assert.equal(runPrepare(bare).status, 0);
});
