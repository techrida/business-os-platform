import { describe, expect, it } from 'vitest';

import nextConfig from './next.config';

describe('workspace next.config', () => {
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
