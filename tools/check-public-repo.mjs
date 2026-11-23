#!/usr/bin/env node
// Checks that the tracked files are fit for a public repository: no internal working files, no private
// paths, hostnames or agent names in the text, and the AGPL-3.0-only license on every package.
//   node tools/check-public-repo.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 1 << 28 })
  .toString()
  .split('\0')
  .filter(Boolean);

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

export function findProblems(files, read) {
  const problems = [];
  for (const f of files) {
    if (FORBIDDEN_FILES.some((re) => re.test(f))) problems.push(`${f}: internal file is tracked`);
  }
  for (const f of files) {
    if (f === 'pnpm-lock.yaml' || /\.(woff2?|png|jpe?g|gif|ico|pdf|webp)$/i.test(f)) continue;
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

const read = (f) => {
  try {
    return readFileSync(path.join(root, f), 'utf8');
  } catch {
    return null;
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const problems = findProblems(tracked, read);
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    console.error(`\npublic-repo check: ${problems.length} problem(s)`);
    process.exit(1);
  }
  console.log(`public-repo check: ok (${tracked.length} tracked files)`);
}
