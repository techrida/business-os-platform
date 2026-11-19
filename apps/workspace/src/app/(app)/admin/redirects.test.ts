import { describe, expect, it, vi } from 'vitest';

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
    ['./roles/page', '/settings/roles'],
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
