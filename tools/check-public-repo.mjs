#!/usr/bin/env node
// Checks that the tracked files are fit for a public repository: no internal working files, no private
// paths, hostnames or agent names in the text, and the AGPL-3.0-only license on every package.
//   node tools/check-public-repo.mjs
// The git pre-push hook (.githooks/pre-push) runs it as `--pre-push <remote> <url>` with the ref updates on
// stdin: it checks the tree of every pushed tip and every file the new commits add or change.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const FORBIDDEN_FILES = [
  /(^|\/)AGENTS\.md$/,
  /(^|\/)CLAUDE\.md$/,
  /^tools\/manual-run\//,
  /^\.dev\//,
];

// Built from pieces so this file does not match its own patterns.
const p = (...parts) => new RegExp(parts.join(''));
export const FORBIDDEN_TEXT = [
  ['a home-folder path', p('/home/', '[a-z][a-z0-9_-]*/')],
  ['a private runtime folder', p('bos-', 'runtimes')],
  ['a private network host', p('\\.ts', '\\.net\\b')],
  ['a private network name', p('tail', '[0-9a-f]{6}')],
  ['an agent session path', p('\\.t3/', 'worktrees')],
];

const isScanned = (f) =>
  f !== 'pnpm-lock.yaml' && !/\.(woff2?|png|jpe?g|gif|ico|pdf|webp)$/i.test(f);

export function findProblems(files, read) {
  const problems = [];
  for (const f of files) {
    if (FORBIDDEN_FILES.some((re) => re.test(f))) problems.push(`${f}: internal file is tracked`);
  }
  for (const f of files) {
    if (!isScanned(f)) continue;
    const text = read(f);
    if (text === null) continue;
    for (const [label, re] of FORBIDDEN_TEXT) {
      if (re.test(text)) problems.push(`${f}: contains ${label}`);
    }
    if (/(^|\/)package\.json$/.test(f)) {
      const license = JSON.parse(text).license;
      if (license !== 'AGPL-3.0-only') problems.push(`${f}: license is ${JSON.stringify(license)}`);
    }
  }
  return problems;
}

const gitIn = (cwd) => (args, input) =>
  execFileSync('git', args, { cwd, input, maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'pipe'] });

const ZERO_SHA = /^0+$/;

// `git cat-file --batch` for many blobs in one process: sha -> text.
function readBlobs(git, shas) {
  const texts = new Map();
  if (shas.length === 0) return texts;
  const out = git(['cat-file', '--batch'], `${shas.join('\n')}\n`);
  for (let pos = 0; pos < out.length;) {
    const nl = out.indexOf(10, pos);
    const [sha, type, size] = out.toString('latin1', pos, nl).split(' ');
    if (type === 'missing') {
      pos = nl + 1;
      continue;
    }
    texts.set(sha, out.toString('utf8', nl + 1, nl + 1 + Number(size)));
    pos = nl + 1 + Number(size) + 1;
  }
  return texts;
}

// Every file of `tip`'s tree: { file, blob }.
function treeEntries(git, tip) {
  return git(['ls-tree', '-r', '-z', tip])
    .toString()
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t');
      const [, type, blob] = line.slice(0, tab).split(' ');
      return { type, blob, file: line.slice(tab + 1) };
    })
    .filter((e) => e.type === 'blob')
    .map(({ blob, file }) => ({ file, blob }));
}

// Files the commits in `tip --not <known>` add or change: { file, blob, commit }. Merge commits add nothing
// of their own; their result is in the tip's tree.
function newCommitEntries(git, tip, knownRemoteSha) {
  const known =
    knownRemoteSha && !ZERO_SHA.test(knownRemoteSha) && commitExists(git, knownRemoteSha)
      ? [knownRemoteSha]
      : ['--remotes'];
  const out = git([
    'log',
    tip,
    '--not',
    ...known,
    '--no-merges',
    '--format=%x01%h',
    '--raw',
    '-z',
    '--no-renames',
    '--diff-filter=AM',
    '--no-abbrev',
  ]).toString();
  const entries = [];
  let commit = '';
  const tokens = out.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i].replace(/^\n/, '');
    if (token.startsWith('\x01')) commit = token.slice(1);
    else if (token.startsWith(':')) {
      entries.push({ file: tokens[i + 1], blob: token.split(' ')[3], commit });
      i++;
    }
  }
  return entries;
}

function commitExists(git, sha) {
  try {
    git(['cat-file', '-e', `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

// `updates` are the lines git feeds a pre-push hook: "<local ref> <local sha> <remote ref> <remote sha>".
export function checkPush(updates, git) {
  const problems = [];
  const entries = new Map();
  for (const line of updates) {
    const [, localSha, , remoteSha] = line.trim().split(/\s+/);
    if (!localSha || ZERO_SHA.test(localSha)) continue; // deleting a ref pushes no content
    for (const e of treeEntries(git, localSha)) entries.set(`${e.file}\0${e.blob}`, e);
    for (const e of newCommitEntries(git, localSha, remoteSha)) {
      const key = `${e.file}\0${e.blob}`;
      if (!entries.has(key)) entries.set(key, e);
    }
  }
  const all = [...entries.values()];
  const texts = readBlobs(git, [
    ...new Set(all.filter((e) => isScanned(e.file)).map((e) => e.blob)),
  ]);
  const seen = new Set();
  for (const e of all) {
    const text = texts.get(e.blob) ?? null;
    for (const problem of findProblems([e.file], () => text)) {
      const message = e.commit ? `${problem} (added in commit ${e.commit})` : problem;
      if (!seen.has(message)) {
        seen.add(message);
        problems.push(message);
      }
    }
  }
  return problems;
}

const read = (f) => {
  try {
    return readFileSync(path.join(root, f), 'utf8');
  } catch {
    return null;
  }
};

function report(problems) {
  console.error(problems.join('\n'));
  console.error(`\npublic-repo check: ${problems.length} problem(s)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.argv[2] === '--pre-push') {
    const git = gitIn(process.cwd());
    const updates = readFileSync(0, 'utf8')
      .split('\n')
      .filter((l) => l.trim());
    const problems = checkPush(updates, git);
    if (problems.length > 0) {
      report(problems);
      console.error(
        'push refused. Remove the files or text above (amend or rewrite the commits that added them), then push again.',
      );
      process.exit(1);
    }
    process.exit(0);
  }
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 1 << 28 })
    .toString()
    .split('\0')
    .filter(Boolean);
  const problems = findProblems(tracked, read);
  if (problems.length > 0) {
    report(problems);
    process.exit(1);
  }
  console.log(`public-repo check: ok (${tracked.length} tracked files)`);
}
