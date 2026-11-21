#!/usr/bin/env node
// Wall 3 against the dev-only layer (persona switcher, DEV MENU) leaking into a production build
// (risk R12).
//
// Run it after `next build`:   node apps/workspace/scripts/check-no-dev-routes.mjs [nextDir]
//
// It fails (exit 1) when the build output contains any of
//   1. a route under the `/dev` prefix (`/dev/personas`, `/dev/api/whoami`) in
//      `server/app-paths-manifest.json`,
//   2. the persona switcher's marker, BOS_DEV_PERSONA_SWITCHER, in any emitted file, or
//   3. the DEV MENU widget's marker, BOS_DEV_MENU, in any emitted file (the widget is client code,
//      so it shows up in `static/` chunks, not in the route table).
// The checks overlap on purpose. Wall 1 (`pageExtensions` in next.config.ts) should keep
// `page.dev.tsx` and `route.dev.ts` out of the route table. If it ever stops doing that, the route
// check catches the route. If someone renames the route but keeps the component, the marker
// checks still catch it.
//
// `--profile dev` checks the other direction, for a build made with BOS_BUILD_PROFILE=dev
// (output in `.next-devtools/`): it fails when the dev layer is MISSING, so a "dev build" that
// silently lost its dev menu cannot pass as one. Default is `--profile production`.
//
// Exit codes: 0 clean, 1 dev content found, 2 the build output could not be inspected. Exit 2 is
// "fail closed": a checker that cannot find a build must not read as a pass.
//
// Plain Node, no dependencies, so CI can run it without installing the workspace.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Rendered by apps/workspace/src/app/dev/personas/page.dev.tsx as data-marker. */
export const MARKER = 'BOS_DEV_PERSONA_SWITCHER';

/** Carried by the DEV MENU widget, which lives only in the dev layer. */
export const DEV_MENU_MARKER = 'BOS_DEV_MENU';

const MARKERS = [
  MARKER,
  DEV_MENU_MARKER,
  'BOS_DEV_ACCOUNT_SERVICE',
  'BOS_DEV_LOGIN_CLIENT_TOKEN_FILE',
];

/**
 * Directories directly under `.next/` that are not part of the shipped build:
 * - `cache`: the build cache (it can hold the previous build's modules, including a dev build's).
 * - `dev`: where Next 16 writes `next dev` output. A developer who ran `next dev` in the same
 *   checkout would otherwise fail the production check for a reason that does not ship.
 * Everything else is scanned, including `standalone/`, which is what the Docker image copies.
 */
const SKIPPED_TOP_LEVEL = new Set(['cache', 'dev']);

const APP_PATHS_MANIFEST = path.join('server', 'app-paths-manifest.json');

/**
 * Route segments that do not appear in the URL: `(group)` and the parallel-route slot `@slot`.
 * `/(internal)/dev/personas/page` is still served at `/dev/personas`, so groups must not hide it.
 */
const isInvisibleSegment = (segment) => /^\(.*\)$/.test(segment) || segment.startsWith('@');

/** True when a manifest key like `/(app)/dev/personas/page` is under the `/dev` URL prefix. */
export function isDevRoute(manifestKey) {
  const segments = manifestKey.split('/').filter((s) => s !== '' && !isInvisibleSegment(s));
  // A whole segment, not a substring: a future `/devices` route must not trip the check.
  return segments[0] === 'dev';
}

function* walk(dir, isTopLevel) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (isTopLevel && entry.isDirectory() && SKIPPED_TOP_LEVEL.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full, false);
    else if (entry.isFile()) yield full;
  }
}

/** Returns a list of human-readable problems. Throws if the build output cannot be inspected. */
export function findProblems(nextDir, profile = 'production') {
  if (!existsSync(nextDir) || !statSync(nextDir).isDirectory()) {
    throw new Error(`no build output at ${nextDir} (run \`next build\` first)`);
  }
  const manifestPath = path.join(nextDir, APP_PATHS_MANIFEST);
  if (!existsSync(manifestPath)) {
    throw new Error(`${manifestPath} is missing: not a finished \`next build\` output`);
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`${manifestPath} is not valid JSON: ${error.message}`);
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`${manifestPath} is not a JSON object`);
  }

  const problems = [];
  const wantDev = profile === 'dev';
  const devRoutes = Object.keys(manifest).filter(isDevRoute);
  if (!wantDev) {
    for (const route of devRoutes) problems.push(`dev route in ${APP_PATHS_MANIFEST}: ${route}`);
  } else if (!devRoutes.some((route) => route.includes('/dev/personas'))) {
    problems.push(`dev build is missing the /dev/personas route in ${APP_PATHS_MANIFEST}`);
  }

  const needles = MARKERS.map((marker) => [marker, Buffer.from(marker)]);
  const seen = new Set();
  for (const file of walk(nextDir, true)) {
    const content = readFileSync(file);
    for (const [marker, needle] of needles) {
      if (content.includes(needle)) {
        seen.add(marker);
        if (!wantDev) problems.push(`marker ${marker} found in ${path.relative(nextDir, file)}`);
      }
    }
  }
  if (wantDev) {
    for (const marker of [MARKER, DEV_MENU_MARKER]) {
      if (!seen.has(marker)) problems.push(`dev build is missing marker ${marker}`);
    }
  }
  return problems;
}

function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Default is relative to this file, not the working directory: CI and the lead run it from the
  // repository root, while `next build` writes to apps/workspace/.next.
  const args = process.argv.slice(2);
  const profileAt = args.indexOf('--profile');
  const profile = profileAt === -1 ? 'production' : args[profileAt + 1];
  if (profile !== 'dev' && profile !== 'production') {
    console.error('check-no-dev-routes: --profile must be "dev" or "production"');
    process.exit(2);
  }
  const positional = profileAt === -1 ? args : args.filter((_, i) => i !== profileAt && i !== profileAt + 1);
  const defaultDir = profile === 'dev' ? '.next-devtools' : '.next';
  const nextDir = path.resolve(positional[0] ?? path.join(here, '..', defaultDir));

  let problems;
  try {
    problems = findProblems(nextDir, profile);
  } catch (error) {
    console.error(`check-no-dev-routes: cannot check: ${error.message}`);
    process.exit(2);
  }

  if (problems.length > 0) {
    console.error(
      profile === 'dev'
        ? 'check-no-dev-routes: FAILED, the dev build lost its dev layer:'
        : 'check-no-dev-routes: FAILED, the build contains dev-only content:',
    );
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(
    profile === 'dev'
      ? `check-no-dev-routes: OK, the dev layer is present in ${nextDir}`
      : `check-no-dev-routes: OK, no dev routes or dev markers in ${nextDir}`,
  );
}

// Only run when executed directly, so the helpers can be imported without side effects.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
