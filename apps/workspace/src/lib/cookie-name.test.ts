import { afterEach, describe, expect, it, vi } from 'vitest';

import { cookieName } from './cookie-name';

vi.mock('server-only', () => ({}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('development cookie namespace', () => {
  it('keeps existing names when no namespace is configured', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('BOS_DEV_COOKIE_NAMESPACE', undefined);
    expect(cookieName('session')).toBe('__Host-bos_session');
    expect(cookieName('login')).toBe('__Host-bos_login');
    expect(cookieName('signed_out')).toBe('__Host-bos_signed_out');
    expect(cookieName('signed_in')).toBe('__Host-bos_signed_in');
  });

  it('uses separate session and login cookies for concurrent development instances', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('BOS_DEV_COOKIE_NAMESPACE', 'p0');
    const p0Session = (await import('./session')).SESSION_COOKIE;
    const p0Login = (await import('./oidc')).LOGIN_COOKIE;
    vi.resetModules();
    vi.stubEnv('BOS_DEV_COOKIE_NAMESPACE', 'p1');
    const p1Session = (await import('./session')).SESSION_COOKIE;
    const p1Login = (await import('./oidc')).LOGIN_COOKIE;
    expect([p0Session, p0Login, p1Session, p1Login]).toEqual([
      '__Host-bos_p0_session',
      '__Host-bos_p0_login',
      '__Host-bos_p1_session',
      '__Host-bos_p1_login',
    ]);
  });

  it.each(['production', 'test'])('ignores overrides in %s', (mode) => {
    vi.stubEnv('NODE_ENV', mode);
    vi.stubEnv('BOS_DEV_COOKIE_NAMESPACE', 'invalid; namespace');
    expect(cookieName('session')).toBe('__Host-bos_session');
    expect(cookieName('login')).toBe('__Host-bos_login');
  });

  it.each(['', 'P0', 'p0; Path=/', 'p0 space', '-p0', 'p'.repeat(33)])(
    'rejects invalid development namespace %j',
    (namespace) => {
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('BOS_DEV_COOKIE_NAMESPACE', namespace);
      expect(() => cookieName('session')).toThrow('BOS_DEV_COOKIE_NAMESPACE');
      expect(() => cookieName('login')).toThrow('BOS_DEV_COOKIE_NAMESPACE');
    },
  );
});
