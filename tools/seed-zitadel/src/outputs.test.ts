import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DevDir,
  decodeJwtClaims,
  inspectToken,
  loadtestScope,
  parseEnv,
  renderEnv,
} from './outputs.js';

const jwt = (claims: unknown): string =>
  `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

describe('env files', () => {
  it('round-trips', () => {
    const values = { A: '1', B: 'two=2' };
    expect(parseEnv(renderEnv(values))).toEqual(values);
    expect(parseEnv(undefined)).toEqual({});
  });
});

describe('token inspection (R7)', () => {
  it('rejects opaque tokens', () => {
    expect(() => decodeJwtClaims('opaque-token-value')).toThrow(/not a JWT/);
  });

  it('reports claim keys, audience and the claim families U4 relies on', () => {
    const report = inspectToken(
      jwt({
        sub: 'u',
        aud: ['p1', 'c1'],
        'urn:zitadel:iam:org:project:roles': { sales: { o1: 'd' } },
        'urn:zitadel:iam:user:resourceowner:id': 'o1',
      }),
      'p1',
    );
    expect(report.audienceHasProject).toBe(true);
    expect(report.hasRoleClaim).toBe(true);
    expect(report.hasResourceOwnerClaim).toBe(true);
    expect(report.claimKeys).toContain('sub');
  });

  it('accepts a string aud and detects a missing project', () => {
    expect(inspectToken(jwt({ aud: 'p1' }), 'p1').audienceHasProject).toBe(true);
    expect(inspectToken(jwt({ aud: 'other' }), 'p1').audienceHasProject).toBe(false);
  });

  it('reports the token client as azp, else client_id, like the API verifier', () => {
    expect(inspectToken(jwt({ azp: 'a', client_id: 'c' }), 'p1').clientId).toBe('a');
    expect(inspectToken(jwt({ client_id: 'c' }), 'p1').clientId).toBe('c');
    expect(inspectToken(jwt({ sub: 'u' }), 'p1').clientId).toBeUndefined();
  });

  it('asks for the project audience, roles and resource owner', () => {
    const scope = loadtestScope('p1');
    expect(scope).toContain('urn:zitadel:iam:org:project:id:p1:aud');
    expect(scope).toContain('urn:zitadel:iam:org:projects:roles');
    expect(scope).toContain('urn:zitadel:iam:user:resourceowner');
  });
});

describe('DevDir', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('writes once, reports unchanged on identical content, and locks the mode down', async () => {
    dir = await mkdtemp(join(tmpdir(), 'bos-dev-'));
    const files = new DevDir(dir);

    expect(await files.write('k6.env', 'A=1\n')).toBe(true);
    expect(await files.write('k6.env', 'A=1\n')).toBe(false);
    expect(await files.write('k6.env', 'A=2\n')).toBe(true);
    expect(await readFile(join(dir, 'k6.env'), 'utf8')).toBe('A=2\n');
    expect(await files.read('missing.env')).toBeUndefined();
    // Windows has no POSIX modes; the check matters on the Linux dev machine and in CI.
    if (process.platform !== 'win32') {
      expect((await stat(join(dir, 'k6.env'))).mode & 0o777).toBe(0o600);
    }
  });
});
