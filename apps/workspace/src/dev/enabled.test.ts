import { afterEach, describe, expect, it, vi } from 'vitest';

import { devToolsEnabled } from './enabled';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('devToolsEnabled', () => {
  it('is on under next dev', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('BOS_DEV_TOOLS', '0');
    expect(devToolsEnabled()).toBe(true);
  });

  it('is on in a compiled dev build (production NODE_ENV, BOS_DEV_TOOLS inlined as 1)', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('BOS_DEV_TOOLS', '1');
    expect(devToolsEnabled()).toBe(true);
  });

  it('is off in a production build', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('BOS_DEV_TOOLS', '0');
    expect(devToolsEnabled()).toBe(false);
  });

  it('is off when nothing is set', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('BOS_DEV_TOOLS', undefined);
    expect(devToolsEnabled()).toBe(false);
  });
});
