import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

// The checker is run as a command by CI and by the lead, so the tests run it as a command too
// (a child `node`) and read its exit code. Importing it would skip the argv and cwd handling.
const SCRIPT = fileURLToPath(new URL('./check-no-dev-routes.mjs', import.meta.url));
const MARKER = 'BOS_DEV_PERSONA_SWITCHER';
const DEV_MENU_MARKER = 'BOS_DEV_MENU';

/**
 * The manifest of a real `next build` of this app (Next 16.4.5, Turbopack), copied from
 * `.next/server/app-paths-manifest.json`. Keeping the real shape matters: route keys carry
 * `(group)` segments and a trailing `/page` or `/route`, and values are file paths.
 */
const REAL_BUILD_MANIFEST: Record<string, string> = {
  '/(app)/page': 'app/(app)/page.js',
  '/_global-error/page': 'app/_global-error/page.js',
  '/_not-found/page': 'app/_not-found/page.js',
  '/auth/callback/route': 'app/auth/callback/route.js',
  '/auth/error/page': 'app/auth/error/page.js',
  '/auth/login/route': 'app/auth/login/route.js',
  '/auth/logout/route': 'app/auth/logout/route.js',
  '/healthz/route': 'app/healthz/route.js',
  '/staff-only/page': 'app/staff-only/page.js',
  '/telemetry/vitals/route': 'app/telemetry/vitals/route.js',
};

interface Result {
  status: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], options: { cwd?: string; script?: string } = {}): Result {
  try {
    const stdout = execFileSync(process.execPath, [options.script ?? SCRIPT, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(options.cwd !== undefined && { cwd: options.cwd }),
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failed = error as { status: number | null; stdout: string; stderr: string };
    return { status: failed.status ?? -1, stdout: failed.stdout, stderr: failed.stderr };
  }
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'bos-no-dev-routes-'));
  roots.push(root);
  return root;
}

function write(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** A finished-build-shaped `.next` directory. Extra files are relative paths with their content. */
function fixtureBuild(
  options: {
    manifest?: Record<string, string>;
    files?: Record<string, string>;
    root?: string;
  } = {},
): string {
  const nextDir = path.join(options.root ?? tempRoot(), '.next');
  write(
    path.join(nextDir, 'server', 'app-paths-manifest.json'),
    JSON.stringify(options.manifest ?? REAL_BUILD_MANIFEST),
  );
  write(
    path.join(nextDir, 'server', 'app', 'staff-only', 'page.js'),
    'export default function(){}',
  );
  write(path.join(nextDir, 'static', 'chunks', 'main.js'), 'console.log("hi")');
  for (const [file, content] of Object.entries(options.files ?? {})) {
    write(path.join(nextDir, file), content);
  }
  return nextDir;
}

describe('check-no-dev-routes', () => {
  it('passes on a build shaped like the real one', () => {
    const result = run([fixtureBuild()]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('OK');
  });

  it('fails when the manifest has a /dev route, even without the marker', () => {
    const nextDir = fixtureBuild({
      manifest: { ...REAL_BUILD_MANIFEST, '/dev/personas/page': 'app/dev/personas/page.js' },
    });
    const result = run([nextDir]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('/dev/personas/page');
  });

  it('fails on a /dev route hidden inside a route group', () => {
    const nextDir = fixtureBuild({
      manifest: { ...REAL_BUILD_MANIFEST, '/(internal)/dev/personas/page': 'app/x.js' },
    });
    expect(run([nextDir]).status).toBe(1);
  });

  it('fails when the marker is in a server chunk, even with no dev route in the manifest', () => {
    // The case where the route table is clean but the component was still bundled.
    const nextDir = fixtureBuild({
      files: { 'server/chunks/ssr/page.js': `h("main",{"data-marker":"${MARKER}"})` },
    });
    const result = run([nextDir]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(MARKER);
    expect(result.stderr).toContain(path.join('server', 'chunks', 'ssr', 'page.js'));
  });

  it('fails when the marker is in a client static chunk', () => {
    const nextDir = fixtureBuild({ files: { 'static/chunks/abc.js': `x="${MARKER}"` } });
    expect(run([nextDir]).status).toBe(1);
  });

  it('fails when the marker is in the standalone output the Docker image copies', () => {
    const nextDir = fixtureBuild({
      files: { 'standalone/apps/workspace/.next/server/app/dev/personas/page.js': MARKER },
    });
    expect(run([nextDir]).status).toBe(1);
  });

  it('fails when the DEV MENU marker is in a client static chunk', () => {
    const nextDir = fixtureBuild({
      files: { 'static/chunks/dev-menu.js': `h("div",{"data-marker":"${DEV_MENU_MARKER}"})` },
    });
    const result = run([nextDir]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(DEV_MENU_MARKER);
    expect(result.stderr).toContain(path.join('static', 'chunks', 'dev-menu.js'));
  });

  it('fails when the DEV MENU marker is in the standalone output', () => {
    const nextDir = fixtureBuild({
      files: { 'standalone/apps/workspace/.next/server/chunks/a.js': DEV_MENU_MARKER },
    });
    expect(run([nextDir]).status).toBe(1);
  });

  it('ignores the DEV MENU marker under .next/cache and .next/dev (not shipped)', () => {
    const nextDir = fixtureBuild({
      files: { 'cache/a.js': DEV_MENU_MARKER, 'dev/static/chunks/a.js': DEV_MENU_MARKER },
    });
    expect(run([nextDir]).status).toBe(0);
  });

  it('fails when the manifest has the /dev/api/whoami route, even without a marker', () => {
    const nextDir = fixtureBuild({
      manifest: { ...REAL_BUILD_MANIFEST, '/dev/api/whoami/route': 'app/dev/api/whoami/route.js' },
    });
    const result = run([nextDir]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('/dev/api/whoami/route');
  });

  it('reports every problem, not just the first', () => {
    const nextDir = fixtureBuild({
      manifest: { ...REAL_BUILD_MANIFEST, '/dev/personas/page': 'app/dev/personas/page.js' },
      files: { 'server/chunks/a.js': MARKER },
    });
    const result = run([nextDir]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('dev route');
    expect(result.stderr).toContain('marker');
  });

  it('ignores the marker under .next/cache and .next/dev (not shipped)', () => {
    const nextDir = fixtureBuild({
      files: {
        'cache/turbopack/old-dev-build.js': MARKER,
        'dev/server/app/dev/personas/page.js': MARKER,
      },
    });
    expect(run([nextDir]).status).toBe(0);
  });

  it('does not skip a directory named cache or dev below the top level', () => {
    const nextDir = fixtureBuild({ files: { 'server/chunks/cache/a.js': MARKER } });
    expect(run([nextDir]).status).toBe(1);
  });

  it('does not trip on routes that merely start with "dev"', () => {
    const nextDir = fixtureBuild({
      manifest: {
        ...REAL_BUILD_MANIFEST,
        '/devices/page': 'app/devices/page.js',
        '/api/dev/page': 'app/api/dev/page.js',
      },
    });
    expect(run([nextDir]).status).toBe(0);
  });

  describe('fails closed when it cannot inspect a build (exit 2, never 0)', () => {
    it('no build directory', () => {
      const result = run([path.join(tempRoot(), 'missing', '.next')]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('next build');
    });

    it('a directory without the app paths manifest (a half-finished build)', () => {
      const nextDir = path.join(tempRoot(), '.next');
      write(path.join(nextDir, 'static', 'a.js'), 'x');
      expect(run([nextDir]).status).toBe(2);
    });

    it('a corrupt manifest', () => {
      const nextDir = fixtureBuild();
      write(path.join(nextDir, 'server', 'app-paths-manifest.json'), '{not json');
      expect(run([nextDir]).status).toBe(2);
    });
  });

  it('finds the build next to the script when no argument is given, whatever the cwd', () => {
    // Mirrors apps/workspace/{scripts,.next}. CI runs the checker from the repository root.
    const app = tempRoot();
    const copy = path.join(app, 'scripts', 'check-no-dev-routes.mjs');
    mkdirSync(path.dirname(copy), { recursive: true });
    copyFileSync(SCRIPT, copy);
    fixtureBuild({ root: app, files: { 'server/chunks/a.js': MARKER } });

    const elsewhere = tempRoot();
    const dirty = run([], { cwd: elsewhere, script: copy });
    expect(dirty.status).toBe(1);

    write(path.join(app, '.next', 'server', 'chunks', 'a.js'), 'clean');
    const clean = run([], { cwd: elsewhere, script: copy });
    expect(clean.status).toBe(0);
  });
});
