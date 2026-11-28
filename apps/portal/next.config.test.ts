import { afterEach, describe, expect, it, vi } from 'vitest';

import nextConfig from './next.config';

describe('portal next.config', () => {
  it('serves images as they are, without the server-side image library', () => {
    expect(nextConfig.images?.unoptimized).toBe(true);
  });

  it('restricts form targets in the Content Security Policy', async () => {
    const rules = await nextConfig.headers!();
    const csp = rules
      .flatMap((rule) => rule.headers)
      .find((header) => header.key === 'Content-Security-Policy')!.value;
    expect(csp).toMatch(/(^|; )form-action 'self' \S+(;|$)/);
  });
});

describe('portal cookie isolation', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it.each([
    ['dev', '__Host-bos_p4testrun_portal'],
    ['production', '__Host-bos_portal'],
  ])('uses the correct cookie prefix for a %s build', async (profile, prefix) => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('BOS_BUILD_PROFILE', profile);
    vi.stubEnv('BOS_DEV_COOKIE_NAMESPACE', 'p4testrun');
    vi.resetModules();
    const config = (await import('./next.config')).default;
    expect(config.env?.BOS_PORTAL_COOKIE_PREFIX).toBe(prefix);
  });
});
