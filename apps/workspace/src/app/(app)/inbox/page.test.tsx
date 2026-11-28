import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import InboxPage from './page';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireStaffSession: vi.fn(),
  getInbox: vi.fn(),
  getInboxPage: vi.fn(),
  getNumberSystems: vi.fn(),
}));

vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('@/lib/display-settings', () => ({ getNumberSystems: mocks.getNumberSystems }));
vi.mock('@/lib/api-kernel', async (original) => ({
  ...(await original<typeof import('@/lib/api-kernel')>()),
  getInbox: mocks.getInbox,
  getInboxPage: mocks.getInboxPage,
}));
vi.mock('next/navigation', () => ({
  notFound: vi.fn(),
  redirect: vi.fn(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => '/inbox',
  useSearchParams: () => new URLSearchParams(),
}));

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.requireStaffSession.mockResolvedValue({ accessToken: 'tok', roles: ['approver'] });
  mocks.getNumberSystems.mockResolvedValue('western');
});

describe('inbox page reads', () => {
  it('starts display settings and the whole-inbox summary with the list read, not after it', async () => {
    let finishList: (page: { items: never[]; total: number }) => void = () => undefined;
    mocks.getInboxPage.mockReturnValue(new Promise((resolve) => (finishList = resolve)));
    mocks.getInbox.mockResolvedValue([]);

    const pending = InboxPage({ searchParams: Promise.resolve({}) });
    await tick();
    // The list read has not answered; the other two reads are already out.
    expect(mocks.getInboxPage).toHaveBeenCalledTimes(1);
    expect(mocks.getInbox).toHaveBeenCalledTimes(1);
    expect(mocks.getNumberSystems).toHaveBeenCalledTimes(1);

    finishList({ items: [], total: 0 });
    renderToStaticMarkup(await pending);
  });
});
