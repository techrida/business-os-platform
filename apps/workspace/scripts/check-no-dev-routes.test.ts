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
 * Based on a real Next 16.4.5 build manifest, extended with the P3 billing routes.
 * Keeping the real shape matters: route keys carry
 * `(group)` segments and a trailing `/page` or `/route`, and values are file paths.
 */
const REAL_BUILD_MANIFEST: Record<string, string> = {
  '/(app)/page': 'app/(app)/page.js',
  '/(app)/invoices/[id]/page': 'app/(app)/invoices/[id]/page.js',
  '/(app)/payments/[id]/page': 'app/(app)/payments/[id]/page.js',
  '/(app)/receivables/aging/page': 'app/(app)/receivables/aging/page.js',
  '/(app)/sales-orders/[id]/page': 'app/(app)/sales-orders/[id]/page.js',
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
    // Spawns the checker on a fixture build: allow a loaded machine more than vitest's 5 s.
  }, 30_000);

  it('checks a dedicated portal build fixture and rejects a leaked portal dev menu', () => {
    const manifest = {
      '/(portal)/page': 'app/(portal)/page.js',
      '/(portal)/invoices/[id]/page': 'app/(portal)/invoices/[id]/page.js',
      '/auth/login/route': 'app/auth/login/route.js',
      '/healthz/route': 'app/healthz/route.js',
    };
    const nextDir = fixtureBuild({ manifest });
    expect(run([nextDir]).status).toBe(0);
    write(path.join(nextDir, 'static/chunks/portal.js'), DEV_MENU_MARKER);
    expect(run([nextDir]).status).toBe(1);
    write(path.join(nextDir, 'static/chunks/portal.js'), 'clean');
    write(
      path.join(nextDir, 'server/app-paths-manifest.json'),
      JSON.stringify({
        ...manifest,
        '/(portal)/dev/personas/page': 'app/(portal)/dev/personas/page.js',
      }),
    );
    expect(run([nextDir]).status).toBe(1);
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

  it('rejects dev tooling bundled into P3 billing output', () => {
    const nextDir = fixtureBuild({
      files: { 'server/app/(app)/invoices/[id]/page.js': DEV_MENU_MARKER },
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

  it('rejects a grouped whoami route alongside all shipped P1-P4 destinations', () => {
    const nextDir = fixtureBuild({
      manifest: {
        ...REAL_BUILD_MANIFEST,
        '/(app)/inbox/page': 'app/(app)/inbox/page.js',
        '/(app)/quotations/page': 'app/(app)/quotations/page.js',
        '/(app)/invoices/page': 'app/(app)/invoices/page.js',
        '/(app)/procurement/orders/page': 'app/(app)/procurement/orders/page.js',
        '/(internal)/dev/api/whoami/route': 'app/(internal)/dev/api/whoami/route.js',
      },
    });
    const result = run([nextDir]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('/(internal)/dev/api/whoami/route');
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

  describe('production profile: the run-time switch', () => {
    it('fails when an executable file still reads process.env.BOS_DEV_TOOLS at run time', () => {
      const nextDir = fixtureBuild({
        files: { 'server/chunks/a.js': 'if(process.env.BOS_DEV_TOOLS==="1")load()' },
      });
      const result = run([nextDir]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('read at run time');
    });

    it('ignores source maps, which carry the original source text', () => {
      const nextDir = fixtureBuild({
        files: { 'server/chunks/a.js.map': '{"sourcesContent":["process.env.BOS_DEV_TOOLS"]}' },
      });
      expect(run([nextDir]).status).toBe(0);
    });
  });

  describe('--profile dev', () => {
    const DEV_MANIFEST = {
      ...REAL_BUILD_MANIFEST,
      '/dev/personas/page': 'app/dev/personas/page.js',
      '/dev/api/whoami/route': 'app/dev/api/whoami/route.js',
    };
    const devBuild = (extra: Record<string, string> = {}): string =>
      fixtureBuild({
        manifest: DEV_MANIFEST,
        files: {
          'server/chunks/personas.js': MARKER,
          'static/chunks/menu.js': DEV_MENU_MARKER,
          ...extra,
        },
      });

    it('passes on a build that carries the dev layer, and the production profile rejects it', () => {
      const nextDir = devBuild();
      const dev = run(['--profile', 'dev', nextDir]);
      expect(dev.stderr).toBe('');
      expect(dev.status).toBe(0);
      expect(run([nextDir]).status).toBe(1);
    }, 30_000);

    it('allows the run-time switch, which a dev build keeps on purpose', () => {
      const nextDir = devBuild({ 'static/chunks/x.js': 'process.env.BOS_DEV_TOOLS' });
      expect(run(['--profile', 'dev', nextDir]).status).toBe(0);
    });

    it('fails when the dev build lost its route or a marker', () => {
      const noRoute = fixtureBuild({
        files: { 'server/chunks/personas.js': MARKER, 'static/chunks/menu.js': DEV_MENU_MARKER },
      });
      const lostRoute = run(['--profile', 'dev', noRoute]);
      expect(lostRoute.status).toBe(1);
      expect(lostRoute.stderr).toContain('missing the /dev/personas route');

      const noMenu = fixtureBuild({
        manifest: DEV_MANIFEST,
        files: { 'server/chunks/personas.js': MARKER },
      });
      const lostMenu = run(['--profile', 'dev', noMenu]);
      expect(lostMenu.status).toBe(1);
      expect(lostMenu.stderr).toContain(DEV_MENU_MARKER);
    });

    it('rejects an unknown profile and exits 2 for a missing build', () => {
      expect(run(['--profile', 'staging', tempRoot()]).status).toBe(2);
      expect(run(['--profile', 'dev', path.join(tempRoot(), 'nope')]).status).toBe(2);
    });
  });
});
