import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Guards the "no way around auth, by construction" rule (P0 plan §4). If this fails, remove the
// offending code; do not add an allowlist entry or weaken a pattern here.

const SELF = resolve(fileURLToPath(import.meta.url));
const AUTH_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)));
const SRC_DIR = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** Markers of a debug identity header or an "auth off" switch, anywhere in apps/api/src. */
const FORBIDDEN_IN_SRC: readonly RegExp[] = [
  /x-dev/i,
  /x-test-user/i,
  /bypass/i,
  /SKIP_AUTH/i,
  /AUTH_DISABLED/i,
];

/** Auth gets its configuration only through AppConfig, so no environment reads in platform/auth. */
const FORBIDDEN_IN_AUTH: readonly RegExp[] = [
  /process\s*\.\s*env/,
  /process\s*\[\s*['"`]env['"`]\s*\]/,
  /from\s+['"](node:)?process['"]/,
];

function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts'))
    .map((name) => resolve(join(dir, name)))
    .filter((file) => file !== SELF);
}

function findMatches(files: readonly string[], patterns: readonly RegExp[]): string[] {
  const hits: string[] = [];
  for (const file of files) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        for (const pattern of patterns) {
          if (pattern.test(line))
            hits.push(`${relative(SRC_DIR, file)}:${index + 1} matches ${pattern}`);
        }
      });
  }
  return hits;
}

describe('no auth escape hatches', () => {
  const srcFiles = tsFilesUnder(SRC_DIR);
  const authFiles = tsFilesUnder(AUTH_DIR);

  it('scans the real source tree', () => {
    // A wrong root would scan nothing and pass. Make sure the auth files are in the scan.
    for (const name of ['auth.guard.ts', 'jwt-verifier.ts', 'claims.ts', 'auth.module.ts']) {
      expect(srcFiles).toContain(join(AUTH_DIR, name));
      expect(authFiles).toContain(join(AUTH_DIR, name));
    }
  });

  it('has no debug identity headers or auth-off switches in apps/api/src', () => {
    expect(findMatches(srcFiles, FORBIDDEN_IN_SRC)).toEqual([]);
  });

  it('never reads the environment in platform/auth', () => {
    expect(findMatches(authFiles, FORBIDDEN_IN_AUTH)).toEqual([]);
  });

  it('would catch an offender (the patterns are not dead)', () => {
    const samples = [
      "req.headers['x-dev-user']",
      "req.header('X-Test-User')",
      'const authBypass = true',
      'if (SKIP_AUTH) return true',
      'AUTH_DISABLED=1',
    ];
    for (const sample of samples) {
      expect(FORBIDDEN_IN_SRC.some((pattern) => pattern.test(sample))).toBe(true);
    }
    const envSamples = [
      'process.env.OIDC_ISSUER',
      "process['env']",
      "import { env } from 'node:process'",
    ];
    for (const sample of envSamples) {
      expect(FORBIDDEN_IN_AUTH.some((pattern) => pattern.test(sample))).toBe(true);
    }
  });
});
