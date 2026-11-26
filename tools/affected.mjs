#!/usr/bin/env node
// Change detection for CI and QA: which areas does a diff touch? (Kuu 2026-11-24: run only what a PR affects.)
//
//   node tools/affected.mjs --base <sha> --head <sha> [--event pull_request] [--github-output]
//   node tools/affected.mjs --files a,b,c            (test helper: skip git)
//
// A changed workspace package marks itself and every package that depends on it (the pnpm
// `--filter "...[base]"` rule), read straight from the package.json files, so no install is needed.
// Fail safe: a shared root, a gate script, infrastructure, @bos/contracts, @bos/db, or any path this script cannot
// place, runs everything. Events other than pull_request (push, schedule, workflow_dispatch) always run everything.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Workspace packages (pnpm-workspace.yaml: apps/*, packages/*, tools/*) with their @bos dependencies.
export function loadWorkspace(root = REPO_ROOT) {
  const packages = [];
  for (const parent of ['apps', 'packages', 'tools']) {
    const parentDir = join(root, parent);
    if (!existsSync(parentDir)) continue;
    for (const entry of readdirSync(parentDir, { withFileTypes: true })) {
      const manifest = join(parentDir, entry.name, 'package.json');
      if (!entry.isDirectory() || !existsSync(manifest)) continue;
      const json = JSON.parse(readFileSync(manifest, 'utf8'));
      packages.push({
        name: json.name,
        dir: `${parent}/${entry.name}`,
        deps: Object.keys({
          ...json.dependencies,
          ...json.devDependencies,
          ...json.peerDependencies,
          ...json.optionalDependencies,
        }),
      });
    }
  }
  const names = new Set(packages.map((p) => p.name));
  return packages.map((p) => ({ ...p, deps: p.deps.filter((d) => names.has(d)) }));
}

// Whole-repo, no package owner: these decide how every package is built, checked or shipped.
const FULL_PREFIXES = ['.github/', 'infra/', 'tools/', 'perf/'];
const FULL_FILES = new Set([
  'pnpm-lock.yaml',
  'package.json',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  'eslint.config.mjs',
  '.prettierrc.json',
  '.prettierignore',
  '.editorconfig',
  '.nvmrc',
  '.gitleaks.toml',
  '.gitattributes',
  '.dockerignore',
  '.env.example',
]);
// A change here can reach every package that depends on it, and both apps serve the same API and database.
const FULL_PACKAGES = new Set(['@bos/contracts', '@bos/db']);

const DOC_FILE = /\.(md|mdx)$/i;
const DOC_PREFIXES = ['docs/'];
const DOC_FILES = new Set(['LICENSE', 'CODEOWNERS']);

function isDoc(file) {
  return DOC_FILES.has(file) || DOC_FILE.test(file) || DOC_PREFIXES.some((p) => file.startsWith(p));
}

function ownerOf(file, packages) {
  return packages
    .filter((p) => file.startsWith(`${p.dir}/`))
    .sort((a, b) => b.dir.length - a.dir.length)[0];
}

// Every package that changed, plus everything that depends on one, transitively.
export function withDependents(changed, packages) {
  const out = new Set(changed);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of packages) {
      if (!out.has(p.name) && p.deps.some((d) => out.has(d))) {
        out.add(p.name);
        grew = true;
      }
    }
  }
  return out;
}

const ALL = {
  full: true,
  api: true,
  workspace: true,
  portal: true,
  db: true,
  docker: true,
  'docker-api': true,
  'docker-workspace': true,
  'docker-portal': true,
  'docker-login': true,
  web: true,
  'qa-workspace': true,
  'qa-portal': true,
  'docs-only': false,
};

export function affected(files, packages, { event = 'pull_request' } = {}) {
  const everything = (reason, packageNames = packages.map((p) => p.name)) => ({
    ...ALL,
    reason,
    packages: packageNames,
  });
  if (event !== 'pull_request') return everything(`${event} runs everything`);
  const changedFiles = files.map((f) => f.trim()).filter(Boolean);
  if (changedFiles.length === 0) return everything('no changed files found (fail safe)');

  const changedPackages = new Set();
  for (const file of changedFiles) {
    // Shared roots first: a .txt or .md under .github/ or infra/ is still a gate input.
    if (FULL_FILES.has(file) || FULL_PREFIXES.some((p) => file.startsWith(p)))
      return everything(`${file} is a shared root`);
    if (isDoc(file)) continue;
    const owner = ownerOf(file, packages);
    if (!owner) return everything(`${file} is not mapped to any area (fail safe)`);
    if (FULL_PACKAGES.has(owner.name)) return everything(`${owner.name} changed`);
    changedPackages.add(owner.name);
  }

  if (changedPackages.size === 0) {
    return {
      ...Object.fromEntries(Object.keys(ALL).map((k) => [k, false])),
      'docs-only': true,
      reason: 'docs only',
      packages: [],
    };
  }
  const set = withDependents(changedPackages, packages);
  const api = set.has('@bos/api');
  const workspace = set.has('@bos/workspace');
  const portal = set.has('@bos/portal');
  const db = set.has('@bos/db');
  return {
    full: false,
    api,
    workspace,
    portal,
    db,
    web: workspace || portal,
    docker: api || workspace || portal,
    // One flag per production image, so an app-only change does not rebuild the others. The login image is built from
    // infra/, which is a shared root: only a run of everything rebuilds it.
    'docker-api': api,
    'docker-workspace': workspace,
    'docker-portal': portal,
    'docker-login': false,
    // Both apps talk to the API, so an API change needs both browser suites; an app change needs its own.
    'qa-workspace': workspace || api,
    'qa-portal': portal || api,
    'docs-only': false,
    reason: `changed: ${[...changedPackages].join(', ')}`,
    packages: packages.map((p) => p.name).filter((n) => set.has(n)),
  };
}

// The Playwright matrix for qa.yml. `ws` says whether the job also runs the workspace specs; `list` names the file list
// (.github/qa/<list>.txt) of its share of them; `portal` marks the one job that runs the portal specs: shard B, the
// lighter one (shard A holds 77 s more workspace test time, measured 2026-11-26). The non-blocking `quarantined` job is
// only added when .github/qa/quarantine.txt has content: with nothing quarantined it would bring up the whole stack just
// to print "Nothing is quarantined.".
export function qaMatrix(result, { quarantine = '' } = {}) {
  const include = [];
  if (result['qa-workspace']) {
    include.push(
      { mode: 'specs', id: '1', shard: '1/2', list: 'shard-a', ws: true, portal: false },
      { mode: 'specs', id: '2', shard: '2/2', list: 'shard-b', ws: true, portal: true },
    );
    if (quarantine.trim() !== '')
      include.push({ mode: 'quarantined', id: '-', shard: '1/1', ws: true, portal: false });
  } else if (result['qa-portal']) {
    include.push({
      mode: 'specs',
      id: '2',
      shard: '2/2',
      list: 'shard-b',
      ws: false,
      portal: true,
    });
  }
  return { include };
}

function readQuarantine() {
  const file = join(REPO_ROOT, '.github/qa/quarantine.txt');
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

function git(...args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
}

function parseArgs(argv) {
  const out = { event: process.env.GITHUB_EVENT_NAME || 'pull_request' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--github-output') out.githubOutput = true;
    else if (a === '--base') out.base = argv[++i];
    else if (a === '--head') out.head = argv[++i];
    else if (a === '--event') out.event = argv[++i];
    else if (a === '--files') out.files = argv[++i].split(',');
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const packages = loadWorkspace();
  let files = args.files;
  let event = args.event;
  if (!files) {
    try {
      if (!args.base) throw new Error('no --base');
      files = git(
        'diff',
        '--name-only',
        '--no-renames',
        `${args.base}...${args.head || 'HEAD'}`,
      ).split('\n');
    } catch (error) {
      console.error(`affected: cannot diff (${error.message}); running everything`);
      files = [];
      event = 'pull_request';
    }
  }
  const result = affected(files, packages, { event });
  const matrix = qaMatrix(result, { quarantine: readQuarantine() });
  const lines = {
    ...Object.fromEntries(
      Object.entries(result)
        .filter(([k]) => k !== 'packages' && k !== 'reason')
        .map(([k, v]) => [k, String(v)]),
    ),
    'qa-matrix': JSON.stringify(matrix),
    packages: result.packages.join(' '),
  };
  console.log(`affected: ${result.reason}`);
  for (const [k, v] of Object.entries(lines)) console.log(`${k}=${v}`);
  if (args.githubOutput && process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `${Object.entries(lines)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n')}\n`,
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
