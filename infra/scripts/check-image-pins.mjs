#!/usr/bin/env node
// Supply-chain gate: every third-party container image must be pinned by digest.
//
//   node infra/scripts/check-image-pins.mjs [repoRoot]
//
// A tag such as `caddy:2.11-alpine` can be moved by whoever owns the registry account; a digest
// (`caddy:2.11-alpine@sha256:<64 hex>`) cannot. Checked:
//   - every `image:` line in infra/compose/*.yaml and *.yml
//   - every `FROM` line in every Dockerfile / Dockerfile.* in the repo
//   - the image of every `docker run` in infra/scripts/*.sh, infra/backup/*.sh and perf/k6/*.sh (a command wrapped
//     with `\` continuations counts as one command; comment lines are skipped)
// Allowed without a digest:
//   - `bos/*` images in compose and in `docker run`: built from this repo
//   - `FROM scratch`
//   - `FROM <earlier stage name>` in the same Dockerfile (multi-stage builds)
// `FROM ${ARG}` is resolved from the ARG's default before the first FROM; an ARG with no default
// is an error, because the pin could then be supplied (or forgotten) at build time. A `docker run`
// image given as a shell variable (`$IMG`) is an error too: the checker cannot see its value.
//
// No dependencies. Exit 0 = all pinned, 1 = at least one unpinned, 2 = nothing to check
// (a gate that finds no files is broken, not green).
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const DIGEST = /@sha256:[0-9a-f]{64}$/;
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', '.dev', '.turbo', 'coverage']);
const LOCAL_PREFIX = 'bos/';

/** @returns {string[]} problems found in one compose file's text */
function checkCompose(text, label) {
  const problems = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const m = /^\s*image:\s*(.*?)\s*$/.exec(line);
    if (!m) return;
    // Drop a trailing comment and optional quotes: `image: "x:1" # note`.
    const ref = m[1]
      .replace(/\s+#.*$/, '')
      .replace(/^(["'])(.*)\1$/, '$2')
      .trim();
    if (ref.startsWith(LOCAL_PREFIX)) return;
    if (!DIGEST.test(ref)) problems.push(`${label}:${i + 1}: image "${ref}" has no @sha256 digest`);
  });
  return problems;
}

// `docker run` options that take a separate value, so the next word is not the image.
const RUN_OPTS_WITH_VALUE = new Set(
  (
    '-a -c -e -h -l -m -p -u -v -w --add-host --annotation --attach --cap-add --cap-drop --cgroup-parent ' +
    '--cpus --cpuset-cpus --device --dns --entrypoint --env --env-file --expose --gpus --group-add ' +
    '--hostname --ip --ipc --label --label-file --log-driver --log-opt --mac-address --memory --mount ' +
    '--name --network --net --pid --platform --publish --pull --restart --runtime --security-opt ' +
    '--shm-size --stop-signal --stop-timeout --tmpfs --ulimit --user --userns --uts --volume --workdir'
  ).split(' '),
);

/** Split a shell command line into words, honouring '…' and "…" quoting (no expansion). */
function shellWords(line) {
  return (line.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []).map((w) =>
    w.replace(/^(["'])(.*)\1$/, '$2'),
  );
}

/** @returns {{problems: string[], images: number}} for one shell script's `docker run` commands */
function checkShell(text, label) {
  const problems = [];
  let images = 0;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const start = i;
    let cmd = lines[i];
    // Join `\` continuations; the reported line is the one where the command starts.
    while (/\\s*$/.test(cmd) && i + 1 < lines.length) {
      i += 1;
      cmd = cmd.replace(/\\s*$/, ' ') + lines[i];
    }
    if (/^\s*#/.test(cmd)) continue;
    const m = /(?:^|[\s;&|(`]|\$\()docker\s+run\s(.*)$/.exec(cmd);
    if (!m) continue;
    const words = shellWords(m[1]);
    let j = 0;
    while (j < words.length && words[j].startsWith('-')) {
      // `--opt=value` and boolean flags are one word; `--opt value` consumes the next word.
      j += !words[j].includes('=') && RUN_OPTS_WITH_VALUE.has(words[j]) ? 2 : 1;
    }
    const at = `${label}:${start + 1}`;
    const ref = words[j];
    images += 1;
    if (ref === undefined) problems.push(`${at}: docker run has no image argument`);
    else if (ref.includes('$'))
      problems.push(`${at}: docker run image "${ref}" is a variable, so the pin is unchecked`);
    else if (!ref.startsWith(LOCAL_PREFIX) && !DIGEST.test(ref))
      problems.push(`${at}: docker run image "${ref}" has no @sha256 digest`);
  }
  return { problems, images };
}

/** @returns {string[]} problems found in one Dockerfile's text */
function checkDockerfile(text, label) {
  const problems = [];
  const args = new Map();
  const stages = new Set();
  let seenFrom = false;
  // Join `\` line continuations so a wrapped FROM is still one instruction.
  const lines = text.replace(/\\\r?\n/g, ' ').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    const arg = /^ARG\s+([A-Za-z_][A-Za-z0-9_]*)(?:=(.*))?$/i.exec(line);
    if (arg && !seenFrom) {
      if (arg[2] !== undefined) args.set(arg[1], arg[2].replace(/^(["'])(.*)\1$/, '$2'));
      return;
    }
    const from = /^FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?\s*$/i.exec(line);
    if (!from) return;
    seenFrom = true;
    let ref = from[1];
    const stage = from[2];
    const at = `${label}:${i + 1}`;
    const unresolved = [];
    ref = ref.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, a, b) => {
      const name = a ?? b;
      if (!args.has(name)) unresolved.push(name);
      return args.get(name) ?? '';
    });
    if (unresolved.length > 0) {
      problems.push(
        `${at}: FROM uses ARG ${unresolved.join(', ')} with no default, so the pin is unchecked`,
      );
    } else if (ref.toLowerCase() === 'scratch' || stages.has(ref.toLowerCase())) {
      // Nothing to pin: an empty image or an earlier stage of this file.
    } else if (!DIGEST.test(ref)) {
      problems.push(`${at}: FROM "${ref}" has no @sha256 digest`);
    }
    if (stage) stages.add(stage.toLowerCase());
  });
  return problems;
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(join(dir, entry.name));
    } else {
      yield join(dir, entry.name);
    }
  }
}

function main() {
  const root = resolve(process.argv[2] ?? '.');
  const rel = (p) => relative(root, p).replaceAll('\\', '/');
  const problems = [];
  let files = 0;
  let images = 0;
  for (const file of walk(root)) {
    const name = file.split(/[\\/]/).pop();
    const isDockerfile = name === 'Dockerfile' || name.startsWith('Dockerfile.');
    const isCompose = /^infra\/compose\/[^/]+\.ya?ml$/.test(rel(file));
    const isShell = /^(infra\/scripts|infra\/backup|perf\/k6)\/[^/]+\.sh$/.test(rel(file));
    if (!isDockerfile && !isCompose && !isShell) continue;
    const text = readFileSync(file, 'utf8');
    if (isShell) {
      // Most scripts never call `docker run`; they are scanned but not counted as "files checked".
      const r = checkShell(text, rel(file));
      if (r.images > 0) files += 1;
      images += r.images;
      problems.push(...r.problems);
      continue;
    }
    files += 1;
    images += (text.match(isDockerfile ? /^\s*FROM\s/gim : /^\s*image:/gm) ?? []).length;
    problems.push(
      ...(isDockerfile ? checkDockerfile(text, rel(file)) : checkCompose(text, rel(file))),
    );
  }
  if (files === 0) {
    console.error(`check-image-pins: no compose files or Dockerfiles found under ${root}`);
    process.exit(2);
  }
  if (problems.length > 0) {
    console.error(`check-image-pins: ${problems.length} unpinned image reference(s):`);
    for (const p of problems) console.error(`  ${p}`);
    console.error(
      'Pin with: docker buildx imagetools inspect <name:tag>  (use the top-level "Digest:").',
    );
    process.exit(1);
  }
  console.log(
    `check-image-pins: ok (${images} image references in ${files} files, all pinned or built here)`,
  );
}

main();
