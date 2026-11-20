import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import nextConfig from '../../../../next.config';

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

const target = async (run: () => unknown): Promise<string> => {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : '';
  }
  return '';
};

describe('/admin pages forward to /settings', () => {
  it.each([
    ['./page', '/settings'],
    ['./settings/page', '/settings'],
    ['./users/new/page', '/settings/users/new'],
    ['./departments/page', '/settings/departments'],
    ['./access/page', '/settings/access'],
    ['./roles/page', '/settings/access/roles'],
    ['./workflows/page', '/settings/workflows'],
  ])('%s', async (module, destination) => {
    const { default: page } = (await import(module)) as { default: () => never };
    expect(await target(page)).toBe(`REDIRECT:${destination}`);
  });

  it('keeps the user filters when forwarding the directory', async () => {
    const { default: page } = await import('./users/page');
    const run = (params: Record<string, string | string[]>) =>
      target(() => page({ searchParams: Promise.resolve(params) }));
    expect(await run({})).toBe('REDIRECT:/settings/users');
    expect(await run({ q: 'asha', role: ['finance', 'sales'] })).toBe(
      'REDIRECT:/settings/users?q=asha&role=finance&role=sales',
    );
  });
});

describe('next.config.ts static redirects', () => {
  it('redirects legacy Organisation, Department and roles routes to Settings with temporary (307) status', async () => {
    const redirects = (await nextConfig.redirects?.()) ?? [];
    const bySource = new Map(redirects.map((rule) => [rule.source, rule]));

    expect(bySource.size).toBe(redirects.length);
    for (const rule of redirects) {
      expect(rule.permanent, rule.source).toBe(false);
    }

    const expected: ReadonlyArray<readonly [string, string]> = [
      ['/settings/roles', '/settings/access/roles'],
      ['/settings/organization', '/settings/organisation'],
      ['/organisation', '/settings/organisation'],
      ['/organization', '/settings/organisation'],
      ['/organisation/departments', '/settings/departments'],
      ['/organisation/departments/:path*', '/settings/departments/:path*'],
      ['/organization/departments', '/settings/departments'],
      ['/organization/departments/:path*', '/settings/departments/:path*'],
      ['/organisation/department', '/settings/departments'],
      ['/organization/department', '/settings/departments'],
      ['/organisation/users', '/settings/users'],
      ['/organisation/users/:path*', '/settings/users/:path*'],
      ['/organization/users', '/settings/users'],
      ['/organization/users/:path*', '/settings/users/:path*'],
      ['/organisation/access', '/settings/access'],
      ['/organisation/access/:path*', '/settings/access/:path*'],
      ['/organization/access', '/settings/access'],
      ['/organization/access/:path*', '/settings/access/:path*'],
      ['/organisation/roles', '/settings/access/roles'],
      ['/organization/roles', '/settings/access/roles'],
      ['/organisation/workflows', '/settings/workflows'],
      ['/organization/workflows', '/settings/workflows'],
      ['/department', '/settings/departments'],
      ['/departments', '/settings/departments'],
      ['/departments/:path*', '/settings/departments/:path*'],
    ];

    for (const [source, destination] of expected) {
      expect(bySource.get(source)?.destination, source).toBe(destination);
    }

    // Every non-wildcard destination must resolve to a real page under app/(app).
    const appRoot = join(process.cwd(), 'src', 'app', '(app)');
    for (const rule of redirects) {
      if (rule.destination.includes(':')) continue;
      expect(existsSync(join(appRoot, rule.destination, 'page.tsx')), rule.destination).toBe(true);
    }
  });
});
